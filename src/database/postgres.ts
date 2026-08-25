import postgres, { type Sql, type TransactionSql } from "postgres";
import type {
  DatabaseCapabilities,
  DatabaseSession,
  QueryOptions,
  QueryResult,
  QueryRow,
  RequestDatabaseContext,
} from "./contract.ts";
import { DatabaseEngineBase } from "./base.ts";
import { remainingRequestTimeoutMs } from "../request/context.ts";

export interface PostgresEngineOptions {
  min?: number;
  max?: number;
  connectTimeoutMs?: number;
}

const INSTANCE_LOCK_SQL = `select pg_try_advisory_lock(
     hashtextextended(current_database() || ':minibase-instance-owner', 0)
   ) as "locked"`;
const INSTANCE_UNLOCK_SQL = `select pg_advisory_unlock(
     hashtextextended(current_database() || ':minibase-instance-owner', 0)
   )`;
const INSTANCE_OWNERSHIP_CHECK_SQL = `
with lock_key as (
  select hashtextextended(current_database() || ':minibase-instance-owner', 0) as value
)
select exists(
  select 1
  from pg_locks, lock_key
  where locktype = 'advisory'
    and pid = pg_backend_pid()
    and classid = ((value >> 32) & 4294967295)::oid
    and objid = (value & 4294967295)::oid
    and objsubid = 1
    and granted
) as "owned"`;

class PostgresSession implements DatabaseSession {
  constructor(
    private readonly sql: Sql | TransactionSql,
    private readonly transactional = false,
  ) {}

  async query<T extends object = QueryRow>(
    query: string,
    params: unknown[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const statementTimeoutMs = effectiveStatementTimeout(options.timeoutMs);
    if (!this.transactional && statementTimeoutMs !== undefined) {
      return await (this.sql as Sql).begin(async (transaction) => {
        return await new PostgresSession(transaction, true).query<T>(query, params, options);
      }) as QueryResult<T>;
    }
    await this.applyStatementTimeout(statementTimeoutMs);
    const pending = this.sql.unsafe<T[]>(query, params as never[]);
    const cancellation = createCancellation(pending, options.signal);
    try {
      const rows = await pending;
      const maximum = options.maxRows ?? 10_000;
      if (maximum >= 0 && rows.length > maximum) {
        throw new Error(`PostgreSQL query returned ${rows.length} rows, exceeding ${maximum}`);
      }
      return {
        rows: [...rows] as T[],
        affectedRows: typeof rows.count === "number" ? rows.count : null,
      };
    } finally {
      cancellation();
    }
  }

  async exec(query: string): Promise<void> {
    const statementTimeoutMs = effectiveStatementTimeout();
    if (!this.transactional && statementTimeoutMs !== undefined) {
      await (this.sql as Sql).begin(async (transaction) => {
        await new PostgresSession(transaction, true).exec(query);
      });
      return;
    }
    await this.applyStatementTimeout(statementTimeoutMs);
    const pending = this.sql.unsafe(query);
    const cancellation = createCancellation(pending);
    try {
      await pending;
    } finally {
      cancellation();
    }
  }

  private async applyStatementTimeout(timeoutMs: number | undefined): Promise<void> {
    if (timeoutMs === undefined) return;
    await this.sql.unsafe(
      "select set_config('statement_timeout', $1, true)",
      [String(Math.max(1, Math.ceil(timeoutMs)))] as never[],
    );
  }
}

export class PostgresEngine extends DatabaseEngineBase {
  readonly name = "postgres" as const;
  #sql: Sql | null = null;
  #instanceOwnership: Sql | null = null;
  #ownershipFailure: Error | null = null;
  #ownershipHeartbeat: ReturnType<typeof setInterval> | null = null;
  #ownershipCheckRunning = false;
  #closing = false;

