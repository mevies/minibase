export interface DistributionSummary {
  count: number;
  totalMs: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  throughputPerSecond: number;
}

export interface LatencyMeasurement {
  samplesMs: number[];
  summary: DistributionSummary;
}

export interface BenchmarkRunner {
  id: string | null;
  gateEligible: boolean;
  hardwareFingerprint: string;
}

export interface PostgresConnectionObservation {
  concurrency: number;
  samples: number[];
  maxObservedConnections: number;
}

export type DatabasePoolBenchmark =
  | {
    applicable: false;
    reason: "pglite-does-not-use-postgres-connections";
  }
  | {
    applicable: true;
    configuredMin: number;
    configuredMax: number;
    observations: PostgresConnectionObservation[];
    maxObservedConnections: number;
    withinConfiguredMax: true;
  };

export type NativePostgresBaseline =
  | {
    applicable: false;
    reason: "pglite-has-no-postgres-wire-protocol";
  }
  | {
    applicable: true;
    driver: "postgres.js";
    applicationName: "minibase-benchmark-direct";
    mode: "warm-pool-authenticated-rls";
    configuredMax: number;
    observations: PostgresConnectionObservation[];
    maxObservedConnections: number;
    withinConfiguredMax: true;
    rlsSelect: LatencyMeasurement;
    concurrency: Array<{
      concurrency: number;
      measurement: LatencyMeasurement;
    }>;
  };

export interface BenchmarkReport {
  schemaVersion: 3;
  engine: "pglite" | "postgres";
  runner: BenchmarkRunner;
  artifact: {
    bytes: number;
  };
  startup: {
    coldMs: number;
    warmMs: number;
  };
  memory: {
    idleMedianRssBytes: number;
    peakRssBytes: number;
  };
  functionStartup: {
    coldDependencyCacheMs: number;
    warmDependencyCacheMs: number;
    typeCheckMs: number;
    workerReadyMs: number;
  };
  databasePool: DatabasePoolBenchmark;
  nativePostgres: NativePostgresBaseline;
  workloads: Record<string, LatencyMeasurement>;
  concurrency: Array<{
    concurrency: number;
    measurement: LatencyMeasurement;
  }>;
}

export function nativePostgresBaseline(
  configuredMax: number,
  rlsSelect: LatencyMeasurement,
  concurrency: Array<{ concurrency: number; measurement: LatencyMeasurement }>,
  observations: Array<{ concurrency: number; samples: number[] }>,
): NativePostgresBaseline & { applicable: true } {
  if (!Number.isInteger(configuredMax) || configuredMax < 1) {
    throw new Error("Native PostgreSQL benchmark pool maximum must be a positive integer");
  }
  if (concurrency.length === 0) {
    throw new Error("Native PostgreSQL benchmark requires concurrency measurements");
  }
  const levels = new Set<number>();
  for (const entry of concurrency) {
    if (!Number.isInteger(entry.concurrency) || entry.concurrency < 1) {
      throw new Error("Native PostgreSQL benchmark concurrency levels must be positive integers");
    }
    if (levels.has(entry.concurrency)) {
      throw new Error(`Duplicate native PostgreSQL concurrency level: ${entry.concurrency}`);
    }
    levels.add(entry.concurrency);
  }
  const pool = postgresDatabasePoolBenchmark(0, configuredMax, observations);
  if (
    concurrency.length !== pool.observations.length ||
    concurrency.some((entry, index) => pool.observations[index]?.concurrency !== entry.concurrency)
  ) {
    throw new Error(
      "Native PostgreSQL connection observations must match concurrency measurements",
    );
  }
  return {
    applicable: true,
    driver: "postgres.js",
    applicationName: "minibase-benchmark-direct",
    mode: "warm-pool-authenticated-rls",
    configuredMax,
    observations: pool.observations,
    maxObservedConnections: pool.maxObservedConnections,
    withinConfiguredMax: true,
    rlsSelect,
    concurrency: concurrency.map((entry) => ({
      concurrency: entry.concurrency,
      measurement: entry.measurement,
    })),
  };
}

