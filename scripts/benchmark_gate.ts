import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  type BenchmarkComparison,
  type BenchmarkRegression,
  type BenchmarkReport,
  compareBenchmarkReports,
} from "./benchmark_report.ts";

export interface GateBenchmarkReport extends BenchmarkReport {
  recordedAt: string;
  git: {
    commit: string;
    dirty: boolean;
  };
}

export interface BenchmarkReportPair {
  pglite: GateBenchmarkReport;
  postgres: GateBenchmarkReport;
}

export interface EngineBenchmarkComparison extends BenchmarkComparison {
  engine: BenchmarkReport["engine"];
}

export interface EngineBenchmarkRegression extends BenchmarkRegression {
  engine: BenchmarkReport["engine"];
}

export interface BenchmarkGateEvaluation {
  gatePassed: boolean;
  compared: boolean;
  runnerId: string;
  hardwareFingerprint: string;
  currentCommit: string;
  baselineCommit: string | null;
  comparisons: EngineBenchmarkComparison[];
  regressions: EngineBenchmarkRegression[];
}

export interface GateOptions {
  currentDir: string;
  baselineDir: string;
  history: string;
  output: string;
  promote: boolean;
  acceptRegressions: boolean;
}

export interface BenchmarkGateResult extends BenchmarkGateEvaluation {
  ok: boolean;
  promoted: boolean;
  bootstrapped: boolean;
  acceptedRegressions: boolean;
  evaluatedAt: string;
}

interface BaselineManifest {
  formatVersion: 1;
  schemaVersion: 3;
  promotedAt: string;
  runnerId: string;
  hardwareFingerprint: string;
  commit: string;
  reports: {
    pglite: { fileName: "pglite.json"; sha256: string };
    postgres: { fileName: "postgres.json"; sha256: string };
  };
}

const REPORT_FILE_NAMES = ["pglite.json", "postgres.json"] as const;
const MAX_HISTORY_ENTRIES = 500;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

export function evaluateBenchmarkGate(
  current: BenchmarkReportPair,
  baseline: BenchmarkReportPair | null,
): BenchmarkGateEvaluation {
  const currentIdentity = assertReportPair(current, "current");
  if (baseline === null) {
    return {
      gatePassed: true,
      compared: false,
      runnerId: currentIdentity.runnerId,
      hardwareFingerprint: currentIdentity.hardwareFingerprint,
      currentCommit: currentIdentity.commit,
      baselineCommit: null,
      comparisons: [],
      regressions: [],
    };
  }

  const baselineIdentity = assertReportPair(baseline, "baseline");
  const comparisons = (["pglite", "postgres"] as const).map((engine) => {
    let comparison: BenchmarkComparison;
    try {
      comparison = compareBenchmarkReports(baseline[engine], current[engine]);
    } catch (error) {
      throw new Error(
        `Cannot compare ${engine} benchmark reports: ${errorMessage(error)}`,
      );
    }
    return { engine, ...comparison };
  });
  const regressions = comparisons.flatMap((comparison) =>
    comparison.regressions.map((regression) => ({
      engine: comparison.engine,
      ...regression,
    }))
  );
  return {
    gatePassed: regressions.length === 0,
    compared: true,
    runnerId: currentIdentity.runnerId,
    hardwareFingerprint: currentIdentity.hardwareFingerprint,
    currentCommit: currentIdentity.commit,
    baselineCommit: baselineIdentity.commit,
    comparisons,
    regressions,
  };
}

function assertReportPair(
  pair: BenchmarkReportPair,
  label: "current" | "baseline",
): { runnerId: string; hardwareFingerprint: string; commit: string } {
  assertGateReport(pair.pglite, "pglite", `${label} PGlite`);
  assertGateReport(pair.postgres, "postgres", `${label} PostgreSQL`);
  if (pair.pglite.runner.id !== pair.postgres.runner.id) {
    throw new Error(`${label} benchmark runner ids do not match`);
  }
  if (pair.pglite.runner.hardwareFingerprint !== pair.postgres.runner.hardwareFingerprint) {
    throw new Error(`${label} benchmark hardware fingerprints do not match`);
  }
  if (pair.pglite.git.commit !== pair.postgres.git.commit) {
    throw new Error(`${label} benchmark Git commits do not match`);
  }
  return {
    runnerId: pair.pglite.runner.id!,
    hardwareFingerprint: pair.pglite.runner.hardwareFingerprint,
    commit: pair.pglite.git.commit,
  };
}

