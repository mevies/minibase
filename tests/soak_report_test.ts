import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  createSoakEvidenceManifest,
  validateSoakEvidenceDirectory,
} from "../scripts/soak_evidence.ts";
import {
  SOAK_CYCLE_OPERATIONS,
  SOAK_MINIMUM_CYCLES,
  SOAK_MINIMUM_DURATION_MS,
  SOAK_PERIODIC_OPERATIONS,
  type SoakOperation,
  type SoakReport,
  summarizeOperationSamples,
  summarizeSoakMemory,
  validateSoakReport,
} from "../scripts/soak_report.ts";

Deno.test("soak reports enforce duration, workload, memory and process gates", () => {
  const report = validReport("pglite");
  const summary = validateSoakReport(report, "pglite");
  assertEquals(summary.completedCycles, SOAK_MINIMUM_CYCLES);
  assertEquals(summary.memoryGrowthBytes > 0, true);

  const leaking = structuredClone(report);
  leaking.memory = summarizeSoakMemory([
    ...Array.from({ length: 12 }, () => 100 * 1_024 * 1_024),
    ...Array.from({ length: 48 }, (_, index) => (120 + index * 3) * 1_024 * 1_024),
  ]);
  assertThrows(() => validateSoakReport(leaking), Error, "RSS growth exceeded both limits");

  const dirty = structuredClone(report);
  dirty.git.dirty = true;
  assertThrows(() => validateSoakReport(dirty), Error, "checkout must be clean");
});

Deno.test("paired soak evidence verifies checksums and shared runner identity", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-soak-evidence-test-" });
  try {
    const pglitePath = join(root, "source-pglite.json");
    const postgresPath = join(root, "source-postgres.json");
    await writeReport(pglitePath, validReport("pglite"));
    await writeReport(postgresPath, validReport("postgres"));
    const evidence = join(root, "evidence");
    await Deno.mkdir(evidence);
    await Deno.copyFile(pglitePath, join(evidence, "pglite.json"));
    await Deno.copyFile(postgresPath, join(evidence, "postgres.json"));
    await Deno.writeTextFile(
      join(evidence, "evidence.json"),
      JSON.stringify(await createSoakEvidenceManifest(pglitePath, postgresPath), null, 2) + "\n",
    );
    const summary = await validateSoakEvidenceDirectory(evidence);
    assertEquals(summary.runnerId, "fixed-soak-test");
    assertEquals(summary.pglite.engine, "pglite");
    assertEquals(summary.postgres.engine, "postgres");

    await Deno.writeTextFile(join(evidence, "pglite.json"), "{}\n");
    await assertRejects(
      () => validateSoakEvidenceDirectory(evidence),
      Error,
      "checksum does not match",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function validReport(engine: "pglite" | "postgres"): SoakReport {
  const cycles = SOAK_MINIMUM_CYCLES;
  const authEveryCycles = 60;
  const authCount = Math.floor((cycles - 1) / authEveryCycles) + 1;
  const operationEntries: Array<[SoakOperation, SoakReport["operations"][SoakOperation]]> =
    SOAK_CYCLE_OPERATIONS.map((operation) => [
      operation,
      summarizeOperationSamples(Array.from({ length: cycles }, (_, index) => 2 + index / 1_000)),
    ]);
  for (const operation of SOAK_PERIODIC_OPERATIONS) {
    operationEntries.push([
      operation,
      summarizeOperationSamples(Array.from({ length: authCount }, (_, index) => 3 + index / 100)),
    ]);
  }
  const operations = Object.fromEntries(operationEntries) as SoakReport["operations"];
  const memory = summarizeSoakMemory(
    Array.from({ length: 61 }, (_, index) => 200 * 1_024 * 1_024 + index * 128 * 1_024),
  );
  return {
    schemaVersion: 1,
    runId: `test-${engine}`,
    recordedAt: "2026-08-05T00:00:00.000Z",
    engine,
    git: { commit: "1".repeat(40), dirty: false },
    toolchain: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
    },
    runner: {
      id: "fixed-soak-test",
      gateEligible: true,
      hardwareFingerprint: "2".repeat(64),
      hardware: {
        os: Deno.build.os,
        osRelease: Deno.osRelease(),
        arch: Deno.build.arch,
        cpuModel: "test",
        logicalCpus: 8,
        totalMemoryBytes: 16 * 1_024 * 1_024 * 1_024,
        powerSource: "unknown",
      },
    },
    configuration: {
      requestedDurationMs: SOAK_MINIMUM_DURATION_MS,
      minimumDurationMs: SOAK_MINIMUM_DURATION_MS,
      cycleIntervalMs: 1_000,
      operationTimeoutMs: 10_000,
      memorySampleIntervalMs: 30_000,
      authEveryCycles,
      minimumCycles: SOAK_MINIMUM_CYCLES,
    },
    execution: {
      startedAt: "2026-08-05T00:00:00.000Z",
      endedAt: "2026-08-05T00:30:00.000Z",
      durationMs: SOAK_MINIMUM_DURATION_MS,
      completedCycles: cycles,
      completedOperations: Object.values(operations).reduce(
        (total, operation) => total + operation.count,
        0,
      ),
      failures: [],
      finalReady: true,
      cleanupVerified: true,
    },
    operations,
    memory,
    process: { exitSuccess: true, stderrBytes: 0 },
  };
}

async function writeReport(path: string, report: SoakReport): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
}
