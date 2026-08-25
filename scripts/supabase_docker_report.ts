import type { BenchmarkReport, LatencyMeasurement } from "./benchmark_report.ts";
import type { GitReport, HardwareReport } from "./benchmark.ts";

export const SUPABASE_DOCKER_REPORT_SCHEMA = 1;
export const SUPABASE_COMPARISON_SCHEMA = 1;
export const SIGNIFICANT_ADVANTAGE_RATIO = 0.7;
export const REQUIRED_ADVANTAGES = 2;

const SIMPLE_REQUEST_WORKLOADS = [
  "crudInsert",
  "crudSelectSingle",
  "crudSelectList",
  "crudUpdate",
  "crudDelete",
  "rlsSelect",
] as const;

export interface SupabaseDockerContainer {
  role: string;
  name: string;
  image: string;
  imageId: string;
  repoDigests: string[];
}

export interface SupabaseDockerReport {
  schemaVersion: typeof SUPABASE_DOCKER_REPORT_SCHEMA;
  kind: "supabase-docker";
  runId: string;
  recordedAt: string;
  git: GitReport;
  runner: {
    id: string | null;
    gateEligible: boolean;
    hardwareFingerprint: string;
    hardware: HardwareReport;
  };
  fixture: {
    path: "fixtures/supabase-basic";
    sha256: string;
  };
  configuration: {
    iterations: number;
    warmups: number;
    concurrencyRequests: number;
    concurrencyLevels: number[];
    excludedServices: string[];
    memorySampleIntervalMs: number;
  };
  toolchain: {
    deno: string;
    supabaseCli: string;
    supabaseCliArchiveSha256: string;
    dockerDesktop: string;
    dockerEngine: string;
    dockerApi: string;
    dockerCompose: string;
  };
  stack: {
    memoryScope: "sum-of-running-container-working-sets";
    containers: SupabaseDockerContainer[];
  };
  startup: {
    coldMs: number;
    warmMs: number;
  };
  memory: {
    idleMedianContainerBytes: number;
    idleContainerBytes: number[];
  };
  workloads: Record<string, LatencyMeasurement>;
  concurrency: BenchmarkReport["concurrency"];
}

export interface ComparableMinibaseReport extends BenchmarkReport {
  git: GitReport;
  runner: BenchmarkReport["runner"] & { hardware: HardwareReport };
  configuration: {
    iterations: number;
    warmups: number;
    concurrencyRequests: number;
    concurrencyLevels: number[];
  };
}

export interface ComparisonMetric {
  minibase: number;
  supabase: number;
  ratio: number;
  improvementPercent: number;
  significant: boolean;
}

export interface SupabaseComparisonReport {
  schemaVersion: typeof SUPABASE_COMPARISON_SCHEMA;
  kind: "minibase-supabase-docker-comparison";
  generatedAt: string;
  sourceCommit: string;
  runnerId: string;
  hardwareFingerprint: string;
  thresholdRatio: typeof SIGNIFICANT_ADVANTAGE_RATIO;
  requiredAdvantages: typeof REQUIRED_ADVANTAGES;
  significantAdvantages: number;
  passed: boolean;
  metrics: {
    warmStartup: ComparisonMetric;
    idleMemory: ComparisonMetric;
    simpleRequestP95Median: ComparisonMetric & {
      workloads: Array<{
        name: string;
        minibaseP95Ms: number;
        supabaseP95Ms: number;
      }>;
    };
  };
}

export function compareSupabaseDocker(
  minibase: ComparableMinibaseReport,
  supabase: SupabaseDockerReport,
  generatedAt = new Date().toISOString(),
): SupabaseComparisonReport {
  validateComparableReports(minibase, supabase);
  const workloadRows = SIMPLE_REQUEST_WORKLOADS.map((name) => ({
    name,
    minibaseP95Ms: requiredWorkload(minibase.workloads, name).summary.p95Ms,
    supabaseP95Ms: requiredWorkload(supabase.workloads, name).summary.p95Ms,
  }));
  const warmStartup = comparisonMetric(minibase.startup.warmMs, supabase.startup.warmMs);
  const idleMemory = comparisonMetric(
    minibase.memory.idleMedianRssBytes,
    supabase.memory.idleMedianContainerBytes,
  );
  const simpleRequestP95Median = {
    ...comparisonMetric(
      median(workloadRows.map((entry) => entry.minibaseP95Ms)),
      median(workloadRows.map((entry) => entry.supabaseP95Ms)),
    ),
    workloads: workloadRows,
  };
  const significantAdvantages =
    [warmStartup, idleMemory, simpleRequestP95Median].filter((metric) => metric.significant).length;
  return {
    schemaVersion: SUPABASE_COMPARISON_SCHEMA,
    kind: "minibase-supabase-docker-comparison",
    generatedAt,
    sourceCommit: minibase.git.commit,
    runnerId: minibase.runner.id!,
    hardwareFingerprint: minibase.runner.hardwareFingerprint,
    thresholdRatio: SIGNIFICANT_ADVANTAGE_RATIO,
    requiredAdvantages: REQUIRED_ADVANTAGES,
    significantAdvantages,
    passed: significantAdvantages >= REQUIRED_ADVANTAGES,
    metrics: { warmStartup, idleMemory, simpleRequestP95Median },
  };
}

