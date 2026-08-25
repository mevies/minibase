import { dirname, join, resolve } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import {
  copyTree,
  createRoleKeys,
  delay,
  gitReport,
  hardwareReport,
  prepareClients,
  requireNoError,
  type RunningServer,
  sha256Text,
  startBenchmarkServer,
  writeBenchmarkConfig,
} from "./benchmark.ts";
import {
  SOAK_CYCLE_OPERATIONS,
  SOAK_MINIMUM_CYCLES,
  SOAK_MINIMUM_DURATION_MS,
  SOAK_PERIODIC_OPERATIONS,
  SOAK_SCHEMA_VERSION,
  type SoakEngine,
  type SoakOperation,
  type SoakReport,
  summarizeOperationSamples,
  summarizeSoakMemory,
  validateSoakReport,
} from "./soak_report.ts";

interface SoakOptions {
  engine: SoakEngine;
  output: string;
  durationMs: number;
  cycleIntervalMs: number;
  operationTimeoutMs: number;
  memorySampleIntervalMs: number;
  authEveryCycles: number;
}

interface OperationFailure {
  operation: string;
  cycle: number;
  message: string;
}

const DEFAULT_CYCLE_INTERVAL_MS = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_AUTH_EVERY_CYCLES = 60;

export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const projectRoot = await Deno.makeTempDir({ prefix: `minibase-soak-${options.engine}-` });
  let server: RunningServer | null = null;
  let stopped: Awaited<ReturnType<RunningServer["stop"]>> | null = null;
  const failures: OperationFailure[] = [];
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), projectRoot);
    await writeBenchmarkConfig(projectRoot);
    server = await startBenchmarkServer(
      projectRoot,
      options.engine,
      options.memorySampleIntervalMs,
    );
    const project = await discoverProject(projectRoot);
    const clients = await prepareClients(
      server.apiUrl,
      await createRoleKeys(project.secretsFile),
    );
    requireNoError(
      "create soak Storage bucket",
      (await clients.service.storage.createBucket("soak", { public: false })).error,
    );
    requireNoError(
      "warm soak Function",
      (await clients.user.functions.invoke("echo", { body: { soak: "warmup" } })).error,
    );
    await delay(500);

    const operationSamples = emptyOperationSamples();
    const memoryStartIndex = server.sampler.samples.length;
    await server.sampler.sampleNow();
    const startedAt = new Date();
    const started = performance.now();
    let completedCycles = 0;
    while (performance.now() - started < options.durationMs) {
      const cycleStarted = performance.now();
      await runCycle(
        clients,
        server.apiUrl,
        completedCycles,
        options,
        operationSamples,
        failures,
      );
      completedCycles++;
      const remaining = options.cycleIntervalMs - (performance.now() - cycleStarted);
      if (remaining > 0) {
        const durationRemaining = options.durationMs - (performance.now() - started);
        if (durationRemaining > 0) await delay(Math.min(remaining, durationRemaining));
      }
    }
    const durationMs = Math.ceil(performance.now() - started);
    const finalReady = await readiness(server.apiUrl, options.operationTimeoutMs);
    const cleanupVerified = await verifyCleanup(clients, clients.userId);
    stopped = await server.stop();
    server = null;

    const git = await gitReport();
    const hardware = await hardwareReport();
    const hardwareFingerprint = await sha256Text(JSON.stringify(hardware));
    const runnerId = normalizedRunnerId(
      Deno.env.get("MINIBASE_SOAK_RUNNER") ?? Deno.env.get("MINIBASE_BENCHMARK_RUNNER"),
    );
    const operations = operationSummaries(operationSamples);
    const completedOperations = Object.values(operations).reduce(
      (total, operation) => total + operation.count,
      0,
    );
    const memorySamples = stopped.samples.slice(memoryStartIndex);
    const report: SoakReport = {
      schemaVersion: SOAK_SCHEMA_VERSION,
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
        gateEligible: runnerId !== null && !git.dirty &&
          options.durationMs >= SOAK_MINIMUM_DURATION_MS,
        hardwareFingerprint,
        hardware,
      },
      configuration: {
        requestedDurationMs: options.durationMs,
        minimumDurationMs: SOAK_MINIMUM_DURATION_MS,
        cycleIntervalMs: options.cycleIntervalMs,
        operationTimeoutMs: options.operationTimeoutMs,
        memorySampleIntervalMs: options.memorySampleIntervalMs,
        authEveryCycles: options.authEveryCycles,
        minimumCycles: SOAK_MINIMUM_CYCLES,
      },
      execution: {
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs,
        completedCycles,
        completedOperations,
        failures,
        finalReady,
        cleanupVerified,
      },
      operations,
      memory: summarizeSoakMemory(memorySamples),
      process: {
        exitSuccess: true,
        stderrBytes: new TextEncoder().encode(stopped.stderr).byteLength,
      },
    };
    if (report.runner.gateEligible) validateSoakReport(report, options.engine);
    await Deno.mkdir(dirname(options.output), { recursive: true });
    await Deno.writeTextFile(options.output, JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    if (server !== null) {
      stopped = await server.stop().catch(() => null);
      server = null;
    }
    const diagnosticPath = `${options.output}.failure.json`;
    await Deno.mkdir(dirname(diagnosticPath), { recursive: true });
    await Deno.writeTextFile(
      diagnosticPath,
      JSON.stringify(
        {
          ok: false,
          engine: options.engine,
          error: errorMessage(error),
          failures,
          stderr: stopped?.stderr ?? "",
        },
        null,
        2,
      ) + "\n",
    );
    throw new Error(`${errorMessage(error)}; diagnostics: ${diagnosticPath}`);
  } finally {
    await Deno.remove(projectRoot, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

async function runCycle(
  clients: Awaited<ReturnType<typeof prepareClients>>,
  apiUrl: string,
  cycle: number,
  options: SoakOptions,
  samples: Record<SoakOperation, number[]>,
  failures: OperationFailure[],
): Promise<void> {
  const record = async (operation: SoakOperation, callback: () => Promise<void>) => {
    const started = performance.now();
    try {
      await withTimeout(callback(), options.operationTimeoutMs, operation);
      samples[operation].push(performance.now() - started);
    } catch (error) {
      failures.push({ operation, cycle, message: errorMessage(error) });
      throw error;
    }
  };

  await record("readiness", async () => {
    if (!await readiness(apiUrl, options.operationTimeoutMs)) {
      throw new Error("Minibase readiness returned a non-success response");
    }
  });
  if (cycle % options.authEveryCycles === 0) {
    await record("authPasswordSignIn", async () => {
      requireNoError(
        "soak Auth password sign-in",
        (await clients.user.auth.signInWithPassword({
          email: clients.email,
          password: clients.password,
        })).error,
      );
    });
  }

  let noteId: number | null = null;
  const objectName = `cycle-${cycle}.bin`;
  await record("crudInsert", async () => {
    const inserted = await clients.service.from("notes").insert({
      owner_id: clients.userId,
      body: `soak:${cycle}`,
    }).select("id").single();
    requireNoError("soak CRUD insert", inserted.error);
    noteId = inserted.data!.id as number;
  });
  await record("rlsSelect", async () => {
    const selected = await clients.user.from("notes").select("id,body").eq("id", noteId!).single();
    requireNoError("soak RLS select", selected.error);
    if (selected.data?.body !== `soak:${cycle}`) {
      throw new Error("Soak RLS row changed unexpectedly");
    }
  });
  await record("crudUpdate", async () => {
    const updated = await clients.service.from("notes").update({ body: `soak:${cycle}:updated` })
      .eq("id", noteId!).select("id").single();
    requireNoError("soak CRUD update", updated.error);
  });
  await record("storageUpload", async () => {
    requireNoError(
      "soak Storage upload",
      (await clients.service.storage.from("soak").upload(
        objectName,
        new Uint8Array(4_096),
        { contentType: "application/octet-stream" },
      )).error,
    );
  });
  await record("storageDownload", async () => {
    const downloaded = await clients.service.storage.from("soak").download(objectName);
    requireNoError("soak Storage download", downloaded.error);
    if ((await downloaded.data!.arrayBuffer()).byteLength !== 4_096) {
      throw new Error("Soak Storage download size changed unexpectedly");
    }
  });
  await record("storageRemove", async () => {
    requireNoError(
      "soak Storage remove",
      (await clients.service.storage.from("soak").remove([objectName])).error,
    );
  });
  await record("functionsInvoke", async () => {
    const invoked = await clients.user.functions.invoke("echo", { body: { soak: cycle } });
    requireNoError("soak Function invoke", invoked.error);
    if ((invoked.data as { body?: { soak?: unknown } } | null)?.body?.soak !== cycle) {
      throw new Error("Soak Function response changed unexpectedly");
    }
  });
  await record("crudDelete", async () => {
    const deleted = await clients.service.from("notes").delete().eq("id", noteId!).select("id")
      .single();
    requireNoError("soak CRUD delete", deleted.error);
  });
}

async function readiness(apiUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health/ready", apiUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function verifyCleanup(
  clients: Awaited<ReturnType<typeof prepareClients>>,
  userId: string,
): Promise<boolean> {
  const notes = await clients.service.from("notes").select("id").eq("owner_id", userId).limit(1);
  requireNoError("verify soak database cleanup", notes.error);
  const objects = await clients.service.storage.from("soak").list("", { limit: 1 });
  requireNoError("verify soak Storage cleanup", objects.error);
  return notes.data?.length === 0 && objects.data?.length === 0;
}

function emptyOperationSamples(): Record<SoakOperation, number[]> {
  const samples = {} as Record<SoakOperation, number[]>;
  for (const operation of [...SOAK_CYCLE_OPERATIONS, ...SOAK_PERIODIC_OPERATIONS]) {
    samples[operation] = [];
  }
  return samples;
}

function operationSummaries(
  samples: Record<SoakOperation, number[]>,
): Record<SoakOperation, ReturnType<typeof summarizeOperationSamples>> {
  return Object.fromEntries(
    Object.entries(samples).map(([operation, values]) => [
      operation,
      summarizeOperationSamples(values),
    ]),
  ) as Record<SoakOperation, ReturnType<typeof summarizeOperationSamples>>;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out after ${timeoutMs} milliseconds`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseArguments(args: string[]): SoakOptions {
  let engine: SoakEngine = "pglite";
  let output: string | undefined;
  let durationMs = SOAK_MINIMUM_DURATION_MS;
  let cycleIntervalMs = DEFAULT_CYCLE_INTERVAL_MS;
  let operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS;
  let memorySampleIntervalMs = DEFAULT_MEMORY_SAMPLE_INTERVAL_MS;
  let authEveryCycles = DEFAULT_AUTH_EVERY_CYCLES;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--engine") {
      const value = requiredValue(args, ++index, argument);
      if (value !== "pglite" && value !== "postgres") {
        throw new Error("--engine must be pglite or postgres");
      }
      engine = value;
    } else if (argument === "--output") output = requiredValue(args, ++index, argument);
    else if (argument === "--duration-seconds") {
      durationMs = boundedInteger(requiredValue(args, ++index, argument), argument, 1, 86_400) *
        1_000;
    } else if (argument === "--cycle-interval-ms") {
      cycleIntervalMs = boundedInteger(
        requiredValue(args, ++index, argument),
        argument,
        100,
        60_000,
      );
    } else if (argument === "--operation-timeout-ms") {
      operationTimeoutMs = boundedInteger(
        requiredValue(args, ++index, argument),
        argument,
        1_000,
        60_000,
      );
    } else if (argument === "--memory-sample-interval-ms") {
      memorySampleIntervalMs = boundedInteger(
        requiredValue(args, ++index, argument),
        argument,
        100,
        60_000,
      );
    } else if (argument === "--auth-every-cycles") {
      authEveryCycles = boundedInteger(
        requiredValue(args, ++index, argument),
        argument,
        1,
        100_000,
      );
    } else throw new Error(`Unknown soak option: ${argument}`);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return {
    engine,
    output: resolve(output ?? join(".benchmarks", "soak", `${timestamp}-${engine}.json`)),
    durationMs,
    cycleIntervalMs,
    operationTimeoutMs,
    memorySampleIntervalMs,
    authEveryCycles,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function boundedInteger(
  value: string,
  option: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizedRunnerId(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(normalized)) {
    throw new Error("Soak runner id must use 1-64 letters, numbers, dots, underscores or hyphens");
  }
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const report = await runSoak(options);
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    engine: report.engine,
    runner: report.runner.id,
    gateEligible: report.runner.gateEligible,
    durationMs: report.execution.durationMs,
    completedCycles: report.execution.completedCycles,
    completedOperations: report.execution.completedOperations,
    memoryGrowthBytes: report.memory.growthBytes,
    memoryGrowthRatio: report.memory.growthRatio,
    peakRssBytes: report.memory.peakRssBytes,
  }));
}
