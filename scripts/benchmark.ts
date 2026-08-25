import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dirname, join, resolve } from "@std/path";
import postgres, { type Sql } from "postgres";
import { activeAuthSigningKey, loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { signJwt } from "../src/auth/jwt.ts";
import { discoverProject } from "../src/project/discover.ts";
import type { RuntimeState } from "../src/project/runtime.ts";
import {
  type BenchmarkReport,
  type LatencyMeasurement,
  measurement,
  nativePostgresBaseline,
  postgresDatabasePoolBenchmark,
} from "./benchmark_report.ts";

export interface BenchmarkOptions {
  engine: "pglite" | "postgres";
  output: string;
  iterations: number;
  warmups: number;
  concurrencyRequests: number;
}

export interface HardwareReport {
  os: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  powerSource: "unknown";
}

export interface GitReport {
  commit: string;
  dirty: boolean;
}

interface FullBenchmarkReport extends BenchmarkReport {
  runId: string;
  recordedAt: string;
  git: GitReport;
  toolchain: {
    deno: string;
    v8: string;
    typescript: string;
  };
  runner: BenchmarkReport["runner"] & {
    hardware: HardwareReport;
    note: string;
  };
  configuration: {
    iterations: number;
    warmups: number;
    concurrencyRequests: number;
    concurrencyLevels: number[];
    memorySampleIntervalMs: number;
  };
  artifact: BenchmarkReport["artifact"] & {
    kind: "deno-compile-candidate";
    fileName: string;
    sha256: string;
    versionSmoke: boolean;
    limitation: string;
  };
  startup: BenchmarkReport["startup"] & {
    coldDatabaseRuntime?: RuntimeState["databaseRuntime"];
    warmDatabaseRuntime?: RuntimeState["databaseRuntime"];
  };
  memory: BenchmarkReport["memory"] & {
    coldProcessTreeRssBytes: number[];
    warmProcessTreeRssBytes: number[];
    idleProcessTreeRssBytes: number[];
  };
}

export interface RunningServer {
  apiUrl: string;
  startupMs: number;
  runtime: RuntimeState;
  sampler: ProcessMemorySampler;
  databasePool: {
    configuredMin: number;
    configuredMax: number;
    observeConnections(applicationName?: string): Promise<number>;
  } | null;
  nativePostgresUrl: string | null;
  stop(): Promise<{ stdout: string; stderr: string; peakRssBytes: number; samples: number[] }>;
}

const MEMORY_SAMPLE_INTERVAL_MS = 500;
const CONCURRENCY_LEVELS = [1, 10, 50, 100];
const POSTGRES_POOL_MIN = 2;
const POSTGRES_POOL_MAX = 8;
const POSTGRES_CONNECTION_SAMPLE_INTERVAL_MS = 5;

async function runBenchmark(options: BenchmarkOptions): Promise<FullBenchmarkReport> {
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const projectRoot = await Deno.makeTempDir({ prefix: `minibase-benchmark-${options.engine}-` });
  let warmServer: RunningServer | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), projectRoot);
    await writeBenchmarkConfig(projectRoot);
    const coldServer = await startBenchmarkServer(projectRoot, options.engine);
    const coldStartupMs = coldServer.startupMs;
    const coldRuntime = coldServer.runtime.databaseRuntime;
    const coldStopped = await coldServer.stop();

    warmServer = await startBenchmarkServer(projectRoot, options.engine);
    const warmStartupMs = warmServer.startupMs;
    const warmRuntime = warmServer.runtime.databaseRuntime;
    const idleMemorySamples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const rss = await warmServer.sampler.sampleNow();
      if (rss !== null) idleMemorySamples.push(rss);
      await delay(100);
    }
    if (idleMemorySamples.length === 0) {
      throw new Error("Unable to sample the running Minibase process tree memory");
    }

    const project = await discoverProject(projectRoot);
    const keys = await createRoleKeys(project.secretsFile);
    const clients = await prepareClients(warmServer.apiUrl, keys);
    const workloads = await runWorkloads(clients, options);
    const concurrencyRun = await runConcurrencyMatrix(
      clients.user,
      clients.userId,
      options.concurrencyRequests,
      warmServer.databasePool?.observeConnections,
    );
    const nativePostgres = warmServer.nativePostgresUrl === null
      ? { applicable: false, reason: "pglite-has-no-postgres-wire-protocol" } as const
      : await runNativePostgresBaseline(
        warmServer.nativePostgresUrl,
        clients.userId,
        options,
        warmServer.databasePool!.observeConnections,
      );
    await delay(150);
    const functionStartup = await readFunctionStartupMetrics(project.logsDir);

    const warmStopped = await warmServer.stop();
    warmServer = null;
    const artifact = await compileArtifact(dirname(options.output), options.engine);
    const git = await gitReport();
    const hardware = await hardwareReport();
    const hardwareFingerprint = await sha256Text(JSON.stringify(hardware));
    const runnerId = normalizedRunnerId(Deno.env.get("MINIBASE_BENCHMARK_RUNNER"));
    const gateEligible = runnerId !== null && !git.dirty;
    const report: FullBenchmarkReport = {
      schemaVersion: 3,
      runId,
      recordedAt: new Date().toISOString(),
      engine: options.engine,
      git,
      toolchain: {
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        typescript: Deno.version.typescript,
      },
      runner: {
        id: runnerId,
        gateEligible,
        hardwareFingerprint,
        hardware,
        note: gateEligible
          ? "Eligible for same-runner historical comparison."
          : "Exploratory result only: set MINIBASE_BENCHMARK_RUNNER on a fixed clean runner.",
      },
      configuration: {
        iterations: options.iterations,
        warmups: options.warmups,
        concurrencyRequests: options.concurrencyRequests,
        concurrencyLevels: CONCURRENCY_LEVELS,
        memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
      },
      artifact,
      startup: {
        coldMs: round(coldStartupMs),
        warmMs: round(warmStartupMs),
        coldDatabaseRuntime: coldRuntime,
        warmDatabaseRuntime: warmRuntime,
      },
      memory: {
        idleMedianRssBytes: median(idleMemorySamples),
        peakRssBytes: Math.max(coldStopped.peakRssBytes, warmStopped.peakRssBytes),
        coldProcessTreeRssBytes: coldStopped.samples,
        warmProcessTreeRssBytes: warmStopped.samples,
        idleProcessTreeRssBytes: idleMemorySamples,
      },
      functionStartup,
      databasePool: options.engine === "postgres"
        ? postgresDatabasePoolBenchmark(
          POSTGRES_POOL_MIN,
          POSTGRES_POOL_MAX,
          concurrencyRun.connectionObservations,
        )
        : { applicable: false, reason: "pglite-does-not-use-postgres-connections" },
      nativePostgres,
      workloads,
      concurrency: concurrencyRun.measurements,
    };
    await Deno.mkdir(dirname(options.output), { recursive: true });
    await Deno.writeTextFile(options.output, JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    if (warmServer !== null) {
      const stopped = await warmServer.stop().catch(() => null);
      warmServer = null;
      if (stopped !== null) {
        const diagnosticPath = `${options.output}.failure.log`;
        await Deno.mkdir(dirname(diagnosticPath), { recursive: true });
        await Deno.writeTextFile(
          diagnosticPath,
          `[stdout]\n${stopped.stdout}\n[stderr]\n${stopped.stderr}`,
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ` +
            `server diagnostics: ${diagnosticPath}`,
        );
      }
    }
    throw error;
  } finally {
    await warmServer?.stop().catch(() => undefined);
    await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
  }
}

async function runNativePostgresBaseline(
  connectionUrl: string,
  userId: string,
  options: BenchmarkOptions,
  observeConnections: (applicationName?: string) => Promise<number>,
) {
  const sql = postgres(connectionUrl, {
    max: POSTGRES_POOL_MAX,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connection: { application_name: "minibase-benchmark-direct" },
    onnotice: () => {},
  });
  const claims = JSON.stringify({ role: "authenticated", sub: userId });
  const selectWithRls = async (): Promise<void> => {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(
        `select set_config('request.jwt.claims', $1, true),
                set_config('request.jwt.claim.sub', $2, true),
                set_config('request.jwt.claim.role', 'authenticated', true),
                set_config('role', 'authenticated', true)`,
        [claims, userId],
      );
      const rows = await transaction.unsafe<Array<{ id: number }>>(
        "select id::int from public.notes where owner_id = $1 limit 1",
        [userId],
      );
      if (rows.length !== 1) throw new Error("Native PostgreSQL RLS baseline returned no row");
    });
  };
  try {
    await Promise.all(Array.from({ length: POSTGRES_POOL_MAX }, selectWithRls));
    const rlsSelect = await sampleOperation(options, selectWithRls);
    const concurrencyRun = await runNativePostgresConcurrencyMatrix(
      selectWithRls,
      options.concurrencyRequests,
      () => observeConnections("minibase-benchmark-direct"),
    );
    return nativePostgresBaseline(
      POSTGRES_POOL_MAX,
      rlsSelect,
      concurrencyRun.measurements,
      concurrencyRun.connectionObservations,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runNativePostgresConcurrencyMatrix(
  operation: () => Promise<void>,
  requestsPerLevel: number,
  observeConnections: () => Promise<number>,
): Promise<{
  measurements: FullBenchmarkReport["concurrency"];
  connectionObservations: Array<{ concurrency: number; samples: number[] }>;
}> {
  const results: FullBenchmarkReport["concurrency"] = [];
  const connectionObservations: Array<{ concurrency: number; samples: number[] }> = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    const samples = new Array<number>(requestsPerLevel);
    const connectionSamples: number[] = [];
    let next = 0;
    let requestsRunning = true;
    const connectionSampler = (async () => {
      while (requestsRunning) {
        connectionSamples.push(await observeConnections());
        await delay(POSTGRES_CONNECTION_SAMPLE_INTERVAL_MS);
      }
      connectionSamples.push(await observeConnections());
    })();
    const startedAt = performance.now();
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, requestsPerLevel) }, async () => {
          while (true) {
            const index = next++;
            if (index >= requestsPerLevel) return;
            const requestStartedAt = performance.now();
            await operation();
            samples[index] = performance.now() - requestStartedAt;
          }
        }),
      );
    } finally {
      requestsRunning = false;
      await connectionSampler;
    }
    results.push({
      concurrency,
      measurement: measurement(samples, performance.now() - startedAt),
    });
    connectionObservations.push({ concurrency, samples: connectionSamples });
  }
  return { measurements: results, connectionObservations };
}

export async function runWorkloads(
  clients: Awaited<ReturnType<typeof prepareClients>>,
  options: BenchmarkOptions,
): Promise<Record<string, LatencyMeasurement>> {
  const { service, user, userId, email, password } = clients;
  const stable = await service.from("notes").insert({
    owner_id: userId,
    body: "benchmark stable row",
  }).select("id").single();
  requireNoError("prepare stable CRUD row", stable.error);
  const stableId = stable.data!.id as number;
  const listRows = Array.from({ length: 32 }, (_, index) => ({
    owner_id: userId,
    body: `benchmark list row ${index}`,
  }));
  requireNoError("prepare list rows", (await service.from("notes").insert(listRows)).error);
  const deleteRows = Array.from({ length: options.warmups + options.iterations }, (_, index) => ({
    owner_id: userId,
    body: `benchmark delete row ${index}`,
  }));
  const insertedDeleteRows = await service.from("notes").insert(deleteRows).select("id");
  requireNoError("prepare delete rows", insertedDeleteRows.error);
  const deleteIds = insertedDeleteRows.data!.map((row) => row.id as number);

  requireNoError(
    "create benchmark Storage bucket",
    (await service.storage.createBucket("benchmarks", { public: false })).error,
  );
  requireNoError(
    "prepare benchmark download object",
    (await service.storage.from("benchmarks").upload(
      "stable.bin",
      new Uint8Array(4_096),
      { contentType: "application/octet-stream" },
    )).error,
  );

  let insertCounter = 0;
  let updateCounter = 0;
  let deleteCounter = 0;
  let uploadCounter = 0;
  const workloads: Record<string, LatencyMeasurement> = {};
  workloads.authPasswordSignIn = await sampleOperation(options, async () => {
    requireNoError(
      "Auth password sign-in",
      (await user.auth.signInWithPassword({ email, password })).error,
    );
  });
  workloads.crudInsert = await sampleOperation(options, async () => {
    const result = await service.from("notes").insert({
      owner_id: userId,
      body: `benchmark inserted ${insertCounter++}`,
    }).select("id").single();
    requireNoError("CRUD insert", result.error);
  });
  workloads.crudSelectSingle = await sampleOperation(options, async () => {
    const result = await service.from("notes").select("id,body").eq("id", stableId).single();
    requireNoError("CRUD single select", result.error);
  });
  workloads.crudSelectList = await sampleOperation(options, async () => {
    const result = await service.from("notes").select("id,body").eq("owner_id", userId).limit(20);
    requireNoError("CRUD list select", result.error);
  });
  workloads.crudUpdate = await sampleOperation(options, async () => {
    const result = await service.from("notes").update({
      body: `benchmark update ${updateCounter++}`,
    })
      .eq("id", stableId).select("id").single();
    requireNoError("CRUD update", result.error);
  });
  workloads.crudDelete = await sampleOperation(options, async () => {
    const id = deleteIds[deleteCounter++]!;
    const result = await service.from("notes").delete().eq("id", id).select("id").single();
    requireNoError("CRUD delete", result.error);
  });
  workloads.rlsSelect = await sampleOperation(options, async () => {
    const result = await user.from("notes").select("id,body").eq("id", stableId).single();
    requireNoError("RLS select", result.error);
  });
  workloads.storageUpload = await sampleOperation(options, async () => {
    const result = await service.storage.from("benchmarks").upload(
      `upload-${uploadCounter++}.bin`,
      new Uint8Array(4_096),
      { contentType: "application/octet-stream" },
    );
    requireNoError("Storage upload", result.error);
  });
  workloads.storageDownload = await sampleOperation(options, async () => {
    const result = await service.storage.from("benchmarks").download("stable.bin");
    requireNoError("Storage download", result.error);
    await result.data!.arrayBuffer();
  });

  const coldFunctionStartedAt = performance.now();
  const coldFunction = await user.functions.invoke("echo", { body: { benchmark: "cold" } });
  requireNoError("Functions cold invoke", coldFunction.error);
  workloads.functionsCold = measurement([performance.now() - coldFunctionStartedAt]);
  workloads.functionsHot = await sampleOperation(options, async () => {
    const result = await user.functions.invoke("echo", { body: { benchmark: "hot" } });
    requireNoError("Functions hot invoke", result.error);
  });
  return workloads;
}

export async function runConcurrencyMatrix(
  client: SupabaseClient,
  userId: string,
  requestsPerLevel: number,
  observeConnections?: () => Promise<number>,
): Promise<{
  measurements: FullBenchmarkReport["concurrency"];
  connectionObservations: Array<{ concurrency: number; samples: number[] }>;
}> {
  const results: FullBenchmarkReport["concurrency"] = [];
  const connectionObservations: Array<{ concurrency: number; samples: number[] }> = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    const samples = new Array<number>(requestsPerLevel);
    const connectionSamples: number[] = [];
    let next = 0;
    let requestsRunning = true;
    const connectionSampler = observeConnections === undefined ? null : (async () => {
      while (requestsRunning) {
        connectionSamples.push(await observeConnections());
        await delay(POSTGRES_CONNECTION_SAMPLE_INTERVAL_MS);
      }
      connectionSamples.push(await observeConnections());
    })();
    const startedAt = performance.now();
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, requestsPerLevel) }, async () => {
          while (true) {
            const index = next++;
            if (index >= requestsPerLevel) return;
            const requestStartedAt = performance.now();
            const result = await client.from("notes").select("id").eq("owner_id", userId).limit(1);
            requireNoError(`RLS concurrency ${concurrency}`, result.error);
            samples[index] = performance.now() - requestStartedAt;
          }
        }),
      );
    } finally {
      requestsRunning = false;
      await connectionSampler;
    }
    results.push({
      concurrency,
      measurement: measurement(samples, performance.now() - startedAt),
    });
    if (observeConnections !== undefined) {
      connectionObservations.push({ concurrency, samples: connectionSamples });
    }
  }
  return { measurements: results, connectionObservations };
}

async function sampleOperation(
  options: Pick<BenchmarkOptions, "warmups" | "iterations">,
  operation: () => Promise<void>,
): Promise<LatencyMeasurement> {
  for (let index = 0; index < options.warmups; index++) await operation();
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < options.iterations; index++) {
    const sampleStartedAt = performance.now();
    await operation();
    samples.push(performance.now() - sampleStartedAt);
  }
  return measurement(samples, performance.now() - startedAt);
}

export async function prepareClients(apiUrl: string, keys: { anon: string; service: string }) {
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  const user = createClient(apiUrl, keys.anon, clientOptions);
  const email = `benchmark-${crypto.randomUUID()}@example.com`;
  const password = "benchmark password with enough entropy 2026";
  const signup = await user.auth.signUp({
    email,
    password,
    options: { data: { display_name: "Benchmark User" } },
  });
  requireNoError("prepare benchmark user", signup.error);
  if (signup.data.user === null || signup.data.session === null) {
    throw new Error("Benchmark Auth signup did not return a user session");
  }
  return {
    service: createClient(apiUrl, keys.service, clientOptions),
    user,
    userId: signup.data.user.id,
    email,
    password,
  };
}

export async function createRoleKeys(
  secretsFile: string,
): Promise<{ anon: string; service: string }> {
  const active = activeAuthSigningKey(await loadOrCreateAuthSecrets(secretsFile));
  const now = Math.floor(Date.now() / 1_000);
  const create = (role: "anon" | "service_role") =>
    signJwt({ role, aud: "authenticated", iat: now, exp: now + 3_600 }, active);
  return { anon: await create("anon"), service: await create("service_role") };
}

export async function startBenchmarkServer(
  projectRoot: string,
  engine: BenchmarkOptions["engine"],
  memorySampleIntervalMs = MEMORY_SAMPLE_INTERVAL_MS,
): Promise<RunningServer> {
  if (
    !Number.isSafeInteger(memorySampleIntervalMs) || memorySampleIntervalMs < 100 ||
    memorySampleIntervalMs > 60_000
  ) {
    throw new Error("Benchmark memory sample interval must be between 100 and 60000 milliseconds");
  }
  const apiPort = availablePort();
  const postgresPort = engine === "postgres" ? availablePort() : null;
  const environment = {
    ...Deno.env.toObject(),
    DENO_NO_UPDATE_CHECK: "1",
    MINIBASE_LOG_FORMAT: "json",
    ...(engine === "postgres"
      ? {
        MINIBASE_DATABASE_MANAGED: "true",
        MINIBASE_POSTGRES_PORT: String(postgresPort),
        MINIBASE_POSTGRES_RUNTIME_DIR: await requirePostgresRuntime(),
      }
      : {}),
  };
  const startedAt = performance.now();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-no-legacy-abort",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      projectRoot,
      "--engine",
      engine,
      "--port",
      String(apiPort),
    ],
    cwd: projectRoot,
    env: environment,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const sampler = new ProcessMemorySampler(child.pid, memorySampleIntervalMs);
  let poolObserver: Sql | null = null;
  sampler.start();
  try {
    const runtime = await waitForReady(join(projectRoot, ".minibase", "runtime.json"));
    if (postgresPort !== null) {
      poolObserver = postgres(`postgres://postgres@127.0.0.1:${postgresPort}/postgres`, {
        max: 1,
        connection: { application_name: "minibase-benchmark-observer" },
        onnotice: () => {},
      });
    }
    const startupMs = performance.now() - startedAt;
    let stopped = false;
    return {
      apiUrl: runtime.apiUrl,
      startupMs,
      runtime,
      sampler,
      databasePool: poolObserver === null ? null : {
        configuredMin: POSTGRES_POOL_MIN,
        configuredMax: POSTGRES_POOL_MAX,
        observeConnections: async (applicationName = "minibase") => {
          const rows = await poolObserver!.unsafe<Array<{ count: number }>>(
            `select count(*)::int as count from pg_stat_activity
               where datname = current_database() and application_name = $1`,
            [applicationName],
          );
          return rows[0]?.count ?? 0;
        },
      },
      nativePostgresUrl: postgresPort === null
        ? null
        : `postgres://postgres@127.0.0.1:${postgresPort}/postgres`,
      async stop() {
        if (stopped) {
          return {
            stdout: await stdout,
            stderr: await stderr,
            peakRssBytes: sampler.peakRssBytes,
            samples: sampler.samples,
          };
        }
        stopped = true;
        await poolObserver?.end({ timeout: 1 });
        poolObserver = null;
        await sampler.sampleNow();
        const stop = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            join(Deno.cwd(), "src", "main.ts"),
            "stop",
            "--project",
            projectRoot,
            "--json",
          ],
          cwd: projectRoot,
          env: environment,
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (!stop.success) {
          throw new Error(
            `Benchmark server stop failed: ${new TextDecoder().decode(stop.stderr).trim()}`,
          );
        }
        const status = await child.status;
        await sampler.stop();
        const capturedStdout = await stdout;
        const capturedStderr = await stderr;
        if (!status.success) {
          throw new Error(
            `Benchmark server exited with ${status.code}: ${capturedStderr.trim()}`,
          );
        }
        return {
          stdout: capturedStdout,
          stderr: capturedStderr,
          peakRssBytes: sampler.peakRssBytes,
          samples: sampler.samples,
        };
      },
    };
  } catch (error) {
    await poolObserver?.end({ timeout: 1 }).catch(() => undefined);
    poolObserver = null;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
    await child.status.catch(() => undefined);
    await sampler.stop();
    const capturedStderr = await stderr;
    await stdout;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        (capturedStderr.trim().length === 0 ? "" : `: ${capturedStderr.trim()}`),
    );
  }
}

