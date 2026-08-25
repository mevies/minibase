import { fromFileUrl, isAbsolute, join, relative, resolve } from "@std/path";
import { evaluateBenchmarkGate, type GateBenchmarkReport } from "./benchmark_gate.ts";

interface EvidenceFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface EvidenceManifest {
  formatVersion: 1;
  schemaVersion: 3;
  runnerId: string;
  hardwareFingerprint: string;
  sourceCommit: string;
  evaluatedAt: string;
  budgets: {
    embeddedWarmStartMs: number;
    embeddedCrudHotP95Ms: number;
    embeddedFunctionHotP95Ms: number;
    serverWarmStartMs: number;
  };
  files: EvidenceFile[];
}

interface FixedBenchmarkReport extends GateBenchmarkReport {
  configuration: {
    iterations: number;
    warmups: number;
    concurrencyRequests: number;
    concurrencyLevels: number[];
  };
}

interface BaselineManifest {
  formatVersion: 1;
  schemaVersion: 3;
  runnerId: string;
  hardwareFingerprint: string;
  commit: string;
  reports: {
    pglite: { fileName: string; sha256: string };
    postgres: { fileName: string; sha256: string };
  };
}

interface StoredGate {
  ok: boolean;
  gatePassed: boolean;
  compared: boolean;
  promoted: boolean;
  bootstrapped: boolean;
  acceptedRegressions: boolean;
  runnerId: string;
  hardwareFingerprint: string;
  currentCommit: string;
  baselineCommit: string | null;
  comparisons: unknown[];
  regressions: unknown[];
  evaluatedAt: string;
}

export interface BenchmarkEvidenceSummary {
  runnerId: string;
  sourceCommit: string;
  hardwareFingerprint: string;
  pgliteChecks: number;
  postgresChecks: number;
  historyEntries: number;
  pgliteWarmStartMs: number;
  postgresWarmStartMs: number;
}

const EXPECTED_FILES = [
  "baseline/manifest.json",
  "baseline/pglite.json",
  "baseline/postgres.json",
  "current/pglite.json",
  "current/postgres.json",
  "gate-bootstrap.json",
  "gate-current.json",
  "history.jsonl",
] as const;
const CRUD_WORKLOADS = [
  "crudInsert",
  "crudSelectSingle",
  "crudSelectList",
  "crudUpdate",
  "crudDelete",
] as const;
const EXPECTED_BUDGETS: EvidenceManifest["budgets"] = {
  embeddedWarmStartMs: 2_000,
  embeddedCrudHotP95Ms: 10,
  embeddedFunctionHotP95Ms: 30,
  serverWarmStartMs: 3_000,
};
const verifiedCommits = new Set<string>();

export async function verifyBenchmarkEvidenceRoot(
  evidenceRoot: string,
): Promise<BenchmarkEvidenceSummary[]> {
  const summaries: BenchmarkEvidenceSummary[] = [];
  for await (const entry of Deno.readDir(evidenceRoot)) {
    if (!entry.isDirectory) continue;
    summaries.push(await verifyRunnerEvidence(join(evidenceRoot, entry.name)));
  }
  if (summaries.length === 0) throw new Error("No fixed benchmark evidence is committed");
  return summaries.toSorted((left, right) => left.runnerId.localeCompare(right.runnerId, "en"));
}