export function postgresDatabasePoolBenchmark(
  configuredMin: number,
  configuredMax: number,
  observations: Array<{ concurrency: number; samples: number[] }>,
): DatabasePoolBenchmark & { applicable: true } {
  if (!Number.isInteger(configuredMin) || configuredMin < 0) {
    throw new Error("PostgreSQL benchmark pool minimum must be a non-negative integer");
  }
  if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMin > configuredMax) {
    throw new Error("PostgreSQL benchmark pool maximum must be a positive integer at least min");
  }
  if (observations.length === 0) {
    throw new Error("PostgreSQL benchmark requires connection observations");
  }
  const normalized = observations.map((observation) => {
    if (!Number.isInteger(observation.concurrency) || observation.concurrency < 1) {
      throw new Error("PostgreSQL connection observations require positive concurrency levels");
    }
    if (
      observation.samples.length === 0 ||
      !observation.samples.every((sample) => Number.isInteger(sample) && sample >= 0)
    ) {
      throw new Error(
        "PostgreSQL connection observations require non-empty non-negative integer samples",
      );
    }
    return {
      concurrency: observation.concurrency,
      samples: [...observation.samples],
      maxObservedConnections: Math.max(...observation.samples),
    };
  });
  const maxObservedConnections = Math.max(
    0,
    ...normalized.map((observation) => observation.maxObservedConnections),
  );
  if (maxObservedConnections > configuredMax) {
    throw new Error(
      `PostgreSQL benchmark observed ${maxObservedConnections} Minibase connections, ` +
        `exceeding configured maximum ${configuredMax}`,
    );
  }
  return {
    applicable: true,
    configuredMin,
    configuredMax,
    observations: normalized,
    maxObservedConnections,
    withinConfiguredMax: true,
  };
}

export interface BenchmarkRegression {
  metric: string;
  baseline: number;
  current: number;
  changeRatio: number;
  allowedRatio: number;
  direction: "lower-is-better" | "higher-is-better";
}

export interface BenchmarkComparison {
  comparable: boolean;
  regressions: BenchmarkRegression[];
  checkedMetrics: number;
}

export function measurement(samplesMs: number[], elapsedMs?: number): LatencyMeasurement {
  return {
    samplesMs: samplesMs.map(round),
    summary: summarize(samplesMs, elapsedMs),
  };
}

export function summarize(samplesMs: number[], elapsedMs = sum(samplesMs)): DistributionSummary {
  if (samplesMs.length === 0) throw new Error("Benchmark samples must not be empty");
  if (!samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)) {
    throw new Error("Benchmark samples must contain only finite non-negative durations");
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error("Benchmark elapsed time must be a positive finite duration");
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const totalMs = sum(samplesMs);
  return {
    count: samplesMs.length,
    totalMs: round(totalMs),
    minMs: round(sorted[0]!),
    meanMs: round(totalMs / samplesMs.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1)!),
    throughputPerSecond: round(samplesMs.length * 1_000 / elapsedMs),
  };
}