export async function writeBenchmarkConfig(projectRoot: string): Promise<void> {
  await Deno.writeTextFile(
    join(projectRoot, "minibase.toml"),
    `format_version = 1\n\n[database]\npool_min = ${POSTGRES_POOL_MIN}\npool_max = ${POSTGRES_POOL_MAX}\n`,
  );
}

async function waitForReady(runtimePath: string): Promise<RuntimeState> {
  let lastFailure = "runtime state was not created";
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const runtime = JSON.parse(await Deno.readTextFile(runtimePath)) as RuntimeState;
      const response = await fetch(new URL("/health/ready", runtime.controlUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        return runtime;
      }
      lastFailure = `readiness returned ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Minibase readiness: ${lastFailure}`);
}

export class ProcessMemorySampler {
  readonly samples: number[] = [];
  peakRssBytes = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly pid: number, private readonly intervalMs: number) {}

  start(): void {
    if (this.#timer !== null) return;
    void this.sampleNow();
    this.#timer = setInterval(() => void this.sampleNow(), this.intervalMs);
  }

  async sampleNow(): Promise<number | null> {
    let sampled: number | null = null;
    this.#pending = this.#pending.then(async () => {
      sampled = await processTreeRssBytes(this.pid);
      if (sampled !== null) {
        this.samples.push(sampled);
        this.peakRssBytes = Math.max(this.peakRssBytes, sampled);
      }
    });
    await this.#pending;
    return sampled;
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#pending;
    if (this.samples.length === 0) {
      throw new Error("Process memory sampler did not collect any samples");
    }
  }
}