  constructor(
    private readonly connectionUrl: string,
    private readonly options: PostgresEngineOptions = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.#sql !== null) return;
    this.#closing = false;
    this.#ownershipFailure = null;
    const sql = postgres(this.connectionUrl, {
      max: this.options.max ?? 20,
      connect_timeout: Math.ceil((this.options.connectTimeoutMs ?? 10_000) / 1_000),
      idle_timeout: 30,
      max_lifetime: 60 * 30,
      connection: { application_name: "minibase" },
      onnotice: () => {},
    });
    this.#sql = sql;
    try {
      await sql`select 1`;
      await warmMinimumConnections(sql, this.options.min ?? 1, this.options.max ?? 20);
    } catch (error) {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      this.#sql = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#ownershipHeartbeat !== null) clearInterval(this.#ownershipHeartbeat);
    this.#ownershipHeartbeat = null;
    const ownership = this.#instanceOwnership;
    this.#instanceOwnership = null;
    if (ownership !== null) {
      try {
        await ownership.unsafe(INSTANCE_UNLOCK_SQL);
      } catch {
        // Closing the control connection below also releases its session advisory locks.
      }
      await ownership.end({ timeout: 5 }).catch(() => undefined);
    }
    const sql = this.#sql;
    this.#sql = null;
    await sql?.end({ timeout: 5 });
    this.#ownershipFailure = null;
    this.#ownershipCheckRunning = false;
  }

  async acquireInstanceOwnership(): Promise<void> {
    if (this.#instanceOwnership !== null) return;
    if (this.#ownershipFailure !== null) throw this.#ownershipFailure;
    this.sql();
    const ownership = postgres(this.connectionUrl, {
      max: 1,
      connect_timeout: Math.ceil((this.options.connectTimeoutMs ?? 10_000) / 1_000),
      idle_timeout: 0,
      max_lifetime: null,
      connection: { application_name: "minibase-ownership" },
      onnotice: () => {},
    });
    try {
      const result = await ownership.unsafe<Array<{ locked: boolean }>>(INSTANCE_LOCK_SQL);
      if (result[0]?.locked !== true) {
        throw new Error(
          "Another Minibase instance already owns this PostgreSQL database; " +
            "stop it before starting a second writer",
        );
      }
      this.#instanceOwnership = ownership;
      this.#ownershipFailure = null;
      this.#ownershipHeartbeat = setInterval(
        () => void this.verifyInstanceOwnership(),
        1_000,
      );
    } catch (error) {
      await ownership.end({ timeout: 1 }).catch(() => undefined);
      throw error;
    }
  }

  async health(): Promise<boolean> {
    try {
      const result = await this.query<{ healthy: number }>("select 1::int as healthy");
      return result.rows[0]?.healthy === 1;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<DatabaseCapabilities> {
    const version = await this.query<{ version: string }>("select version() as version");
    const extensions = await this.query<{ name: string }>(
      "select name from pg_available_extensions order by name",
      [],
      { maxRows: 10_000 },
    );
    return {
      engine: this.name,
      postgresVersion: version.rows[0]?.version ?? "unknown",
      externalConnections: true,
      extensions: extensions.rows.map((row) => row.name),
      concurrentConnections: true,
      logicalReplication: "configurable",
    };
  }

  async query<T extends object = QueryRow>(
    query: string,
    params: unknown[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    this.assertInstanceOwnership();
    return await this.session().query<T>(query, params, options);
  }

  async exec(query: string): Promise<void> {
    this.assertInstanceOwnership();
    await this.session().exec(query);
  }

  async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
    this.assertInstanceOwnership();
    return await this.sql().begin(async (transaction) => {
      return await callback(new PostgresSession(transaction, true));
    }) as T;
  }

  async withRequestContext<T>(
    context: RequestDatabaseContext,
    callback: (session: DatabaseSession) => Promise<T>,
  ): Promise<T> {
    if (!["anon", "authenticated", "service_role"].includes(context.role)) {
      throw new Error(`Unsupported database role: ${context.role}`);
    }
    return await this.transaction(async (session) => {
      await session.query(
        "select set_config('request.jwt.claims', $1, true), " +
          "set_config('request.jwt.claim.sub', $2, true), " +
          "set_config('request.jwt.claim.role', $3, true), " +
          "set_config('role', $4, true)",
        [
          JSON.stringify(context.claims),
          typeof context.claims.sub === "string" ? context.claims.sub : "",
          context.role,
          context.role,
        ],
      );
      return await callback(session);
    });
  }

  private sql(): Sql {
    if (this.#sql === null) throw new Error("PostgreSQL engine has not been started");
    return this.#sql;
  }

  private session(): DatabaseSession {
    return new PostgresSession(this.sql());
  }

  private assertInstanceOwnership(): void {
    if (this.#ownershipFailure !== null) throw this.#ownershipFailure;
  }

  private async verifyInstanceOwnership(): Promise<void> {
    const ownership = this.#instanceOwnership;
    if (
      this.#closing || this.#ownershipCheckRunning || this.#ownershipFailure !== null ||
      ownership === null
    ) return;
    this.#ownershipCheckRunning = true;
    try {
      const result = await ownership.unsafe<Array<{ owned: boolean }>>(
        INSTANCE_OWNERSHIP_CHECK_SQL,
      );
      if (result[0]?.owned !== true) {
        throw new Error("PostgreSQL advisory lock is no longer held by its original session");
      }
    } catch (error) {
      if (!this.#closing) {
        this.#ownershipFailure = new Error(
          "PostgreSQL instance ownership was lost; restart Minibase before writing again",
          { cause: error },
        );
        if (this.#ownershipHeartbeat !== null) clearInterval(this.#ownershipHeartbeat);
        this.#ownershipHeartbeat = null;
        if (this.#instanceOwnership === ownership) this.#instanceOwnership = null;
        await ownership.end({ timeout: 1 }).catch(() => undefined);
      }
    } finally {
      this.#ownershipCheckRunning = false;
    }
  }
}

async function warmMinimumConnections(sql: Sql, minimum: number, maximum: number): Promise<void> {
  const count = Math.min(Math.max(0, minimum), maximum);
  if (count === 0) return;
  const reservations = await Promise.all(
    Array.from({ length: count }, () => sql.reserve()),
  );
  try {
    await Promise.all(reservations.map((reservation) => reservation`select 1`));
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.release()));
  }
}

function createCancellation(
  query: { cancel(): unknown },
  signal?: AbortSignal,
): () => void {
  const abort = () => {
    const cancellation = query.cancel();
    if (cancellation instanceof Promise) void cancellation.catch(() => undefined);
  };
  if (Deno.build.os !== "windows") {
    signal?.addEventListener("abort", abort, { once: true });
  }
  return () => {
    signal?.removeEventListener("abort", abort);
  };
}

function effectiveStatementTimeout(explicit?: number): number | undefined {
  const ambient = remainingRequestTimeoutMs();
  if (ambient !== undefined && ambient <= 0) {
    throw new DOMException("Request timed out before the PostgreSQL query started", "TimeoutError");
  }
  const candidates = [explicit, ambient].filter((value): value is number =>
    value !== undefined && value > 0
  );
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