async function verifyRunnerEvidence(runnerDir: string): Promise<BenchmarkEvidenceSummary> {
  const manifest = await readJson<EvidenceManifest>(join(runnerDir, "evidence.json"));
  assert(manifest.formatVersion === 1, "Benchmark evidence formatVersion must be 1");
  assert(manifest.schemaVersion === 3, "Benchmark evidence schemaVersion must be 3");
  assert(/^[A-Za-z0-9._-]{1,64}$/u.test(manifest.runnerId), "Benchmark runner id is invalid");
  assert(/^[0-9a-f]{64}$/u.test(manifest.hardwareFingerprint), "Hardware fingerprint is invalid");
  assert(/^[0-9a-f]{40}$/u.test(manifest.sourceCommit), "Benchmark source commit is invalid");
  assert(!Number.isNaN(Date.parse(manifest.evaluatedAt)), "Benchmark evaluatedAt is invalid");
  assertBudgets(manifest.budgets);
  await assertGitCommit(manifest.sourceCommit);

  const actualPaths = manifest.files.map((file) => file.path).toSorted();
  assert(
    JSON.stringify(actualPaths) === JSON.stringify([...EXPECTED_FILES].toSorted()),
    "Benchmark evidence file set is incomplete or contains unexpected files",
  );
  const fileHashes = new Map<string, string>();
  for (const file of manifest.files) {
    assert(/^[0-9a-f]{64}$/u.test(file.sha256), `Invalid SHA-256 for ${file.path}`);
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0, `Invalid size for ${file.path}`);
    const path = resolveEvidencePath(runnerDir, file.path);
    const stat = await Deno.lstat(path);
    assert(
      stat.isFile && !stat.isSymlink,
      `Benchmark evidence must be a regular file: ${file.path}`,
    );
    assert(stat.size === file.bytes, `Benchmark evidence size mismatch for ${file.path}`);
    const digest = await sha256(await Deno.readFile(path));
    assert(digest === file.sha256, `Benchmark evidence SHA-256 mismatch for ${file.path}`);
    fileHashes.set(file.path, digest);
  }

  const baseline = {
    pglite: await readReport(join(runnerDir, "baseline", "pglite.json")),
    postgres: await readReport(join(runnerDir, "baseline", "postgres.json")),
  };
  const current = {
    pglite: await readReport(join(runnerDir, "current", "pglite.json")),
    postgres: await readReport(join(runnerDir, "current", "postgres.json")),
  };
  for (const report of [baseline.pglite, baseline.postgres, current.pglite, current.postgres]) {
    assertReportIdentity(report, manifest);
    assertFormalConfiguration(report);
  }
  assert(baseline.pglite.engine === "pglite", "Baseline PGlite report engine is invalid");
  assert(baseline.postgres.engine === "postgres", "Baseline PostgreSQL report engine is invalid");
  assert(current.pglite.engine === "pglite", "Current PGlite report engine is invalid");
  assert(current.postgres.engine === "postgres", "Current PostgreSQL report engine is invalid");

  const evaluation = evaluateBenchmarkGate(current, baseline);
  assert(
    evaluation.gatePassed && evaluation.compared,
    "Committed benchmark comparison did not pass",
  );
  assert(evaluation.regressions.length === 0, "Committed benchmark comparison has regressions");

  const baselineManifest = await readJson<BaselineManifest>(
    join(runnerDir, "baseline", "manifest.json"),
  );
  assert(baselineManifest.formatVersion === 1, "Baseline manifest formatVersion must be 1");
  assert(baselineManifest.schemaVersion === 3, "Baseline manifest schemaVersion must be 3");
  assert(baselineManifest.runnerId === manifest.runnerId, "Baseline runner id does not match");
  assert(
    baselineManifest.hardwareFingerprint === manifest.hardwareFingerprint,
    "Baseline hardware fingerprint does not match",
  );
  assert(baselineManifest.commit === manifest.sourceCommit, "Baseline commit does not match");
  assert(baselineManifest.reports.pglite.fileName === "pglite.json", "PGlite file name is invalid");
  assert(
    baselineManifest.reports.postgres.fileName === "postgres.json",
    "PostgreSQL file name is invalid",
  );
  assert(
    baselineManifest.reports.pglite.sha256 === fileHashes.get("baseline/pglite.json"),
    "Baseline PGlite digest does not match",
  );
  assert(
    baselineManifest.reports.postgres.sha256 === fileHashes.get("baseline/postgres.json"),
    "Baseline PostgreSQL digest does not match",
  );

  const bootstrap = await readJson<StoredGate>(join(runnerDir, "gate-bootstrap.json"));
  assert(bootstrap.ok && bootstrap.gatePassed, "Bootstrap gate did not pass");
  assert(
    !bootstrap.compared && bootstrap.promoted && bootstrap.bootstrapped,
    "Bootstrap gate is invalid",
  );
  assert(!bootstrap.acceptedRegressions, "Bootstrap gate accepted regressions");
  assert(bootstrap.baselineCommit === null, "Bootstrap gate must not have a baseline commit");
  assertGateIdentity(bootstrap, manifest);

  const storedCurrent = await readJson<StoredGate>(join(runnerDir, "gate-current.json"));
  assert(storedCurrent.ok && storedCurrent.gatePassed, "Current benchmark gate did not pass");
  assert(storedCurrent.compared && !storedCurrent.promoted, "Current benchmark gate is invalid");
  assert(!storedCurrent.acceptedRegressions, "Current benchmark gate accepted regressions");
  assert(storedCurrent.regressions.length === 0, "Current benchmark gate records regressions");
  assert(
    storedCurrent.baselineCommit === manifest.sourceCommit,
    "Current benchmark baseline commit does not match",
  );
  assertGateIdentity(storedCurrent, manifest);
  assert(
    JSON.stringify(storedCurrent.comparisons) === JSON.stringify(evaluation.comparisons),
    "Stored benchmark comparisons do not match a fresh evaluation",
  );

  const history = (await Deno.readTextFile(join(runnerDir, "history.jsonl")))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StoredGate);
  assert(history.length >= 2, "Benchmark history must contain a baseline and a comparison");
  assert(history[0]?.bootstrapped === true, "Benchmark history does not start with a bootstrap");
  assert(history.at(-1)?.compared === true, "Benchmark history does not end with a comparison");
  assert(
    JSON.stringify(history.at(-1)) === JSON.stringify(storedCurrent),
    "Benchmark history does not retain the current gate result",
  );

  assertPerformanceBudgets(baseline.pglite, baseline.postgres, manifest);
  assertPerformanceBudgets(current.pglite, current.postgres, manifest);
  return {
    runnerId: manifest.runnerId,
    sourceCommit: manifest.sourceCommit,
    hardwareFingerprint: manifest.hardwareFingerprint,
    pgliteChecks:
      evaluation.comparisons.find((entry) => entry.engine === "pglite")?.checkedMetrics ?? 0,
    postgresChecks:
      evaluation.comparisons.find((entry) => entry.engine === "postgres")?.checkedMetrics ?? 0,
    historyEntries: history.length,
    pgliteWarmStartMs: current.pglite.startup.warmMs,
    postgresWarmStartMs: current.postgres.startup.warmMs,
  };
}