async function processTreeRssBytes(rootPid: number): Promise<number | null> {
  if (Deno.build.os === "windows") {
    const script = [
      `$rootPid = ${rootPid}`,
      "$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize)",
      "$ids = New-Object 'System.Collections.Generic.HashSet[uint32]'",
      "[void]$ids.Add([uint32]$rootPid)",
      "$changed = $true",
      "while ($changed) {",
      "  $changed = $false",
      "  foreach ($row in $rows) {",
      "    if ($ids.Contains([uint32]$row.ParentProcessId) -and $ids.Add([uint32]$row.ProcessId)) { $changed = $true }",
      "  }",
      "}",
      "$sum = ($rows | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | Measure-Object -Sum WorkingSetSize).Sum",
      "if ($null -ne $sum) { [Console]::WriteLine([uint64]$sum) }",
    ].join("; ");
    const output = await new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return null;
    return parsePositiveInteger(new TextDecoder().decode(output.stdout).trim());
  }
  const output = await new Deno.Command("ps", {
    args: ["-eo", "pid=,ppid=,rss="],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return null;
  const rows = new TextDecoder().decode(output.stdout).trim().split(/\r?\n/gu).map((line) => {
    const [pid, parentPid, rssKiB] = line.trim().split(/\s+/gu).map(Number);
    return { pid, parentPid, rssKiB };
  }).filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.parentPid));
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.parentPid!) && !ids.has(row.pid!)) {
        ids.add(row.pid!);
        changed = true;
      }
    }
  }
  const kibibytes = rows.filter((row) => ids.has(row.pid!)).reduce(
    (total, row) => total + (row.rssKiB ?? 0),
    0,
  );
  return kibibytes > 0 ? kibibytes * 1_024 : null;
}