export function compareBenchmarkReports(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
  options: { allowUnpinnedHardware?: boolean } = {},
): BenchmarkComparison {
  assertComparable(baseline, current, options.allowUnpinnedHardware === true);
  const regressions: BenchmarkRegression[] = [];
  let checkedMetrics = 0;
  const lower = (metric: string, previous: number, next: number, allowedRatio: number) => {
    checkedMetrics++;
    if (next <= previous * (1 + allowedRatio)) return;
    regressions.push({
      metric,
      baseline: previous,
      current: next,
      changeRatio: round(next / previous - 1),
      allowedRatio,
      direction: "lower-is-better",
    });
  };
  const higher = (metric: string, previous: number, next: number, allowedRatio: number) => {
    checkedMetrics++;
    if (next >= previous * (1 - allowedRatio)) return;
    regressions.push({
      metric,
      baseline: previous,
      current: next,
      changeRatio: round(next / previous - 1),
      allowedRatio,
      direction: "higher-is-better",
    });
  };

  lower("artifact.bytes", baseline.artifact.bytes, current.artifact.bytes, 0.1);
  lower("startup.coldMs", baseline.startup.coldMs, current.startup.coldMs, 0.2);
  lower("startup.warmMs", baseline.startup.warmMs, current.startup.warmMs, 0.2);
  lower(
    "memory.idleMedianRssBytes",
    baseline.memory.idleMedianRssBytes,
    current.memory.idleMedianRssBytes,
    0.15,
  );
  lower("memory.peakRssBytes", baseline.memory.peakRssBytes, current.memory.peakRssBytes, 0.15);
  for (
    const phase of [
      "coldDependencyCacheMs",
      "warmDependencyCacheMs",
      "typeCheckMs",
      "workerReadyMs",
    ] as const
  ) {
    lower(
      `functionStartup.${phase}`,
      baseline.functionStartup[phase],
      current.functionStartup[phase],
      0.2,
    );
  }

  const workloadNames = Object.keys(baseline.workloads).sort();
  if (workloadNames.join("\n") !== Object.keys(current.workloads).sort().join("\n")) {
    throw new Error("Benchmark workload sets do not match");
  }
  for (const name of workloadNames) {
    lower(
      `workloads.${name}.p95Ms`,
      baseline.workloads[name]!.summary.p95Ms,
      current.workloads[name]!.summary.p95Ms,
      0.2,
    );
  }

  if (baseline.concurrency.length !== current.concurrency.length) {
    throw new Error("Benchmark concurrency sets do not match");
  }
  for (let index = 0; index < baseline.concurrency.length; index++) {
    const previous = baseline.concurrency[index]!;
    const next = current.concurrency[index]!;
    if (previous.concurrency !== next.concurrency) {
      throw new Error("Benchmark concurrency levels do not match");
    }
    lower(
      `concurrency.${previous.concurrency}.p95Ms`,
      previous.measurement.summary.p95Ms,
      next.measurement.summary.p95Ms,
      0.2,
    );
    higher(
      `concurrency.${previous.concurrency}.throughputPerSecond`,
      previous.measurement.summary.throughputPerSecond,
      next.measurement.summary.throughputPerSecond,
      0.15,
    );
  }

  if (baseline.nativePostgres.applicable && current.nativePostgres.applicable) {
    lower(
      "nativePostgres.rlsSelect.p95Ms",
      baseline.nativePostgres.rlsSelect.summary.p95Ms,
      current.nativePostgres.rlsSelect.summary.p95Ms,
      0.2,
    );
    for (let index = 0; index < baseline.nativePostgres.concurrency.length; index++) {
      const previous = baseline.nativePostgres.concurrency[index]!;
      const next = current.nativePostgres.concurrency[index]!;
      lower(
        `nativePostgres.concurrency.${previous.concurrency}.p95Ms`,
        previous.measurement.summary.p95Ms,
        next.measurement.summary.p95Ms,
        0.2,
      );
      higher(
        `nativePostgres.concurrency.${previous.concurrency}.throughputPerSecond`,
        previous.measurement.summary.throughputPerSecond,
        next.measurement.summary.throughputPerSecond,
        0.15,
      );
    }
  }

  return { comparable: true, regressions, checkedMetrics };
}

function assertComparable(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
  allowUnpinnedHardware: boolean,
): void {
  const baselineSchema = (baseline as { schemaVersion?: unknown }).schemaVersion;
  const currentSchema = (current as { schemaVersion?: unknown }).schemaVersion;
  if (baselineSchema !== 3 || currentSchema !== 3) {
    throw new Error(
      `Benchmark schema version 3 is required; received baseline=${String(baselineSchema)} ` +
        `current=${String(currentSchema)}`,
    );
  }
  if (baseline.engine !== current.engine) {
    throw new Error("Benchmark engines do not match");
  }
  assertDatabasePoolEvidence(baseline);
  assertDatabasePoolEvidence(current);
  assertNativePostgresEvidence(baseline);
  assertNativePostgresEvidence(current);
  if (baseline.databasePool.applicable !== current.databasePool.applicable) {
    throw new Error("Benchmark database pool evidence does not match");
  }
  if (baseline.databasePool.applicable && current.databasePool.applicable) {
    if (
      baseline.databasePool.configuredMin !== current.databasePool.configuredMin ||
      baseline.databasePool.configuredMax !== current.databasePool.configuredMax
    ) {
      throw new Error("Benchmark PostgreSQL pool configurations do not match");
    }
  }
  if (baseline.nativePostgres.applicable !== current.nativePostgres.applicable) {
    throw new Error("Benchmark native PostgreSQL evidence does not match");
  }
  if (baseline.nativePostgres.applicable && current.nativePostgres.applicable) {
    if (baseline.nativePostgres.configuredMax !== current.nativePostgres.configuredMax) {
      throw new Error("Benchmark native PostgreSQL pool configurations do not match");
    }
  }
  if (baseline.runner.hardwareFingerprint !== current.runner.hardwareFingerprint) {
    throw new Error("Benchmark hardware fingerprints do not match");
  }
  if (!allowUnpinnedHardware) {
    if (!baseline.runner.gateEligible || !current.runner.gateEligible) {
      throw new Error(
        "Benchmark reports require MINIBASE_BENCHMARK_RUNNER before they can gate regressions",
      );
    }
    if (baseline.runner.id !== current.runner.id) {
      throw new Error("Benchmark runner ids do not match");
    }
  }
}

