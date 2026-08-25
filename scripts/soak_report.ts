import type { GitReport, HardwareReport } from "./benchmark.ts";

export const SOAK_SCHEMA_VERSION = 1;
export const SOAK_MINIMUM_DURATION_MS = 30 * 60 * 1_000;
export const SOAK_MINIMUM_CYCLES = 300;
export const SOAK_MEMORY_GROWTH_BYTES = 64 * 1_024 * 1_024;
export const SOAK_MEMORY_GROWTH_RATIO = 0.25;

export const SOAK_CYCLE_OPERATIONS = [
  "readiness",
  "crudInsert",
  "rlsSelect",
  "crudUpdate",
  "storageUpload",
  "storageDownload",
  "storageRemove",
  "functionsInvoke",
  "crudDelete",
] as const;

export const SOAK_PERIODIC_OPERATIONS = ["authPasswordSignIn"] as const;

export type SoakEngine = "pglite" | "postgres";
export type SoakOperation =
  | (typeof SOAK_CYCLE_OPERATIONS)[number]
  | (typeof SOAK_PERIODIC_OPERATIONS)[number];

export interface SoakOperationSummary {
  count: number;
  totalDurationMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SoakMemorySummary {
  samples: number[];
  firstWindowMedianRssBytes: number;
  lastWindowMedianRssBytes: number;
  growthBytes: number;
  growthRatio: number;
  peakRssBytes: number;
  allowedGrowthBytes: number;
  allowedGrowthRatio: number;
  passed: boolean;
}

export interface SoakReport {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  engine: SoakEngine;
  git: GitReport;
  toolchain: {
    deno: string;
    v8: string;
    typescript: string;
  };
  runner: {
    id: string | null;
    gateEligible: boolean;
    hardwareFingerprint: string;
    hardware: HardwareReport;
  };
  configuration: {
    requestedDurationMs: number;
    minimumDurationMs: number;
    cycleIntervalMs: number;
    operationTimeoutMs: number;
    memorySampleIntervalMs: number;
    authEveryCycles: number;
    minimumCycles: number;
  };
  execution: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
    completedCycles: number;
    completedOperations: number;
    failures: Array<{ operation: string; cycle: number; message: string }>;
    finalReady: boolean;
    cleanupVerified: boolean;
  };
  operations: Record<SoakOperation, SoakOperationSummary>;
  memory: SoakMemorySummary;
  process: {
    exitSuccess: boolean;
    stderrBytes: number;
  };
}

export interface SoakValidationSummary {
  engine: SoakEngine;
  runnerId: string;
  sourceCommit: string;
  durationMs: number;
  completedCycles: number;
  completedOperations: number;
  memoryGrowthBytes: number;
  memoryGrowthRatio: number;
  peakRssBytes: number;
}

export function summarizeOperationSamples(samples: number[]): SoakOperationSummary {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Soak operation samples must contain finite non-negative values");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    totalDurationMs: round(sorted.reduce((total, value) => total + value, 0)),
    minMs: round(sorted[0]!),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1)!),
  };
}

export function summarizeSoakMemory(samples: number[]): SoakMemorySummary {
  if (
    samples.length < 4 ||
    samples.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("Soak memory evidence requires at least four positive integer samples");
  }
  const windowSize = Math.max(2, Math.floor(samples.length / 5));
  const first = median(samples.slice(0, windowSize));
  const last = median(samples.slice(-windowSize));
  const growthBytes = last - first;
  const growthRatio = growthBytes / first;
  return {
    samples: [...samples],
    firstWindowMedianRssBytes: first,
    lastWindowMedianRssBytes: last,
    growthBytes,
    growthRatio: round(growthRatio),
    peakRssBytes: Math.max(...samples),
    allowedGrowthBytes: SOAK_MEMORY_GROWTH_BYTES,
    allowedGrowthRatio: SOAK_MEMORY_GROWTH_RATIO,
    passed: growthBytes <= SOAK_MEMORY_GROWTH_BYTES || growthRatio <= SOAK_MEMORY_GROWTH_RATIO,
  };
}