async function readFunctionStartupMetrics(
  logsDir: string,
): Promise<FullBenchmarkReport["functionStartup"]> {
  const path = join(logsDir, "minibase.jsonl");
  for (let attempt = 0; attempt < 40; attempt++) {
    const records = (await Deno.readTextFile(path)).trim()
      .split(/\r?\n/gu)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "function_startup_metric");
    const cache = records.filter((record) => record.phase === "dependency_cache");
    const typeCheck = records.filter((record) =>
      record.phase === "type_check" && record.functionName === "echo"
    ).at(-1);
    const workerReady = records.filter((record) =>
      record.phase === "worker_ready" && record.functionName === "echo"
    ).at(-1);
    if (cache.length >= 2 && typeCheck !== undefined && workerReady !== undefined) {
      return {
        coldDependencyCacheMs: metricDuration(cache[0]!),
        warmDependencyCacheMs: metricDuration(cache[1]!),
        typeCheckMs: metricDuration(typeCheck),
        workerReadyMs: metricDuration(workerReady),
      };
    }
    await delay(50);
  }
  throw new Error("Function startup phase metrics were incomplete");
}

function metricDuration(record: Record<string, unknown>): number {
  if (typeof record.durationMs !== "number" || record.durationMs < 0) {
    throw new Error("Function startup metric has an invalid duration");
  }
  return record.durationMs;
}

