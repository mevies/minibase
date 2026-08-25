import { assertEquals, assertThrows } from "@std/assert";
import { measurement } from "../scripts/benchmark_report.ts";
import {
  type ComparableMinibaseReport,
  compareSupabaseDocker,
  parseDockerMemoryBytes,
  type SupabaseDockerReport,
} from "../scripts/supabase_docker_report.ts";

Deno.test("Docker memory parsing accepts binary and decimal units", () => {
  assertEquals(parseDockerMemoryBytes("512MiB / 16GiB"), 512 * 1_024 ** 2);
  assertEquals(parseDockerMemoryBytes("1.5 GB / 16 GB"), 1_500_000_000);
  assertThrows(() => parseDockerMemoryBytes("unavailable"));
});

Deno.test("Supabase comparison requires two material same-runner advantages", () => {
  const minibase = minibaseReport();
  const supabase = supabaseReport();
  const comparison = compareSupabaseDocker(minibase, supabase, "2026-08-05T00:00:00Z");
  assertEquals(comparison.significantAdvantages, 3);
  assertEquals(comparison.passed, true);
  assertEquals(comparison.metrics.warmStartup.ratio, 0.5);
  assertEquals(comparison.metrics.simpleRequestP95Median.workloads.length, 6);

  supabase.git.commit = "b".repeat(40);
  assertThrows(
    () => compareSupabaseDocker(minibase, supabase),
    Error,
    "same source commit",
  );
});

function minibaseReport(): ComparableMinibaseReport {
  const workloads = workloadMap(4);
  return {
    schemaVersion: 3,
    engine: "pglite",
    git: { commit: "a".repeat(40), dirty: false },
    runner: {
      id: "fixed-runner",
      gateEligible: true,
      hardwareFingerprint: "c".repeat(64),
      hardware: hardware(),
    },
    configuration: {
      iterations: 20,
      warmups: 5,
      concurrencyRequests: 100,
      concurrencyLevels: [1, 10, 50, 100],
    },
    artifact: { bytes: 100 },
    startup: { coldMs: 2_000, warmMs: 500 },
    memory: { idleMedianRssBytes: 200, peakRssBytes: 300 },
    functionStartup: {
      coldDependencyCacheMs: 1,
      warmDependencyCacheMs: 1,
      typeCheckMs: 1,
      workerReadyMs: 1,
    },
    databasePool: { applicable: false, reason: "pglite-does-not-use-postgres-connections" },
    nativePostgres: { applicable: false, reason: "pglite-has-no-postgres-wire-protocol" },
    workloads,
    concurrency: concurrency(),
  };
}

function supabaseReport(): SupabaseDockerReport {
  return {
    schemaVersion: 1,
    kind: "supabase-docker",
    runId: "run",
    recordedAt: "2026-08-05T00:00:00Z",
    git: { commit: "a".repeat(40), dirty: false },
    runner: {
      id: "fixed-runner",
      gateEligible: true,
      hardwareFingerprint: "c".repeat(64),
      hardware: hardware(),
    },
    fixture: { path: "fixtures/supabase-basic", sha256: "d".repeat(64) },
    configuration: {
      iterations: 20,
      warmups: 5,
      concurrencyRequests: 100,
      concurrencyLevels: [1, 10, 50, 100],
      excludedServices: [],
      memorySampleIntervalMs: 100,
    },
    toolchain: {
      deno: "2.9.2",
      supabaseCli: "2.110.0",
      supabaseCliArchiveSha256: "e".repeat(64),
      dockerDesktop: "Docker Desktop 4.43.2",
      dockerEngine: "28.3.2",
      dockerApi: "1.51",
      dockerCompose: "2.38.2",
    },
    stack: {
      memoryScope: "sum-of-running-container-working-sets",
      containers: [{
        role: "db",
        name: "supabase_db_fixture",
        image: "postgres",
        imageId: `sha256:${"f".repeat(64)}`,
        repoDigests: [`postgres@sha256:${"1".repeat(64)}`],
      }],
    },
    startup: { coldMs: 10_000, warmMs: 1_000 },
    memory: { idleMedianContainerBytes: 400, idleContainerBytes: [400] },
    workloads: workloadMap(8),
    concurrency: concurrency(),
  };
}

function workloadMap(p95: number) {
  return Object.fromEntries([
    "crudInsert",
    "crudSelectSingle",
    "crudSelectList",
    "crudUpdate",
    "crudDelete",
    "rlsSelect",
  ].map((name) => [name, measurement([p95], p95)]));
}

function concurrency() {
  return [1, 10, 50, 100].map((level) => ({
    concurrency: level,
    measurement: measurement([1], 1),
  }));
}

function hardware() {
  return {
    os: "windows",
    osRelease: "fixture",
    arch: "x86_64",
    cpuModel: "fixture",
    logicalCpus: 16,
    totalMemoryBytes: 32_000_000_000,
    powerSource: "unknown" as const,
  };
}