export function parseDockerMemoryBytes(value: string): number {
  const used = value.split("/")[0]?.trim() ?? "";
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/iu.exec(used);
  if (match === null) throw new Error(`Unsupported Docker memory value: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = new Map<string, number>([
    ["b", 1],
    ["kb", 1_000],
    ["mb", 1_000_000],
    ["gb", 1_000_000_000],
    ["tb", 1_000_000_000_000],
    ["kib", 1_024],
    ["mib", 1_024 ** 2],
    ["gib", 1_024 ** 3],
    ["tib", 1_024 ** 4],
  ]).get(unit);
  if (multiplier === undefined || !Number.isFinite(amount)) {
    throw new Error(`Unsupported Docker memory value: ${value}`);
  }
  return Math.round(amount * multiplier);
}

function validateComparableReports(
  minibase: ComparableMinibaseReport,
  supabase: SupabaseDockerReport,
): void {
  if (minibase.schemaVersion !== 3 || minibase.engine !== "pglite") {
    throw new Error("Supabase Docker comparison requires a schema 3 PGlite benchmark");
  }
  if (
    supabase.schemaVersion !== SUPABASE_DOCKER_REPORT_SCHEMA ||
    supabase.kind !== "supabase-docker"
  ) {
    throw new Error("Supabase Docker comparison requires a schema 1 Supabase report");
  }
  if (minibase.git.dirty || supabase.git.dirty) {
    throw new Error("Supabase Docker comparison requires clean Git worktrees");
  }
  if (minibase.git.commit !== supabase.git.commit) {
    throw new Error("Minibase and Supabase reports must reference the same source commit");
  }
  if (!minibase.runner.gateEligible || !supabase.runner.gateEligible) {
    throw new Error("Supabase Docker comparison requires fixed-runner eligible reports");
  }
  if (
    minibase.runner.id === null || minibase.runner.id !== supabase.runner.id ||
    minibase.runner.hardwareFingerprint !== supabase.runner.hardwareFingerprint
  ) {
    throw new Error("Minibase and Supabase reports must use the same fixed runner and hardware");
  }
  if (
    supabase.fixture.path !== "fixtures/supabase-basic" ||
    !/^[0-9a-f]{64}$/u.test(supabase.fixture.sha256)
  ) {
    throw new Error("Supabase Docker report fixture metadata is invalid");
  }
  for (const key of ["iterations", "warmups", "concurrencyRequests"] as const) {
    if (minibase.configuration[key] !== supabase.configuration[key]) {
      throw new Error(`Minibase and Supabase benchmark ${key} must match`);
    }
  }
  if (
    JSON.stringify(minibase.configuration.concurrencyLevels) !==
      JSON.stringify(supabase.configuration.concurrencyLevels)
  ) {
    throw new Error("Minibase and Supabase concurrency levels must match");
  }
  if (supabase.stack.containers.length === 0 || supabase.memory.idleContainerBytes.length === 0) {
    throw new Error("Supabase Docker report must contain stack and memory evidence");
  }
}

function comparisonMetric(minibase: number, supabase: number): ComparisonMetric {
  if (!Number.isFinite(minibase) || minibase < 0 || !Number.isFinite(supabase) || supabase <= 0) {
    throw new Error(
      "Comparison metrics must contain finite non-negative Minibase and positive Supabase values",
    );
  }
  const ratio = minibase / supabase;
  return {
    minibase: round(minibase),
    supabase: round(supabase),
    ratio: round(ratio),
    improvementPercent: round((1 - ratio) * 100),
    significant: ratio <= SIGNIFICANT_ADVANTAGE_RATIO,
  };
}

function requiredWorkload(
  workloads: Record<string, LatencyMeasurement>,
  name: string,
): LatencyMeasurement {
  const workload = workloads[name];
  if (workload === undefined) throw new Error(`Benchmark report is missing ${name}`);
  return workload;
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate an empty median");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