function assertNativePostgresEvidence(report: BenchmarkReport): void {
  if (report.engine === "pglite") {
    if (report.nativePostgres.applicable) {
      throw new Error("PGlite benchmark reports must not contain native PostgreSQL evidence");
    }
    return;
  }
  if (!report.nativePostgres.applicable) {
    throw new Error("PostgreSQL benchmark reports require a native PostgreSQL baseline");
  }
  const direct = report.nativePostgres;
  if (
    direct.driver !== "postgres.js" || direct.applicationName !== "minibase-benchmark-direct" ||
    direct.mode !== "warm-pool-authenticated-rls" ||
    !Number.isInteger(direct.configuredMax) || direct.configuredMax < 1 ||
    !direct.withinConfiguredMax || direct.maxObservedConnections > direct.configuredMax
  ) {
    throw new Error("Native PostgreSQL benchmark metadata is invalid");
  }
  const httpLevels = report.concurrency.map((entry) => entry.concurrency);
  const directLevels = direct.concurrency.map((entry) => entry.concurrency);
  if (
    httpLevels.length !== directLevels.length ||
    httpLevels.some((level, index) => directLevels[index] !== level)
  ) {
    throw new Error("Native PostgreSQL concurrency levels do not match the HTTP benchmark");
  }
  const observedLevels = direct.observations.map((entry) => entry.concurrency);
  const observedMaximum = Math.max(
    0,
    ...direct.observations.flatMap((observation) => observation.samples),
  );
  if (
    directLevels.length !== observedLevels.length ||
    directLevels.some((level, index) => observedLevels[index] !== level) ||
    direct.observations.some((observation) =>
      observation.samples.length === 0 ||
      observation.maxObservedConnections !== Math.max(...observation.samples)
    ) || observedMaximum !== direct.maxObservedConnections
  ) {
    throw new Error("Native PostgreSQL connection evidence is inconsistent");
  }
}

function assertDatabasePoolEvidence(report: BenchmarkReport): void {
  if (report.engine === "pglite") {
    if (report.databasePool.applicable) {
      throw new Error("PGlite benchmark reports must not contain PostgreSQL pool evidence");
    }
    return;
  }
  if (!report.databasePool.applicable) {
    throw new Error("PostgreSQL benchmark reports require database pool evidence");
  }
  const pool = report.databasePool;
  if (!pool.withinConfiguredMax || pool.maxObservedConnections > pool.configuredMax) {
    throw new Error("PostgreSQL benchmark report exceeds its configured pool maximum");
  }
  const concurrencyLevels = report.concurrency.map((entry) => entry.concurrency);
  if (
    concurrencyLevels.length !== pool.observations.length ||
    concurrencyLevels.some((level, index) => pool.observations[index]?.concurrency !== level)
  ) {
    throw new Error("PostgreSQL pool observations do not match benchmark concurrency levels");
  }
  const observedMaximum = Math.max(
    0,
    ...pool.observations.flatMap((observation) => observation.samples),
  );
  if (
    pool.observations.some((observation) =>
      observation.samples.length === 0 ||
      observation.maxObservedConnections !== Math.max(...observation.samples)
    ) || observedMaximum !== pool.maxObservedConnections
  ) {
    throw new Error("PostgreSQL pool observation summary is inconsistent with its raw samples");
  }
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