async function compileArtifact(
  outputDirectory: string,
  engine: BenchmarkOptions["engine"],
): Promise<FullBenchmarkReport["artifact"]> {
  const artifactsDir = join(outputDirectory, "artifacts");
  await Deno.mkdir(artifactsDir, { recursive: true });
  const extension = Deno.build.os === "windows" ? ".exe" : "";
  const artifactPath = join(artifactsDir, `minibase-${engine}${extension}`);
  await Deno.remove(artifactPath).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const compiled = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--quiet",
      "--unstable-no-legacy-abort",
      "-A",
      "--include",
      resolve("src/functions/worker_entry.ts"),
      "--output",
      artifactPath,
      resolve("src/main.ts"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!compiled.success) {
    throw new Error(
      `Deno compile failed: ${new TextDecoder().decode(compiled.stderr).trim()}`,
    );
  }
  const smoke = await new Deno.Command(artifactPath, {
    args: ["version", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const smokeStderr = new TextDecoder().decode(smoke.stderr).trim();
  if (!smoke.success || smokeStderr.length > 0) {
    throw new Error(`Compiled artifact version smoke failed: ${smokeStderr}`);
  }
  const version = JSON.parse(new TextDecoder().decode(smoke.stdout)) as { version?: unknown };
  if (typeof version.version !== "string") {
    throw new Error("Compiled artifact version smoke returned an invalid payload");
  }
  const bytes = await Deno.readFile(artifactPath);
  return {
    kind: "deno-compile-candidate",
    fileName: artifactPath.split(/[\\/]/gu).at(-1)!,
    bytes: bytes.byteLength,
    sha256: await sha256Bytes(bytes),
    versionSmoke: true,
    limitation:
      "This is a size/smoke candidate; release packaging and compiled Function subprocess execution are Phase 14 work.",
  };
}

export async function hardwareReport(): Promise<HardwareReport> {
  return {
    os: Deno.build.os,
    osRelease: Deno.osRelease(),
    arch: Deno.build.arch,
    cpuModel: await cpuModel(),
    logicalCpus: navigator.hardwareConcurrency,
    totalMemoryBytes: Deno.systemMemoryInfo().total,
    powerSource: "unknown",
  };
}

async function cpuModel(): Promise<string> {
  if (Deno.build.os === "windows") {
    return await commandText("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim()",
    ]);
  }
  if (Deno.build.os === "darwin") {
    return await commandText("sysctl", ["-n", "machdep.cpu.brand_string"]);
  }
  try {
    const contents = await Deno.readTextFile("/proc/cpuinfo");
    return contents.match(/^model name\s*:\s*(.+)$/mu)?.[1]?.trim() ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function commandText(command: string, args: string[]): Promise<string> {
  try {
    const output = await new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    const value = new TextDecoder().decode(output.stdout).trim();
    return output.success && value.length > 0 ? value : "unknown";
  } catch {
    return "unknown";
  }
}

export async function gitReport(): Promise<GitReport> {
  const commit = await gitText(["rev-parse", "HEAD"]);
  const status = await gitText(["status", "--porcelain"]);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`Invalid Git commit: ${commit}`);
  return { commit, dirty: status.length > 0 };
}

async function gitText(args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(output.stderr)}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function requirePostgresRuntime(): Promise<string> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    const executable = join(
      candidate,
      "bin",
      Deno.build.os === "windows" ? "postgres.exe" : "postgres",
    );
    try {
      if ((await Deno.stat(executable)).isFile) return candidate;
    } catch {
      // Try the next configured Runtime.
    }
  }
  throw new Error("PostgreSQL benchmark requires MINIBASE_POSTGRES_RUNTIME_DIR");
}

function parseArguments(args: string[]): BenchmarkOptions {
  let engine: BenchmarkOptions["engine"] = "pglite";
  let output: string | undefined;
  let iterations = 20;
  let warmups = 5;
  let concurrencyRequests = 100;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--engine") {
      const value = requiredValue(args, ++index, argument);
      if (value !== "pglite" && value !== "postgres") {
        throw new Error("--engine must be pglite or postgres");
      }
      engine = value;
    } else if (argument === "--output") output = requiredValue(args, ++index, argument);
    else if (argument === "--iterations") {
      iterations = positiveInteger(requiredValue(args, ++index, argument), argument);
    } else if (argument === "--warmups") {
      warmups = nonNegativeInteger(requiredValue(args, ++index, argument), argument);
    } else if (argument === "--concurrency-requests") {
      concurrencyRequests = positiveInteger(requiredValue(args, ++index, argument), argument);
    } else throw new Error(`Unknown benchmark option: ${argument}`);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return {
    engine,
    output: resolve(output ?? join(".benchmarks", "local", `${timestamp}-${engine}.json`)),
    iterations,
    warmups,
    concurrencyRequests,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error(`${option} must be an integer between 1 and 100000`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error(`${option} must be an integer between 0 and 100000`);
  }
  return parsed;
}

function normalizedRunnerId(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(normalized)) {
    throw new Error(
      "MINIBASE_BENCHMARK_RUNNER must use 1-64 letters, numbers, dots, underscores or hyphens",
    );
  }
  return normalized;
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export function requireNoError(
  operation: string,
  error: { message: string; code?: string; details?: string; hint?: string } | null,
): void {
  if (error !== null) throw new Error(`${operation} failed: ${JSON.stringify(error)}`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sha256Text(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`Benchmark fixture contains unsupported entry: ${from}`);
  }
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const report = await runBenchmark(options);
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    engine: report.engine,
    runner: report.runner.id,
    gateEligible: report.runner.gateEligible,
    coldStartMs: report.startup.coldMs,
    warmStartMs: report.startup.warmMs,
    peakRssBytes: report.memory.peakRssBytes,
    artifactBytes: report.artifact.bytes,
    maxObservedDatabaseConnections: report.databasePool.applicable
      ? report.databasePool.maxObservedConnections
      : null,
    nativePostgresRlsP95Ms: report.nativePostgres.applicable
      ? report.nativePostgres.rlsSelect.summary.p95Ms
      : null,
  }));
}
