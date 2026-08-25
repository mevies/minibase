import { join } from "@std/path";
import type {
  DatabaseCapabilities,
  DatabaseSession,
  QueryOptions,
  QueryResult,
  QueryRow,
  RequestDatabaseContext,
} from "./contract.ts";
import { DatabaseEngineBase } from "./base.ts";
import { effectiveRequestSignal } from "../request/context.ts";

interface RpcRequest {
  id: number;
  method: string;
  payload?: Record<string, unknown>;
}

interface RpcSuccess {
  id: number;
  ok: true;
  value: unknown;
}

interface RpcFailure {
  id: number;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    position?: string;
  };
}

type RpcResponse = RpcSuccess | RpcFailure;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface PGliteEngineOptions {
  queryTimeoutMs?: number;
  maxRows?: number;
  transactionTimeoutMs?: number;
  longTransactionWarningMs?: number;
  onLongTransaction?: (event: PGliteLongTransactionEvent) => void;
}

export interface PGliteLongTransactionEvent {
  event: "database_long_transaction";
  engine: "pglite";
  transactionId: string;
  durationMs: number;
  thresholdMs: number;
}

class WorkerSession implements DatabaseSession {
  constructor(
    private readonly engine: PGliteEngine,
    private readonly transactionId?: string,
  ) {}

  async query<T extends object = QueryRow>(
    sql: string,
    params: unknown[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    return await this.engine.queryInWorker<T>(sql, params, options, this.transactionId);
  }

  async exec(sql: string): Promise<void> {
    await this.engine.execInWorker(sql, this.transactionId);
  }
}

export class PGliteEngine extends DatabaseEngineBase {
  readonly name = "pglite" as const;
  #worker: Worker | null = null;
  #nextRequestId = 1;
  #pending = new Map<number, PendingRequest>();
  #started = false;
  #starting: Promise<void> | null = null;
  #closing = false;
  #transactionQueue: Promise<void> = Promise.resolve();
  #lockFile: Deno.FsFile | null = null;
  readonly #queryTimeoutMs: number;
  readonly #maxRows: number;
  readonly #transactionTimeoutMs: number;
  readonly #longTransactionWarningMs: number;
  readonly #onLongTransaction: (event: PGliteLongTransactionEvent) => void;