export function validateSoakReport(
  report: SoakReport,
  expectedEngine?: SoakEngine,
): SoakValidationSummary {
  assert(report.schemaVersion === SOAK_SCHEMA_VERSION, "Soak schema version is invalid");
  assert(
    report.engine === "pglite" || report.engine === "postgres",
    "Soak engine is invalid",
  );
  if (expectedEngine !== undefined) {
    assert(report.engine === expectedEngine, `Expected ${expectedEngine} soak evidence`);
  }
  assert(/^[0-9a-f]{40}$/u.test(report.git.commit), "Soak source commit is invalid");
  assert(report.git.dirty === false, "Soak source checkout must be clean");
  assert(
    report.runner.id !== null && /^[A-Za-z0-9._-]{1,64}$/u.test(report.runner.id),
    "Soak runner id is invalid",
  );
  assert(report.runner.gateEligible, "Soak report is not gate eligible");
  assert(
    /^[0-9a-f]{64}$/u.test(report.runner.hardwareFingerprint),
    "Soak hardware fingerprint is invalid",
  );
  assert(report.toolchain.deno === Deno.version.deno, "Soak Deno version does not match");
  assert(
    report.configuration.minimumDurationMs === SOAK_MINIMUM_DURATION_MS,
    "Soak minimum duration policy is invalid",
  );
  assert(
    report.configuration.requestedDurationMs >= SOAK_MINIMUM_DURATION_MS,
    "Soak requested duration is below the minimum",
  );
  assert(
    report.execution.durationMs >= report.configuration.requestedDurationMs,
    "Soak execution ended before its requested duration",
  );
  assert(
    report.configuration.minimumCycles === SOAK_MINIMUM_CYCLES,
    "Soak minimum cycle policy is invalid",
  );
  assert(
    report.execution.completedCycles >= SOAK_MINIMUM_CYCLES,
    "Soak completed too few workload cycles",
  );
  assert(report.execution.failures.length === 0, "Soak report contains failures");
  assert(report.execution.finalReady, "Soak server was not ready at completion");
  assert(report.execution.cleanupVerified, "Soak cleanup verification failed");
  assert(report.process.exitSuccess, "Soak server did not exit successfully");
  assert(report.process.stderrBytes === 0, "Soak server leaked output to stderr");

  let operationCount = 0;
  for (const operation of SOAK_CYCLE_OPERATIONS) {
    const summary = report.operations[operation];
    assert(summary !== undefined, `Soak operation ${operation} is missing`);
    assert(
      summary.count === report.execution.completedCycles,
      `Soak operation ${operation} count does not match completed cycles`,
    );
    assert(
      summary.maxMs <= report.configuration.operationTimeoutMs * 1.1,
      `Soak operation ${operation} exceeded its timeout budget`,
    );
    operationCount += summary.count;
  }
  const expectedAuth = Math.floor(
    (report.execution.completedCycles - 1) /
      report.configuration.authEveryCycles,
  ) + 1;
  const auth = report.operations.authPasswordSignIn;
  assert(auth !== undefined, "Soak Auth operation is missing");
  assert(auth.count === expectedAuth, "Soak Auth operation count is invalid");
  assert(
    auth.maxMs <= report.configuration.operationTimeoutMs * 1.1,
    "Soak Auth operation exceeded its timeout budget",
  );
  operationCount += auth.count;
  assert(
    operationCount === report.execution.completedOperations,
    "Soak completed operation count is invalid",
  );

  const minimumMemorySamples = Math.max(
    4,
    Math.floor(report.execution.durationMs / report.configuration.memorySampleIntervalMs * 0.8),
  );
  assert(
    report.memory.samples.length >= minimumMemorySamples,
    "Soak memory sample coverage is incomplete",
  );
  const memory = summarizeSoakMemory(report.memory.samples);
  assert(
    memory.firstWindowMedianRssBytes === report.memory.firstWindowMedianRssBytes &&
      memory.lastWindowMedianRssBytes === report.memory.lastWindowMedianRssBytes &&
      memory.growthBytes === report.memory.growthBytes &&
      memory.growthRatio === report.memory.growthRatio &&
      memory.peakRssBytes === report.memory.peakRssBytes &&
      memory.passed === report.memory.passed,
    "Soak memory summary does not match raw samples",
  );
  assert(report.memory.passed, "Soak process-tree RSS growth exceeded both limits");

  return {
    engine: report.engine,
    runnerId: report.runner.id,
    sourceCommit: report.git.commit,
    durationMs: report.execution.durationMs,
    completedCycles: report.execution.completedCycles,
    completedOperations: report.execution.completedOperations,
    memoryGrowthBytes: report.memory.growthBytes,
    memoryGrowthRatio: report.memory.growthRatio,
    peakRssBytes: report.memory.peakRssBytes,
  };
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
