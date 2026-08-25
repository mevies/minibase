/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { PGlite } from "@electric-sql/pglite";

interface RpcRequest {
  id: number;
  method: string;
  payload?: Record<string, unknown>;
}

interface DeferredRequest {
  request: RpcRequest;
}

let database: PGlite | null = null;
let activeTransaction: string | null = null;
let executionQueue = Promise.resolve();
const deferred: DeferredRequest[] = [];

self.onmessage = (event: MessageEvent<RpcRequest>) => {
  const request = event.data;
  if (mustDefer(request)) {
    deferred.push({ request });
    return;
  }
  enqueue(request);
};

function mustDefer(request: RpcRequest): boolean {
  if (activeTransaction === null) return false;
  const transactionId = request.payload?.transactionId;
  return transactionId !== activeTransaction && request.method !== "close";
}

function enqueue(request: RpcRequest): void {
  executionQueue = executionQueue.then(async () => {
    if (mustDefer(request)) {
      deferred.push({ request });
      return;
    }
    try {
      const value = await execute(request);
      self.postMessage({ id: request.id, ok: true, value });
    } catch (error) {
      const candidate = error as Error & {
        code?: string;
        position?: string;
      };
      self.postMessage({
        id: request.id,
        ok: false,
        error: {
          name: candidate.name ?? "Error",
          message: candidate.message ?? String(error),
          stack: candidate.stack,
          code: candidate.code,
          position: candidate.position,
        },
      });
    } finally {
      if (activeTransaction === null) flushDeferred();
    }
  });
}

function flushDeferred(): void {
  const next = deferred.shift();
  if (next !== undefined) enqueue(next.request);
}

async function execute(request: RpcRequest): Promise<unknown> {
  const payload = request.payload ?? {};
  switch (request.method) {
    case "start": {
      if (database !== null) return null;
      const dataDir = requiredString(payload.dataDir, "dataDir");
      const instance = new PGlite(dataDir);
      await instance.waitReady;
      database = instance;
      return null;
    }
    case "close":
      await database?.close();
      database = null;
      activeTransaction = null;
      return null;
    case "health": {
      const result = await db().query<{ healthy: number }>("select 1::int as healthy");
      return result.rows[0]?.healthy === 1;
    }
    case "capabilities": {
      const version = await db().query<{ version: string }>("select version() as version");
      return {
        engine: "pglite",
        postgresVersion: version.rows[0]?.version ?? "unknown",
        externalConnections: false,
        extensions: ["plpgsql"],
        concurrentConnections: false,
        logicalReplication: "unavailable",
      };
    }
    case "begin": {
      if (activeTransaction !== null) throw new Error("A PGlite transaction is already active");
      activeTransaction = requiredString(payload.transactionId, "transactionId");
      await db().exec("begin");
      return null;
    }
    case "commit":
      requireTransaction(payload.transactionId);
      await db().exec("commit");
      activeTransaction = null;
      return null;
    case "rollback":
      requireTransaction(payload.transactionId);
      await db().exec("rollback");
      activeTransaction = null;
      return null;
    case "query": {
      validateTransaction(payload.transactionId);
      const sql = requiredString(payload.sql, "sql");
      const params = Array.isArray(payload.params) ? payload.params : [];
      const result = await db().query(sql, params);
      const maxRows = typeof payload.maxRows === "number" ? payload.maxRows : 10_000;
      if (maxRows >= 0 && result.rows.length > maxRows) {
        throw new Error(
          `PGlite query returned ${result.rows.length} rows, exceeding the ${maxRows} row limit`,
        );
      }
      return { rows: result.rows, affectedRows: result.affectedRows ?? null };
    }
    case "exec":
      validateTransaction(payload.transactionId);
      await db().exec(requiredString(payload.sql, "sql"));
      return null;
    default:
      throw new Error(`Unknown PGlite RPC method: ${request.method}`);
  }
}

function db(): PGlite {
  if (database === null) throw new Error("PGlite worker has not been started");
  return database;
}

function validateTransaction(value: unknown): void {
  if (activeTransaction === null) {
    if (value !== undefined) throw new Error("The requested transaction is no longer active");
    return;
  }
  requireTransaction(value);
}

function requireTransaction(value: unknown): void {
  if (typeof value !== "string" || value !== activeTransaction) {
    throw new Error("PGlite RPC transaction ownership mismatch");
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