  constructor(
    private readonly dataDir: string,
    options: PGliteEngineOptions = {},
  ) {
    super();
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
    this.#maxRows = options.maxRows ?? 10_000;
    this.#transactionTimeoutMs = options.transactionTimeoutMs ?? 30_000;
    this.#longTransactionWarningMs = options.longTransactionWarningMs ?? 5_000;
    this.#onLongTransaction = options.onLongTransaction ?? ((event) => {
      console.warn(JSON.stringify(event));
    });
  }

  async start(): Promise<void> {
    if (this.#started && this.#worker !== null) return;
    if (this.#starting !== null) return await this.#starting;
    this.#starting = this.startWorker();
    try {
      await this.#starting;
      this.#started = true;
    } finally {
      this.#starting = null;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const worker = this.#worker;
    if (worker !== null) {
      try {
        await this.rpc("close", {}, { timeoutMs: 5_000, maxRows: 0 });
      } catch {
        // Termination below is the final cleanup path after a crashed worker.
      }
      worker.terminate();
    }
    this.#worker = null;
    this.#started = false;
    this.#closing = false;
    this.rejectAll(new Error("PGlite engine was closed"));
    await this.releaseProjectLock();
  }

  async health(): Promise<boolean> {
    try {
      await this.ensureStarted();
      return await this.rpc<boolean>("health", {}, { timeoutMs: 2_000, maxRows: 0 });
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<DatabaseCapabilities> {
    await this.ensureStarted();
    return await this.rpc<DatabaseCapabilities>("capabilities", {}, { maxRows: 0 });
  }

  async query<T extends object = QueryRow>(
    sql: string,
    params: unknown[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    return await this.queryInWorker<T>(sql, params, options);
  }

  async exec(sql: string): Promise<void> {
    await this.execInWorker(sql);
  }

  async transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
    const previous = this.#transactionQueue;
    let release!: () => void;
    this.#transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.ensureStarted();
      const transactionId = crypto.randomUUID();
      let warningTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await this.rpc("begin", { transactionId }, { maxRows: 0 });
        const startedAt = performance.now();
        if (this.#longTransactionWarningMs > 0) {
          warningTimer = setTimeout(() => {
            this.#onLongTransaction({
              event: "database_long_transaction",
              engine: "pglite",
              transactionId,
              durationMs: performance.now() - startedAt,
              thresholdMs: this.#longTransactionWarningMs,
            });
          }, this.#longTransactionWarningMs);
        }
        const operation = (async () => {
          const value = await callback(new WorkerSession(this, transactionId));
          await this.rpc("commit", { transactionId }, { maxRows: 0 });
          return value;
        })();
        if (this.#transactionTimeoutMs <= 0) return await operation;
        const timeout = new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            const error = new Error(
              `PGlite transaction timed out after ${this.#transactionTimeoutMs} ms; worker was restarted`,
            );
            this.workerFailed(error);
            reject(error);
          }, this.#transactionTimeoutMs);
        });
        return await Promise.race([operation, timeout]);
      } catch (error) {
        if (!timedOut) {
          try {
            await this.rpc("rollback", { transactionId }, { timeoutMs: 5_000, maxRows: 0 });
          } catch {
            // Preserve the original error; a failed rollback also resets the worker via RPC failure.
          }
        }
        throw error;
      } finally {
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      }
    } finally {
      release();
    }
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

  async queryInWorker<T extends object>(
    sql: string,
    params: unknown[],
    options: QueryOptions,
    transactionId?: string,
  ): Promise<QueryResult<T>> {
    await this.ensureStarted();
    return await this.rpc<QueryResult<T>>(
      "query",
      { sql, params, transactionId },
      options,
    );
  }

  async execInWorker(sql: string, transactionId?: string): Promise<void> {
    await this.ensureStarted();
    await this.rpc("exec", { sql, transactionId }, { maxRows: 0 });
  }

  terminateWorkerForTest(): void {
    this.workerFailed(new Error("PGlite worker was terminated for a crash-detection test"));
  }

  private async ensureStarted(): Promise<void> {
    if (this.#worker === null) {
      await this.start();
    }
  }

  private async startWorker(): Promise<void> {
    await Deno.mkdir(this.dataDir, { recursive: true });
    const acquiredLock = await this.acquireProjectLock();
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./pglite_worker.ts", import.meta.url).href, {
        type: "module",
        name: "minibase-pglite",
      });
      this.#worker = worker;
      worker.onmessage = (event: MessageEvent<RpcResponse>) => this.handleResponse(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.workerFailed(new Error(`PGlite worker crashed: ${event.message}`));
      };
      worker.onmessageerror = () => {
        this.workerFailed(new Error("PGlite worker returned an unreadable RPC message"));
      };
      await this.rpc("start", { dataDir: this.dataDir }, { timeoutMs: 30_000, maxRows: 0 });
    } catch (error) {
      worker?.terminate();
      if (this.#worker === worker) this.#worker = null;
      if (acquiredLock) await this.releaseProjectLock();
      throw error;
    }
  }

  private async acquireProjectLock(): Promise<boolean> {
    if (this.#lockFile !== null) return false;
    const lockPath = join(this.dataDir, ".minibase.lock");
    const file = await Deno.open(lockPath, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    try {
      if (!(await file.tryLock(true))) {
        throw new Error(
          `PGlite data directory is already locked by another Minibase process: ${this.dataDir}`,
        );
      }
      await file.truncate(0);
      await file.write(new TextEncoder().encode(JSON.stringify({ pid: Deno.pid }) + "\n"));
      await file.syncData();
      this.#lockFile = file;
      return true;
    } catch (error) {
      file.close();
      throw error;
    }
  }

  private async releaseProjectLock(): Promise<void> {
    const file = this.#lockFile;
    this.#lockFile = null;
    if (file === null) return;
    try {
      await file.unlock();
    } finally {
      file.close();
    }
  }

  private rpc<T>(
    method: string,
    payload: Record<string, unknown>,
    options: QueryOptions,
  ): Promise<T> {
    options = { ...options, signal: effectiveRequestSignal(options.signal) };
    const worker = this.#worker;
    if (worker === null) {
      return Promise.reject(new Error("PGlite worker is not running"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    const id = this.#nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.#queryTimeoutMs;
    const maxRows = options.maxRows ?? this.#maxRows;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        signal: options.signal,
      };
      if (timeoutMs > 0) {
        pending.timeoutId = setTimeout(() => {
          this.workerFailed(
            new Error(`PGlite ${method} timed out after ${timeoutMs} ms; worker was restarted`),
          );
        }, timeoutMs);
      }
      if (options.signal !== undefined) {
        pending.abortListener = () => {
          this.workerFailed(new DOMException("PGlite query was cancelled", "AbortError"));
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.#pending.set(id, pending);
      const request: RpcRequest = { id, method, payload: { ...payload, maxRows } };
      worker.postMessage(request);
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    this.cleanupPending(pending);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      error.stack = response.error.stack;
      Object.assign(error, {
        code: response.error.code,
        position: response.error.position,
      });
      pending.reject(error);
    }
  }

  private workerFailed(error: Error): void {
    const worker = this.#worker;
    this.#worker = null;
    worker?.terminate();
    this.rejectAll(error);
    if (!this.#closing) {
      this.#started = true;
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }
}
