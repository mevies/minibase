import { assertEquals, assertThrows } from "@std/assert";
import {
  type BenchmarkReport,
  compareBenchmarkReports,
  measurement,
  nativePostgresBaseline,
  postgresDatabasePoolBenchmark,
} from "../scripts/benchmark_report.ts";

Deno.test("benchmark summaries retain raw samples and stable percentiles", () => {
  assertEquals(measurement([1, 2, 3, 4, 100], 200), {
    samplesMs: [1, 2, 3, 4, 100],
    summary: {
      count: 5,
      totalMs: 110,
      minMs: 1,
      meanMs: 22,
      p50Ms: 3,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
      throughputPerSecond: 25,
    },
  });
});

Deno.test("benchmark comparison rejects unpinned hardware and reports regressions", () => {
  const baseline = report();
  const current = report();
  current.runner.gateEligible = false;
  current.runner.id = null;
  assertThrows(
    () => compareBenchmarkReports(baseline, current),
    Error,
    "MINIBASE_BENCHMARK_RUNNER",
  );

  current.runner.gateEligible = true;
  current.runner.id = "fixed-windows-runner";
  current.startup.warmMs = 130;
  current.workloads.crudSelect = measurement([13, 13, 13]);
  current.concurrency[0]!.measurement = measurement([20, 20], 40);
  const comparison = compareBenchmarkReports(baseline, current);
  assertEquals(
    comparison.regressions.map((regression) => regression.metric),
    [
      "startup.warmMs",
      "workloads.crudSelect.p95Ms",
      "concurrency.1.p95Ms",
      "concurrency.1.throughputPerSecond",
    ],
  );
});

Deno.test("PostgreSQL pool evidence preserves samples and rejects an exceeded maximum", () => {
  assertEquals(
    postgresDatabasePoolBenchmark(2, 4, [
      { concurrency: 1, samples: [2, 2] },
      { concurrency: 10, samples: [2, 4, 4] },
    ]),
    {
      applicable: true,
      configuredMin: 2,
      configuredMax: 4,
      observations: [
        { concurrency: 1, samples: [2, 2], maxObservedConnections: 2 },
        { concurrency: 10, samples: [2, 4, 4], maxObservedConnections: 4 },
      ],
      maxObservedConnections: 4,
      withinConfiguredMax: true,
    },
  );
  assertThrows(
    () => postgresDatabasePoolBenchmark(2, 4, [{ concurrency: 100, samples: [4, 5] }]),
    Error,
    "exceeding configured maximum 4",
  );
});

Deno.test("benchmark comparison requires matching PostgreSQL pool configuration", () => {
  const baseline = report("postgres");
  const current = report("postgres");
  current.databasePool = postgresDatabasePoolBenchmark(2, 8, [
    { concurrency: 1, samples: [2] },
  ]);
  assertThrows(
    () => compareBenchmarkReports(baseline, current),
    Error,
    "pool configurations do not match",
  );
});

Deno.test("benchmark comparison rejects legacy schemas before reading schema 3 evidence", () => {
  const legacy = { ...report(), schemaVersion: 2 } as unknown as BenchmarkReport;
  assertThrows(
    () => compareBenchmarkReports(legacy, legacy),
    Error,
    "Benchmark schema version 3 is required; received baseline=2 current=2",
  );
});

Deno.test("native PostgreSQL baseline is retained and compared beside HTTP RLS", () => {
  const direct = nativePostgresBaseline(
    8,
    measurement([1, 2, 3]),
    [{ concurrency: 1, measurement: measurement([1, 2], 3) }],
    [{ concurrency: 1, samples: [1, 8] }],
  );
  assertEquals(direct, {
    applicable: true,
    driver: "postgres.js",
    applicationName: "minibase-benchmark-direct",
    mode: "warm-pool-authenticated-rls",
    configuredMax: 8,
    observations: [{ concurrency: 1, samples: [1, 8], maxObservedConnections: 8 }],
    maxObservedConnections: 8,
    withinConfiguredMax: true,
    rlsSelect: measurement([1, 2, 3]),
    concurrency: [{ concurrency: 1, measurement: measurement([1, 2], 3) }],
  });

  const baseline = report("postgres");
  const current = report("postgres");
  if (!current.nativePostgres.applicable) throw new Error("expected direct baseline");
  current.nativePostgres.rlsSelect = measurement([13, 13, 13]);
  current.nativePostgres.concurrency[0]!.measurement = measurement([20, 20], 40);
  const comparison = compareBenchmarkReports(baseline, current);
  assertEquals(
    comparison.regressions.map((regression) => regression.metric),
    [
      "nativePostgres.rlsSelect.p95Ms",
      "nativePostgres.concurrency.1.p95Ms",
      "nativePostgres.concurrency.1.throughputPerSecond",
    ],
  );
});

function report(engine: BenchmarkReport["engine"] = "pglite"): BenchmarkReport {
  return {
    schemaVersion: 3,
    engine,
    runner: {
      id: "fixed-windows-runner",
      gateEligible: true,
      hardwareFingerprint: "hardware-a",
    },
    artifact: { bytes: 100 },
    startup: { coldMs: 100, warmMs: 100 },
    memory: { idleMedianRssBytes: 100, peakRssBytes: 100 },
    functionStartup: {
      coldDependencyCacheMs: 100,
      warmDependencyCacheMs: 100,
      typeCheckMs: 100,
      workerReadyMs: 100,
    },
    databasePool: engine === "postgres"
      ? postgresDatabasePoolBenchmark(2, 4, [{ concurrency: 1, samples: [2, 4] }])
      : { applicable: false, reason: "pglite-does-not-use-postgres-connections" },
    nativePostgres: engine === "postgres"
      ? nativePostgresBaseline(
        4,
        measurement([10, 10, 10]),
        [{ concurrency: 1, measurement: measurement([10, 10], 20) }],
        [{ concurrency: 1, samples: [2, 4] }],
      )
      : { applicable: false, reason: "pglite-has-no-postgres-wire-protocol" },
    workloads: { crudSelect: measurement([10, 10, 10]) },
    concurrency: [{ concurrency: 1, measurement: measurement([10, 10], 20) }],
  };
}
