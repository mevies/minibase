import { fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { getServers } from "node:dns";
import type { MinibaseConfig } from "../config/types.ts";
import { forwardedFunctionHostEnvironment } from "./environment.ts";
import { buildRuntimeNetworkPolicy, runtimeNetworkPermission } from "./network_policy.ts";
import { functionDenoExecutable, functionWorkerEntrypoint } from "./deno_runtime.ts";

interface FunctionWorker {
  name: string;
  port: number;
  process: Deno.ChildProcess;
  outputTask: Promise<void>;
  errorTask: Promise<void>;
  lastUsedAt: number;
  activeRequests: number;
  stopping?: Promise<void>;
}

interface FunctionPoolWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface FunctionPool {
  name: string;
  files: ResolvedFunctionFiles;
  dependencyFiles: string[];
  fingerprint: string;
  workers: Set<FunctionWorker>;
  starting: Set<Promise<FunctionWorker>>;
  activeRequests: number;
  waiters: FunctionPoolWaiter[];
  closed: boolean;
  disposing?: Promise<void>;
}

export interface ResolvedFunctionFiles {
  functionDir: string;
  entryPath: string;
  importMap?: string;
  denoConfig?: string;
  lockFile?: string;
}

export interface FunctionRuntimeSecrets {
  anonKey: string;
  serviceRoleKey: string;
  jwks?: string;
}

export interface FunctionManagerOptions {
  config: MinibaseConfig;
  secrets: FunctionRuntimeSecrets;
  environment?: Record<string, string>;
  secretValues?: string[];
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  concurrencyPerFunction?: number;
  workersPerFunction?: number;
  idleTimeoutMs?: number;
  hotReload?: boolean;
  log?: (stream: "stdout" | "stderr", line: string) => void;
  onStartupMetric?: (metric: FunctionStartupMetric) => void;
}

export interface FunctionStartupMetric {
  phase: "dependency_cache" | "type_check" | "worker_ready";
  durationMs: number;
  functionName?: string;
}

export interface FunctionCacheResult {
  name: string;
  entryPath: string;
  cached: boolean;
}

export type FunctionApiKeyMode = "publishable" | "secret";

function validFunctionName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function allocatePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  listener.close();
  return address.port;
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pending += value;
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        onLine(line);
      }
    }
    if (pending.length > 0) {
      onLine(pending);
    }
  } finally {
    reader.releaseLock();
  }
}

export class FunctionManager {
  readonly #pools = new Map<string, FunctionPool>();
  readonly #resolving = new Map<string, Promise<FunctionPool>>();
  readonly #startingProcesses = new Set<Deno.ChildProcess>();
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #concurrencyPerFunction: number;
  readonly #workersPerFunction: number;
  readonly #idleTimeoutMs: number;
  readonly #hotReload: boolean;
  readonly #redactions: string[];
  readonly #reaper: ReturnType<typeof setInterval>;
  #preparedFunctionNames: string[] | null = null;
  #closed = false;

