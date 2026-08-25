import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  evaluateBenchmarkGate,
  executeBenchmarkGate,
  type GateBenchmarkReport,
} from "../scripts/benchmark_gate.ts";
import {
  measurement,
  nativePostgresBaseline,
  postgresDatabasePoolBenchmark,
} from "../scripts/benchmark_report.ts";

Deno.test("benchmark gate compares a fixed-runner PGlite/PostgreSQL pair", () => {
  const baseline = pair();
  const current = pair("b".repeat(40));
  const evaluation = evaluateBenchmarkGate(current, baseline);
  assertEquals(evaluation.gatePassed, true);
  assertEquals(evaluation.compared, true);
  assertEquals(evaluation.currentCommit, "b".repeat(40));
  assertEquals(evaluation.baselineCommit, "a".repeat(40));
  assertEquals(evaluation.comparisons.map((entry) => entry.engine), ["pglite", "postgres"]);
  assertEquals(evaluation.regressions, []);
});

Deno.test("benchmark gate attributes regressions to their engine", () => {
  const baseline = pair();
  const current = pair("b".repeat(40));
  current.pglite.startup.warmMs = 130;
  const evaluation = evaluateBenchmarkGate(current, baseline);
  assertEquals(evaluation.gatePassed, false);
  assertEquals(evaluation.regressions.map(({ engine, metric }) => ({ engine, metric })), [
    { engine: "pglite", metric: "startup.warmMs" },
  ]);
});

Deno.test("benchmark gate rejects unpinned or mismatched current reports", () => {
  const unpinned = pair();
  unpinned.pglite.runner.gateEligible = false;
  assertThrows(
    () => evaluateBenchmarkGate(unpinned, null),
    Error,
    "must be gate-eligible on a fixed runner",
  );

  const mismatched = pair();
  mismatched.postgres.git.commit = "c".repeat(40);
  assertThrows(
    () => evaluateBenchmarkGate(mismatched, null),
    Error,
    "current benchmark Git commits do not match",
  );
});

Deno.test("benchmark gate explicitly bootstraps a baseline and appends bounded state", async () => {
  const root = resolve(".benchmarks", "local", `gate-test-${crypto.randomUUID()}`);
  const currentDir = join(root, "current");
  const baselineDir = join(root, "state", "baseline");
  const history = join(root, "state", "history.jsonl");
  const output = join(root, "gate-result.json");
  try {
    await Deno.mkdir(currentDir, { recursive: true });
    await writePair(currentDir, pair());
    const bootstrapped = await executeBenchmarkGate({
      currentDir,
      baselineDir,
      history,
      output,
      promote: true,
      acceptRegressions: false,
    });
    assertEquals(bootstrapped.ok, true);
    assertEquals(bootstrapped.bootstrapped, true);
    assertEquals(bootstrapped.promoted, true);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(baselineDir, "manifest.json")),
    ) as { commit: string; reports: { pglite: { sha256: string }; postgres: { sha256: string } } };
    assertEquals(manifest.commit, "a".repeat(40));
    assertMatch(manifest.reports.pglite.sha256, /^[0-9a-f]{64}$/u);
    assertMatch(manifest.reports.postgres.sha256, /^[0-9a-f]{64}$/u);

    await writePair(currentDir, pair("b".repeat(40)));
    const command = await new Deno.Command(Deno.execPath(), {
      args: [
        "task",
        "bench:gate",
        "--current-dir",
        currentDir,
        "--baseline-dir",
        baselineDir,
        "--history",
        history,
        "--output",
        output,
      ],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      command.success,
      true,
      new TextDecoder().decode(command.stderr),
    );
    const compared = JSON.parse(
      new TextDecoder().decode(command.stdout).trim(),
    ) as { ok: boolean; compared: boolean };
    assertEquals(compared.ok, true);
    assertEquals(compared.compared, true);
    assertEquals((await Deno.readTextFile(history)).trim().split(/\r?\n/u).length, 2);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

function pair(commit = "a".repeat(40)): {
  pglite: GateBenchmarkReport;
  postgres: GateBenchmarkReport;
} {
  return {
    pglite: report("pglite", commit),
    postgres: report("postgres", commit),
  };
}

function report(engine: GateBenchmarkReport["engine"], commit: string): GateBenchmarkReport {
  return {
    schemaVersion: 3,
    engine,
    recordedAt: "2026-08-05T00:00:00.000Z",
    git: { commit, dirty: false },
    runner: {
      id: "fixed-windows-runner",
      gateEligible: true,
      hardwareFingerprint: "d".repeat(64),
    },
    artifact: { bytes: 100 },
    startup: { coldMs: 100, warmMs: 100 },
    memory: { idleMedianRssBytes: 100, peakRssBytes: 200 },
    functionStartup: {
      coldDependencyCacheMs: 10,
      warmDependencyCacheMs: 5,
      typeCheckMs: 20,
      workerReadyMs: 5,
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

async function writePair(
  directory: string,
  reports: { pglite: GateBenchmarkReport; postgres: GateBenchmarkReport },
): Promise<void> {
  await Promise.all([
    Deno.writeTextFile(join(directory, "pglite.json"), JSON.stringify(reports.pglite)),
    Deno.writeTextFile(join(directory, "postgres.json"), JSON.stringify(reports.postgres)),
  ]);
}