function assertReportIdentity(report: FixedBenchmarkReport, manifest: EvidenceManifest): void {
  assert(report.schemaVersion === 3, "Benchmark report schemaVersion must be 3");
  assert(report.runner.id === manifest.runnerId, "Benchmark report runner id does not match");
  assert(report.runner.gateEligible, "Benchmark report must be gate-eligible");
  assert(
    report.runner.hardwareFingerprint === manifest.hardwareFingerprint,
    "Benchmark report hardware fingerprint does not match",
  );
  assert(report.git.commit === manifest.sourceCommit, "Benchmark report commit does not match");
  assert(!report.git.dirty, "Benchmark report was captured from a dirty worktree");
}

function assertFormalConfiguration(report: FixedBenchmarkReport): void {
  assert(report.configuration.iterations === 20, "Benchmark iterations must be 20");
  assert(report.configuration.warmups === 5, "Benchmark warmups must be 5");
  assert(report.configuration.concurrencyRequests === 100, "Concurrency requests must be 100");
  assert(
    JSON.stringify(report.configuration.concurrencyLevels) === JSON.stringify([1, 10, 50, 100]),
    "Benchmark concurrency levels must be 1/10/50/100",
  );
}

function assertPerformanceBudgets(
  pglite: FixedBenchmarkReport,
  postgres: FixedBenchmarkReport,
  manifest: EvidenceManifest,
): void {
  assert(
    pglite.startup.warmMs <= manifest.budgets.embeddedWarmStartMs,
    "Embedded warm-start budget exceeded",
  );
  for (const workload of CRUD_WORKLOADS) {
    const p95 = pglite.workloads[workload]?.summary.p95Ms;
    assert(typeof p95 === "number", `Embedded benchmark is missing ${workload}`);
    assert(p95 <= manifest.budgets.embeddedCrudHotP95Ms, `${workload} p95 budget exceeded`);
  }
  const functionP95 = pglite.workloads.functionsHot?.summary.p95Ms;
  assert(typeof functionP95 === "number", "Embedded benchmark is missing functionsHot");
  assert(
    functionP95 <= manifest.budgets.embeddedFunctionHotP95Ms,
    "Embedded hot Function p95 budget exceeded",
  );
  assert(
    postgres.startup.warmMs <= manifest.budgets.serverWarmStartMs,
    "Server warm-start budget exceeded",
  );
}

function assertGateIdentity(gate: StoredGate, manifest: EvidenceManifest): void {
  assert(gate.runnerId === manifest.runnerId, "Gate runner id does not match");
  assert(gate.hardwareFingerprint === manifest.hardwareFingerprint, "Gate hardware does not match");
  assert(gate.currentCommit === manifest.sourceCommit, "Gate current commit does not match");
  assert(!Number.isNaN(Date.parse(gate.evaluatedAt)), "Gate evaluatedAt is invalid");
}

function assertBudgets(budgets: EvidenceManifest["budgets"]): void {
  assert(
    JSON.stringify(budgets) === JSON.stringify(EXPECTED_BUDGETS),
    "Benchmark evidence budgets do not match PLAN.md",
  );
}

async function assertGitCommit(commit: string): Promise<void> {
  if (verifiedCommits.has(commit)) return;
  const repositoryRoot = fromFileUrl(new URL("../", import.meta.url));
  const result = await new Deno.Command("git", {
    args: ["cat-file", "-e", `${commit}^{commit}`],
    cwd: repositoryRoot,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(
    result.success,
    `Benchmark source commit is not available: ${new TextDecoder().decode(result.stderr).trim()}`,
  );
  verifiedCommits.add(commit);
}

function resolveEvidencePath(root: string, path: string): string {
  const candidate = resolve(root, path);
  const nested = relative(root, candidate);
  if (
    nested === "" || nested === ".." || nested.startsWith(`..\\`) || nested.startsWith("../") ||
    isAbsolute(nested)
  ) {
    throw new Error(`Benchmark evidence path escapes its runner directory: ${path}`);
  }
  return candidate;
}

async function readReport(path: string): Promise<FixedBenchmarkReport> {
  return await readJson<FixedBenchmarkReport>(path);
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    throw new Error(`Invalid benchmark evidence JSON at ${path}: ${errorMessage(error)}`);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const evidenceRoot = fromFileUrl(new URL("../benchmarks/fixed", import.meta.url));
  const evidence = await verifyBenchmarkEvidenceRoot(evidenceRoot);
  console.log(JSON.stringify({ ok: true, evidence }));
}