  constructor(private readonly options: FunctionManagerOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#maxRequestBytes = options.maxRequestBytes ?? 10 * 1024 * 1024;
    this.#concurrencyPerFunction = options.concurrencyPerFunction ?? 16;
    this.#workersPerFunction = options.workersPerFunction ??
      options.config.functions.runtime.workersPerFunction;
    if (
      !Number.isInteger(this.#workersPerFunction) || this.#workersPerFunction < 1 ||
      this.#workersPerFunction > 16
    ) {
      throw new Error("Function workers per function must be an integer between 1 and 16");
    }
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.#hotReload = options.hotReload ?? true;
    this.#redactions = sensitiveValues(options);
    this.#reaper = setInterval(
      () => void this.reapIdleWorkers(),
      Math.min(5_000, this.#idleTimeoutMs),
    );
  }

  async prepare(): Promise<FunctionCacheResult[]> {
    if (this.#closed) throw new Error("Function manager is closed");
    const startedAt = performance.now();
    const result = await cacheFunctionDependencies(this.options.config);
    this.recordStartupMetric({
      phase: "dependency_cache",
      durationMs: performance.now() - startedAt,
    });
    this.#preparedFunctionNames = result.map((entry) => entry.name);
    return result;
  }

  async health(): Promise<boolean> {
    if (this.#closed || this.#preparedFunctionNames === null) return false;
    try {
      const currentNames = await discoverFunctionNames(
        this.options.config,
      );
      return await functionEntrypointsComplete(this.options.config) &&
        currentNames.length === this.#preparedFunctionNames.length &&
        currentNames.every((name, index) => name === this.#preparedFunctionNames![index]);
    } catch {
      return false;
    }
  }

  async invoke(
    name: string,
    request: Request,
    apiKeyMode?: FunctionApiKeyMode,
  ): Promise<Response> {
    if (!validFunctionName(name)) {
      return Response.json({ code: "invalid_function_name" }, { status: 400 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > this.#maxRequestBytes) {
      return Response.json(
        {
          code: "request_too_large",
          message: `Function body exceeds ${this.#maxRequestBytes} bytes`,
        },
        { status: 413 },
      );
    }
    const { pool, worker } = await this.acquireWorker(name);
    const startedAt = performance.now();
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const incoming = new URL(request.url);
    const target = new URL(request.url);
    target.protocol = "http:";
    target.hostname = "127.0.0.1";
    target.port = String(worker.port);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    if (apiKeyMode !== undefined) {
      const injectServiceRoleKey =
        this.options.config.functions.definitions[name]?.injectServiceRoleKey !== false;
      headers.set(
        "apikey",
        apiKeyMode === "secret" && injectServiceRoleKey
          ? this.options.secrets.serviceRoleKey
          : this.options.secrets.anonKey,
      );
    }
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    try {
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD"
          ? undefined
          : limitBody(request.body, this.#maxRequestBytes),
        redirect: "manual",
        signal,
      });
      const finish = () => {
        this.release(pool, worker);
        this.logRequest(name, requestId, response.status, performance.now() - startedAt);
      };
      if (response.body === null) {
        finish();
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return new Response(observeBody(response.body, finish), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const timedOut = timeout.aborted;
      this.release(pool, worker);
      const message = errorChainMessage(error);
      if (message.includes("request body exceeds")) {
        this.logRequest(name, requestId, 413, performance.now() - startedAt);
        return Response.json({ code: "request_too_large", message }, { status: 413 });
      }
      this.logRequest(name, requestId, 502, performance.now() - startedAt);
      await this.removeWorker(pool, worker);
      if (timedOut) {
        throw new Error(`Function ${name} exceeded its ${this.#requestTimeoutMs} ms timeout`);
      }
      throw error;
    }
  }

  workerCountForTest(): number {
    return [...this.#pools.values()].reduce((count, pool) => count + pool.workers.size, 0);
  }

  startingWorkerCountForTest(): number {
    return this.#startingProcesses.size;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#reaper);
    for (const process of this.#startingProcesses) this.killProcess(process, "SIGKILL");
    const pools = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.all(pools.map((pool) => this.disposePool(pool)));
    await Promise.allSettled([...this.#resolving.values()]);
  }

  private async acquireWorker(
    name: string,
  ): Promise<{ pool: FunctionPool; worker: FunctionWorker }> {
    while (true) {
      const pool = await this.pool(name);
      await this.acquire(pool);
      if (pool.closed || this.#pools.get(name) !== pool) {
        this.release(pool);
        if (this.#closed) throw new Error("Function manager is closed");
        continue;
      }
      let worker: FunctionWorker | undefined;
      try {
        worker = await this.selectWorker(pool);
        if (pool.closed || worker.stopping !== undefined || this.#pools.get(name) !== pool) {
          throw new Error(`Function pool ${name} changed while acquiring a worker`);
        }
        return { pool, worker };
      } catch (error) {
        this.release(pool, worker);
        if (pool.closed && !this.#closed) continue;
        throw error;
      }
    }
  }

  private async pool(name: string): Promise<FunctionPool> {
    if (this.#closed) throw new Error("Function manager is closed");
    const existing = this.#pools.get(name);
    if (existing !== undefined) {
      if (
        !this.#hotReload || existing.activeRequests > 0 || existing.starting.size > 0
      ) {
        return existing;
      }
    }
    const resolving = this.#resolving.get(name);
    if (resolving !== undefined) return await resolving;
    const promise = this.resolvePool(name);
    this.#resolving.set(name, promise);
    try {
      const pool = await promise;
      if (this.#closed) {
        await this.disposePool(pool);
        throw new Error("Function manager is closed");
      }
      this.#pools.set(name, pool);
      return pool;
    } finally {
      if (this.#resolving.get(name) === promise) this.#resolving.delete(name);
    }
  }

  private async resolvePool(name: string): Promise<FunctionPool> {
    const existing = this.#pools.get(name);
    if (existing !== undefined) {
      const fingerprint = await functionDependencyFingerprint(existing.dependencyFiles);
      if (fingerprint === existing.fingerprint) return existing;
      if (this.#pools.get(name) === existing) this.#pools.delete(name);
      await this.disposePool(existing);
      await cacheFunctionDependencies(this.options.config, [name]);
    }
    return await this.createPool(name);
  }

  private async createPool(name: string): Promise<FunctionPool> {
    const files = await resolveFunctionFiles(this.options.config, name);
    const { entryPath, functionDir } = files;
    try {
      if (!(await Deno.stat(entryPath)).isFile) {
        throw new Error(`Edge Function entrypoint is not a file: ${entryPath}`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (await isDirectory(functionDir)) {
        throw new Error(`Edge Function entrypoint is missing: ${entryPath}`);
      }
      throw new Error(`Edge Function directory is missing: ${functionDir}`);
    }

    const typeCheckStartedAt = performance.now();
    await checkFunctionEntrypoint(this.options.config, name, entryPath, this.#redactions);
    const dependencyFiles = await resolveFunctionDependencyFiles(
      this.options.config,
      name,
      files,
      this.#redactions,
    );
    this.recordStartupMetric({
      phase: "type_check",
      functionName: name,
      durationMs: performance.now() - typeCheckStartedAt,
    });

    const worker = await this.startWorker(name, files);
    try {
      return {
        name,
        files,
        dependencyFiles,
        fingerprint: await functionDependencyFingerprint(dependencyFiles),
        workers: new Set([worker]),
        starting: new Set(),
        activeRequests: 0,
        waiters: [],
        closed: false,
      };
    } catch (error) {
      await this.stopWorker(worker);
      throw error;
    }
  }

  private async startWorker(
    name: string,
    files: ResolvedFunctionFiles,
  ): Promise<FunctionWorker> {
    const { entryPath } = files;
    const port = allocatePort();
    const wrapperPath = await functionWorkerEntrypoint();
    const networkPolicy = buildRuntimeNetworkPolicy(this.options.config, name);
    const runtimeEnvironment = this.runtimeEnvironment(name, port, networkPolicy);
    const runtimeArgs = [
      "run",
      "--unstable-no-legacy-abort",
      "--no-prompt",
      "--cached-only",
      "--allow-import",
      ...await denoProjectFlags(this.options.config, name),
      this.runtimeReadPermission(),
      "--allow-env",
      runtimeNetworkPermission(networkPolicy, port, getServers()),
      wrapperPath,
      entryPath,
    ];
    const command = new Deno.Command(await functionDenoExecutable(), {
      args: runtimeArgs,
      env: runtimeEnvironment,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const workerReadyStartedAt = performance.now();
    const process = command.spawn();
    this.#startingProcesses.add(process);
    const ready = Promise.withResolvers<void>();
    const outputTask = consumeLines(process.stdout, (line) => {
      if (line === `MINIBASE_FUNCTION_READY:${port}`) {
        ready.resolve();
      } else if (line.length > 0) {
        this.writeLog(
          "stdout",
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            module: "functions",
            source: "function",
            function: name,
            stream: "stdout",
            line,
          }),
        );
      }
    });
    const startupErrorHead: string[] = [];
    const startupErrorTail: string[] = [];
    const errorTask = consumeLines(process.stderr, (line) => {
      if (line.length > 0) {
        const sanitized = redact(line, this.#redactions);
        if (startupErrorHead.length < 2) startupErrorHead.push(sanitized);
        else {
          startupErrorTail.push(sanitized);
          if (startupErrorTail.length > 4) startupErrorTail.shift();
        }
        this.writeLog(
          "stderr",
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            module: "functions",
            source: "function",
            function: name,
            stream: "stderr",
            line,
          }),
        );
      }
    });
    const outcome = await Promise.race([
      ready.promise.then(() => ({ ready: true as const })),
      process.status.then((status) => ({ ready: false as const, status })),
      new Promise<{ ready: false; status: Deno.CommandStatus }>((resolve) =>
        setTimeout(() =>
          resolve({
            ready: false,
            status: { success: false, code: 124, signal: null },
          }), 30_000)
      ),
    ]).finally(() => this.#startingProcesses.delete(process));
    if (!outcome.ready) {
      try {
        process.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await Promise.allSettled([process.status, outputTask, errorTask]);
      const detail = [...startupErrorHead, ...startupErrorTail].join(" | ");
      throw new Error(
        `Function ${name} exited before becoming ready with code ${outcome.status.code}` +
          (detail.length === 0 ? "" : `: ${detail}`),
      );
    }
    this.recordStartupMetric({
      phase: "worker_ready",
      functionName: name,
      durationMs: performance.now() - workerReadyStartedAt,
    });
    return {
      name,
      port,
      process,
      outputTask,
      errorTask,
      lastUsedAt: Date.now(),
      activeRequests: 0,
    };
  }

  private runtimeEnvironment(
    name: string,
    port: number,
    networkPolicy: ReturnType<typeof buildRuntimeNetworkPolicy>,
  ): Record<string, string> {
    const hostEnvironment = forwardedFunctionHostEnvironment();
    const environment = { ...hostEnvironment, ...this.options.environment };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("MINIBASE_")) delete environment[key];
    }
    for (
      const key of [
        "DENO_DIR",
        "DENO_NO_UPDATE_CHECK",
        "NO_COLOR",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_PUBLISHABLE_KEYS",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "SUPABASE_SECRET_KEYS",
        "SUPABASE_JWKS",
        "SUPABASE_JWKS_URL",
        "SUPABASE_URL",
      ]
    ) {
      delete environment[key];
    }
    Object.assign(environment, {
      DENO_DIR: join(this.options.config.project.cacheDir, "deno"),
      DENO_NO_UPDATE_CHECK: "1",
      MINIBASE_FUNCTION_NETWORK_POLICY: JSON.stringify(networkPolicy),
      MINIBASE_FUNCTION_PORT: String(port),
      NO_COLOR: "1",
      SUPABASE_ANON_KEY: this.options.secrets.anonKey,
      SUPABASE_PUBLISHABLE_KEY: this.options.secrets.anonKey,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: this.options.secrets.anonKey }),
      SUPABASE_URL: this.options.config.server.publicUrl,
    });
    if (this.options.secrets.jwks !== undefined) {
      environment.SUPABASE_JWKS = this.options.secrets.jwks;
    }
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
      if (hostEnvironment[key] !== undefined) environment[key] = hostEnvironment[key];
    }
    if (this.options.config.functions.definitions[name]?.injectServiceRoleKey !== false) {
      environment.SUPABASE_SERVICE_ROLE_KEY = this.options.secrets.serviceRoleKey;
      environment.SUPABASE_SECRET_KEY = this.options.secrets.serviceRoleKey;
      environment.SUPABASE_SECRET_KEYS = JSON.stringify({
        default: this.options.secrets.serviceRoleKey,
      });
    }
    return environment;
  }

  private runtimeReadPermission(): string {
    const paths = [
      this.options.config.project.supabaseDir,
      this.options.config.project.cacheDir,
    ];
    const environment = {
      ...forwardedFunctionHostEnvironment(),
      ...this.options.environment,
    };
    for (const name of ["DENO_CERT", "SSL_CERT_FILE"]) {
      const path = environment[name];
      if (path !== undefined && path.length > 0) paths.push(path);
    }
    const certificateDirectories = environment.SSL_CERT_DIR;
    if (certificateDirectories !== undefined) {
      paths.push(
        ...certificateDirectories.split(Deno.build.os === "windows" ? ";" : ":").filter(
          (path) => path.length > 0,
        ),
      );
    }
    return `--allow-read=${[...new Set(paths)].join(",")}`;
  }

  private async selectWorker(pool: FunctionPool): Promise<FunctionWorker> {
    let workers = this.liveWorkers(pool);
    if (workers.length === 0) return this.reserveWorker(await this.startPoolWorker(pool));

    if (workers.every((worker) => worker.activeRequests > 0)) {
      if (workers.length + pool.starting.size < this.#workersPerFunction) {
        const fingerprint = await functionDependencyFingerprint(pool.dependencyFiles);
        if (fingerprint === pool.fingerprint) {
          try {
            return this.reserveWorker(await this.startPoolWorker(pool));
          } catch {
            workers = this.liveWorkers(pool);
            if (workers.length === 0) throw new Error(`Function pool ${pool.name} is unavailable`);
          }
        }
      } else if (pool.starting.size > 0) {
        try {
          await Promise.race(pool.starting);
        } catch {
          // An existing process can still serve this request when scale-out fails.
        }
        workers = this.liveWorkers(pool);
        if (workers.length === 0) throw new Error(`Function pool ${pool.name} is unavailable`);
      }
    }

    return this.reserveWorker(
      workers.reduce((selected, candidate) =>
        candidate.activeRequests < selected.activeRequests ? candidate : selected
      ),
    );
  }

  private reserveWorker(worker: FunctionWorker): FunctionWorker {
    worker.activeRequests++;
    worker.lastUsedAt = Date.now();
    return worker;
  }

  private async startPoolWorker(pool: FunctionPool): Promise<FunctionWorker> {
    if (pool.closed || this.#closed) throw new Error(`Function pool ${pool.name} is closed`);
    if (pool.workers.size + pool.starting.size >= this.#workersPerFunction) {
      if (pool.starting.size > 0) await Promise.race(pool.starting);
      const worker = this.liveWorkers(pool).reduce<FunctionWorker | undefined>(
        (selected, candidate) =>
          selected === undefined || candidate.activeRequests < selected.activeRequests
            ? candidate
            : selected,
        undefined,
      );
      if (worker !== undefined) return worker;
      throw new Error(`Function pool ${pool.name} is unavailable`);
    }

    const promise = this.startWorker(pool.name, pool.files);
    pool.starting.add(promise);
    try {
      const worker = await promise;
      if (pool.closed || this.#closed || this.#pools.get(pool.name) !== pool) {
        await this.stopWorker(worker);
        throw new Error(`Function pool ${pool.name} changed while starting a worker`);
      }
      pool.workers.add(worker);
      return worker;
    } finally {
      pool.starting.delete(promise);
    }
  }

  private liveWorkers(pool: FunctionPool): FunctionWorker[] {
    return [...pool.workers].filter((worker) => worker.stopping === undefined);
  }

  private async acquire(pool: FunctionPool): Promise<void> {
    if (pool.closed || this.#closed) throw new Error(`Function pool ${pool.name} is closed`);
    if (pool.activeRequests < this.#concurrencyPerFunction && pool.waiters.length === 0) {
      pool.activeRequests++;
      return;
    }
    await new Promise<void>((resolve, reject) => pool.waiters.push({ resolve, reject }));
  }

  private release(pool: FunctionPool, worker?: FunctionWorker): void {
    if (worker !== undefined) {
      worker.activeRequests = Math.max(0, worker.activeRequests - 1);
      worker.lastUsedAt = Date.now();
    }
    const waiter = pool.closed ? undefined : pool.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve();
    } else {
      pool.activeRequests = Math.max(0, pool.activeRequests - 1);
    }
  }

  private async removeWorker(pool: FunctionPool, worker: FunctionWorker): Promise<void> {
    pool.workers.delete(worker);
    await this.stopWorker(worker);
    if (
      !pool.closed && pool.workers.size === 0 && pool.starting.size === 0 &&
      pool.activeRequests === 0 && this.#pools.get(pool.name) === pool
    ) {
      this.#pools.delete(pool.name);
      await this.disposePool(pool);
    }
  }

  private async reapIdleWorkers(): Promise<void> {
    const now = Date.now();
    const idle = [...this.#pools.entries()].filter(([, pool]) =>
      pool.activeRequests === 0 && pool.starting.size === 0 &&
      [...pool.workers].every((worker) => now - worker.lastUsedAt >= this.#idleTimeoutMs)
    );
    await Promise.all(idle.map(async ([name, pool]) => {
      if (this.#pools.get(name) !== pool) return;
      this.#pools.delete(name);
      await this.disposePool(pool);
    }));
  }

  private async disposePool(pool: FunctionPool): Promise<void> {
    if (pool.disposing !== undefined) return await pool.disposing;
    pool.closed = true;
    const error = new Error(`Function pool ${pool.name} is closed`);
    for (const waiter of pool.waiters.splice(0)) waiter.reject(error);
    const workers = [...pool.workers];
    pool.workers.clear();
    const promise = (async () => {
      await Promise.all(workers.map((worker) => this.stopWorker(worker)));
      await Promise.allSettled([...pool.starting]);
    })();
    pool.disposing = promise;
    await promise;
  }

  private async stopWorker(worker: FunctionWorker): Promise<void> {
    if (worker.stopping !== undefined) return await worker.stopping;
    const promise = (async () => {
      this.killProcess(worker.process);
      await worker.process.status.catch(() => undefined);
      await Promise.allSettled([worker.outputTask, worker.errorTask]);
    })();
    worker.stopping = promise;
    await promise;
  }

  private killProcess(process: Deno.ChildProcess, signal: Deno.Signal = "SIGTERM"): void {
    try {
      process.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }

  private logRequest(name: string, requestId: string, status: number, durationMs: number): void {
    this.writeLog(
      "stdout",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        module: "functions",
        function: name,
        requestId,
        status,
        durationMs: Number(durationMs.toFixed(2)),
      }),
    );
  }

  private writeLog(stream: "stdout" | "stderr", line: string): void {
    const sanitized = redact(line, this.#redactions);
    if (this.options.log !== undefined) {
      this.options.log(stream, sanitized);
    } else if (stream === "stdout") {
      console.log(sanitized);
    } else {
      console.error(sanitized);
    }
  }

  private recordStartupMetric(metric: FunctionStartupMetric): void {
    this.options.onStartupMetric?.({
      ...metric,
      durationMs: Number(metric.durationMs.toFixed(2)),
    });
  }
}

async function checkFunctionEntrypoint(
  config: MinibaseConfig,
  name: string,
  entryPath: string,
  redactions: string[],
): Promise<void> {
  const checkerSource = [
    `import type * as CheckedEntry from ${JSON.stringify(toFileUrl(entryPath).href)};`,
    "type CheckedModule = typeof CheckedEntry;",
    "const checked: CheckedModule | undefined = undefined;",
    "void checked;",
  ].join("\n");
  const checkerUrl = `data:text/typescript,${encodeURIComponent(checkerSource)}`;
  const result = await new Deno.Command(await functionDenoExecutable(), {
    args: [
      "run",
      "--check",
      "--quiet",
      "--no-prompt",
      "--cached-only",
      "--allow-import",
      ...await denoProjectFlags(config, name),
      checkerUrl,
    ],
    env: {
      ...forwardedFunctionHostEnvironment(),
      DENO_DIR: join(config.project.cacheDir, "deno"),
      DENO_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) return;
  const decoder = new TextDecoder();
  const detail = [decoder.decode(result.stderr), decoder.decode(result.stdout)]
    .map((output) => output.trim())
    .filter((output) => output.length > 0)
    .join("\n");
  throw new Error(
    `Function type check failed for ${entryPath}` +
      (detail.length === 0 ? "" : `:\n${redact(stripAnsi(detail), redactions)}`),
  );
}

function stripAnsi(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index++;
      }
      continue;
    }
    result += value[index];
  }
  return result;
}

function sensitiveValues(options: FunctionManagerOptions): string[] {
  const values = [
    options.secrets.anonKey,
    options.secrets.serviceRoleKey,
    ...(options.secretValues ?? []),
  ];
  for (const [name, value] of Object.entries(options.environment ?? {})) {
    if (/(?:secret|token|key|password|credential|authorization|auth|proxy)/iu.test(name)) {
      values.push(value);
    }
  }
  return [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

function redact(line: string, secrets: string[]): string {
  let result = line;
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

export async function cacheFunctionDependencies(
  config: MinibaseConfig,
  onlyNames?: string[],
): Promise<FunctionCacheResult[]> {
  const names = onlyNames ?? await discoverFunctionNames(config);
  if (names.length === 0) return [];
  await Deno.mkdir(join(config.project.cacheDir, "deno"), { recursive: true });
  const results: FunctionCacheResult[] = [];
  for (const name of names) {
    const files = await resolveFunctionFiles(config, name);
    const result = await new Deno.Command(await functionDenoExecutable(), {
      args: [
        "cache",
        "--quiet",
        "--allow-import",
        ...await denoProjectFlags(config, name),
        files.entryPath,
      ],
      env: { DENO_DIR: join(config.project.cacheDir, "deno"), DENO_NO_UPDATE_CHECK: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `Function dependency cache failed for ${name}: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
    }
    results.push({ name, entryPath: files.entryPath, cached: true });
  }
  return results;
}

export async function functionDependenciesCached(config: MinibaseConfig): Promise<boolean> {
  try {
    for (const name of await discoverFunctionNames(config)) {
      const files = await resolveFunctionFiles(config, name);
      await checkFunctionEntrypoint(
        config,
        name,
        files.entryPath,
        [],
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function denoProjectFlags(config: MinibaseConfig, name: string): Promise<string[]> {
  const flags: string[] = [];
  const files = await resolveFunctionFiles(config, name);
  if (files.denoConfig !== undefined) flags.push(`--config=${files.denoConfig}`);
  if (files.importMap !== undefined) flags.push(`--import-map=${files.importMap}`);
  if (files.lockFile !== undefined) flags.push(`--lock=${files.lockFile}`, "--frozen=true");
  else flags.push("--no-lock");
  return flags;
}

export async function discoverFunctionNames(config: MinibaseConfig): Promise<string[]> {
  const functionsDir = config.project.functionsDir;
  try {
    const names = new Set<string>();
    for await (const entry of Deno.readDir(functionsDir)) {
      if (
        entry.isDirectory && validFunctionName(entry.name) &&
        await isFile((await resolveFunctionFiles(config, entry.name)).entryPath)
      ) {
        names.add(entry.name);
      }
    }
    for (const [name, definition] of Object.entries(config.functions.definitions)) {
      if (validFunctionName(name) && definition.entrypoint !== undefined) names.add(name);
    }
    return [...names].sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function functionEntrypointsComplete(config: MinibaseConfig): Promise<boolean> {
  const functionsDir = config.project.functionsDir;
  try {
    for await (const entry of Deno.readDir(functionsDir)) {
      if (
        entry.isDirectory && entry.name !== "_shared" && validFunctionName(entry.name) &&
        !(await isFile((await resolveFunctionFiles(config, entry.name)).entryPath))
      ) {
        return false;
      }
    }
    for (const [name, definition] of Object.entries(config.functions.definitions)) {
      if (
        definition.entrypoint !== undefined &&
        !(await isFile((await resolveFunctionFiles(config, name)).entryPath))
      ) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
}

interface DenoInfoReport {
  modules?: Array<{ specifier?: unknown }>;
}

async function resolveFunctionDependencyFiles(
  config: MinibaseConfig,
  name: string,
  files: ResolvedFunctionFiles,
  redactions: string[],
): Promise<string[]> {
  const output = await new Deno.Command(await functionDenoExecutable(), {
    args: [
      "info",
      "--json",
      "--quiet",
      "--allow-import",
      ...await denoProjectFlags(config, name),
      toFileUrl(files.entryPath).href,
    ],
    env: {
      ...forwardedFunctionHostEnvironment(),
      DENO_DIR: join(config.project.cacheDir, "deno"),
      DENO_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (!output.success) {
    const detail = [decoder.decode(output.stderr), decoder.decode(output.stdout)]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n");
    throw new Error(
      `Function dependency graph failed for ${files.entryPath}` +
        (detail.length === 0 ? "" : `:\n${redact(stripAnsi(detail), redactions)}`),
    );
  }

  let report: DenoInfoReport;
  try {
    report = JSON.parse(decoder.decode(output.stdout)) as DenoInfoReport;
  } catch (error) {
    throw new Error(
      `Function dependency graph returned invalid JSON for ${files.entryPath}: ${error}`,
    );
  }
  if (!Array.isArray(report.modules)) {
    throw new Error(`Function dependency graph omitted modules for ${files.entryPath}`);
  }

  const allowedRoots = await Promise.all([
    Deno.realPath(config.project.supabaseDir),
    Deno.realPath(config.project.cacheDir),
  ]);
  const paths = new Set<string>();
  for (const module of report.modules) {
    if (typeof module.specifier !== "string" || !module.specifier.startsWith("file:")) continue;
    const url = new URL(module.specifier);
    url.hash = "";
    url.search = "";
    await addLocalDependency(paths, fromFileUrl(url), allowedRoots);
  }
  for (const path of [files.denoConfig, files.importMap, files.lockFile]) {
    if (path !== undefined) await addLocalDependency(paths, path, allowedRoots);
  }
  if (paths.size === 0) {
    throw new Error(`Function dependency graph found no local entrypoint for ${files.entryPath}`);
  }
  return [...paths].sort();
}

async function addLocalDependency(
  paths: Set<string>,
  path: string,
  allowedRoots: string[],
): Promise<void> {
  const realPath = await Deno.realPath(path);
  if (!allowedRoots.some((root) => pathIsWithin(root, realPath))) {
    throw new Error(`Function local dependency escapes the permitted project roots: ${path}`);
  }
  if (!(await Deno.stat(realPath)).isFile) {
    throw new Error(`Function local dependency is not a file: ${path}`);
  }
  paths.add(path);
}

async function functionDependencyFingerprint(paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const [linkStat, realPath] = await Promise.all([Deno.lstat(path), Deno.realPath(path)]);
      const stat = await Deno.stat(realPath);
      parts.push(
        `${path}:${linkStat.isSymlink ? "link" : "file"}:${realPath}:${stat.size}:` +
          `${stat.mtime?.getTime() ?? 0}`,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        parts.push(`${path}:missing`);
        continue;
      }
      throw error;
    }
  }
  return parts.join("\n");
}

export async function resolveFunctionFiles(
  config: MinibaseConfig,
  name: string,
): Promise<ResolvedFunctionFiles> {
  const functionDir = join(config.project.functionsDir, name);
  const definition = config.functions.definitions[name];
  const entryPath = definition?.entrypoint ?? join(functionDir, "index.ts");
  const explicitImportMap = definition?.importMap;
  let denoConfig: string | undefined;
  let importMap: string | undefined;
  if (explicitImportMap !== undefined) {
    if (/(?:^|[\\/])deno\.jsonc?$/iu.test(explicitImportMap)) denoConfig = explicitImportMap;
    else {
      importMap = explicitImportMap;
      const functionDenoConfig = join(functionDir, "deno.json");
      const projectDenoConfig = join(config.project.supabaseDir, "deno.json");
      if (await isFile(functionDenoConfig)) denoConfig = functionDenoConfig;
      else if (await isFile(projectDenoConfig)) denoConfig = projectDenoConfig;
    }
  } else {
    const functionDenoConfig = join(functionDir, "deno.json");
    const projectDenoConfig = join(config.project.supabaseDir, "deno.json");
    if (await isFile(functionDenoConfig)) denoConfig = functionDenoConfig;
    else if (await isFile(projectDenoConfig)) denoConfig = projectDenoConfig;
  }
  const functionLock = join(functionDir, "deno.lock");
  const projectLock = join(config.project.supabaseDir, "deno.lock");
  const lockFile = await isFile(functionLock)
    ? functionLock
    : await isFile(projectLock)
    ? projectLock
    : undefined;
  return { functionDir, entryPath, importMap, denoConfig, lockFile };
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length === 0 || (path !== ".." && !path.startsWith("../") &&
    !path.startsWith("..\\"));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function limitBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum) {
          controller.error(new Error(`Function request body exceeds ${maximum} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function observeBody(
  body: ReadableStream<Uint8Array>,
  finish: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finishOnce = () => {
    if (!finished) {
      finished = true;
      finish();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finishOnce();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finishOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finishOnce();
      await reader.cancel(reason);
    },
  });
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return messages.join(": ");
}