function assertGateReport(
  report: GateBenchmarkReport,
  engine: BenchmarkReport["engine"],
  label: string,
): void {
  const schemaVersion = (report as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 3) {
    throw new Error(`${label} benchmark must use schema version 3`);
  }
  if (report.engine !== engine) throw new Error(`${label} benchmark engine must be ${engine}`);
  if (!report.runner?.gateEligible || report.runner.id === null) {
    throw new Error(`${label} benchmark must be gate-eligible on a fixed runner`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(report.runner.id)) {
    throw new Error(`${label} benchmark runner id is invalid`);
  }
  if (!/^[0-9a-f]{64}$/u.test(report.runner.hardwareFingerprint)) {
    throw new Error(`${label} benchmark hardware fingerprint is invalid`);
  }
  if (!/^[0-9a-f]{40}$/u.test(report.git?.commit ?? "") || report.git.dirty) {
    throw new Error(`${label} benchmark must reference a clean Git commit`);
  }
  if (typeof report.recordedAt !== "string" || Number.isNaN(Date.parse(report.recordedAt))) {
    throw new Error(`${label} benchmark recordedAt is invalid`);
  }
}

export async function executeBenchmarkGate(options: GateOptions): Promise<BenchmarkGateResult> {
  const benchmarkRoot = resolve(".benchmarks", "local");
  for (
    const [label, path] of [
      ["current directory", options.currentDir],
      ["baseline directory", options.baselineDir],
      ["history file", options.history],
      ["result file", options.output],
    ] as const
  ) {
    assertWithin(benchmarkRoot, path, label);
  }

  const current = await readRequiredPair(options.currentDir, "current");
  const baseline = await readOptionalPair(options.baselineDir);
  if (baseline === null && !options.promote) {
    throw new Error(
      "No promoted benchmark baseline exists; rerun with --promote to bootstrap it explicitly",
    );
  }

  const evaluation = evaluateBenchmarkGate(current, baseline);
  const acceptedRegressions = !evaluation.gatePassed && options.acceptRegressions;
  if (options.acceptRegressions && !options.promote) {
    throw new Error("--accept-regressions requires --promote");
  }
  const ok = evaluation.gatePassed || acceptedRegressions;
  const evaluatedAt = new Date().toISOString();
  if (options.promote && ok) {
    await promoteBaseline(options.currentDir, options.baselineDir, current, evaluatedAt);
  }
  const result: BenchmarkGateResult = {
    ...evaluation,
    ok,
    promoted: options.promote && ok,
    bootstrapped: baseline === null && options.promote && ok,
    acceptedRegressions,
    evaluatedAt,
  };
  await writeJson(options.output, result);
  await appendHistory(options.history, result);
  return result;
}

async function promoteBaseline(
  currentDir: string,
  baselineDir: string,
  current: BenchmarkReportPair,
  promotedAt: string,
): Promise<void> {
  await Deno.mkdir(baselineDir, { recursive: true });
  const pgliteSource = join(currentDir, "pglite.json");
  const postgresSource = join(currentDir, "postgres.json");
  const pgliteBytes = await Deno.readFile(pgliteSource);
  const postgresBytes = await Deno.readFile(postgresSource);
  await writeBytes(join(baselineDir, "pglite.json"), pgliteBytes);
  await writeBytes(join(baselineDir, "postgres.json"), postgresBytes);
  const manifest: BaselineManifest = {
    formatVersion: 1,
    schemaVersion: 3,
    promotedAt,
    runnerId: current.pglite.runner.id!,
    hardwareFingerprint: current.pglite.runner.hardwareFingerprint,
    commit: current.pglite.git.commit,
    reports: {
      pglite: { fileName: "pglite.json", sha256: await sha256(pgliteBytes) },
      postgres: { fileName: "postgres.json", sha256: await sha256(postgresBytes) },
    },
  };
  await writeJson(join(baselineDir, "manifest.json"), manifest);
}

async function readRequiredPair(
  directory: string,
  label: string,
): Promise<BenchmarkReportPair> {
  const [pglite, postgres] = await Promise.all([
    readReport(join(directory, REPORT_FILE_NAMES[0]), `${label} ${REPORT_FILE_NAMES[0]}`),
    readReport(join(directory, REPORT_FILE_NAMES[1]), `${label} ${REPORT_FILE_NAMES[1]}`),
  ]);
  return { pglite, postgres };
}

async function readOptionalPair(directory: string): Promise<BenchmarkReportPair | null> {
  const paths = REPORT_FILE_NAMES.map((fileName) => join(directory, fileName));
  const present = await Promise.all(paths.map(fileExists));
  if (!present[0] && !present[1]) return null;
  if (!present[0] || !present[1]) {
    throw new Error("Promoted benchmark baseline is incomplete");
  }
  return await readRequiredPair(directory, "baseline");
}

async function readReport(path: string, label: string): Promise<GateBenchmarkReport> {
  await assertRegularFile(path, label);
  try {
    return JSON.parse(await Deno.readTextFile(path)) as GateBenchmarkReport;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

async function appendHistory(path: string, result: BenchmarkGateResult): Promise<void> {
  let entries: string[] = [];
  if (await fileExists(path)) {
    await assertRegularFile(path, "benchmark history");
    const stat = await Deno.stat(path);
    if (stat.size > MAX_HISTORY_BYTES) {
      throw new Error(`Benchmark history exceeds ${MAX_HISTORY_BYTES} bytes`);
    }
    entries = (await Deno.readTextFile(path)).split(/\r?\n/u).filter((line) => line.length > 0);
    for (const entry of entries) {
      try {
        JSON.parse(entry);
      } catch (error) {
        throw new Error(`Benchmark history contains invalid JSONL: ${errorMessage(error)}`);
      }
    }
  }
  entries.push(JSON.stringify(result));
  entries = entries.slice(-MAX_HISTORY_ENTRIES);
  await Deno.mkdir(resolve(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, entries.join("\n") + "\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(resolve(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function writeBytes(path: string, value: Uint8Array): Promise<void> {
  if (await fileExists(path)) await assertRegularFile(path, "baseline target");
  await Deno.writeFile(path, value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    if (stat.isSymlink) throw new Error(`Benchmark path must not be a symbolic link: ${path}`);
    return stat.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stat = await Deno.lstat(path);
  if (stat.isSymlink || !stat.isFile) throw new Error(`${label} must be a regular file`);
}

function assertWithin(root: string, path: string, label: string): void {
  const candidate = resolve(path);
  const nested = relative(root, candidate);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) return;
  throw new Error(`${label} must stay inside ${root}`);
}

async function sha256(value: Uint8Array): Promise<string> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseArguments(args: string[]): GateOptions {
  let currentDir: string | undefined;
  let baselineDir: string | undefined;
  let history: string | undefined;
  let output: string | undefined;
  let promote = false;
  let acceptRegressions = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--current-dir") currentDir = requiredValue(args, ++index, argument);
    else if (argument === "--baseline-dir") baselineDir = requiredValue(args, ++index, argument);
    else if (argument === "--history") history = requiredValue(args, ++index, argument);
    else if (argument === "--output") output = requiredValue(args, ++index, argument);
    else if (argument === "--promote") promote = true;
    else if (argument === "--accept-regressions") acceptRegressions = true;
    else throw new Error(`Unknown benchmark gate option: ${argument}`);
  }
  if ([currentDir, baselineDir, history, output].some((value) => value === undefined)) {
    throw new Error(
      "Usage: benchmark_gate.ts --current-dir <dir> --baseline-dir <dir> " +
        "--history <file> --output <file> [--promote] [--accept-regressions]",
    );
  }
  return {
    currentDir: resolve(currentDir!),
    baselineDir: resolve(baselineDir!),
    history: resolve(history!),
    output: resolve(output!),
    promote,
    acceptRegressions,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const result = await executeBenchmarkGate(parseArguments(Deno.args));
  console.log(JSON.stringify(result));
  if (!result.ok) Deno.exit(2);
}
