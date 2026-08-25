import { fromFileUrl, join } from "@std/path";

export interface NativeOptimizationRecord {
  id: string;
  kind: "rust" | "wasm";
  implementationPaths: string[];
  profilingReport: string;
  benchmarkBefore: string;
  benchmarkAfter: string;
  benchmarkTask: "bench" | "bench:postgres";
  bottleneck: string;
  conclusion: string;
}

export interface NonOptimizationNativeArtifact {
  path: string;
  purpose: "compatibility-fixture" | "third-party-runtime";
  reason: string;
  licenseDocument: string;
}

export interface OptimizationPolicyManifest {
  formatVersion: 1;
  policy: "profiling-first";
  nativeOptimizations: NativeOptimizationRecord[];
  nonOptimizationNativeArtifacts: NonOptimizationNativeArtifact[];
}

export interface OptimizationPolicyAudit {
  ok: true;
  policy: "profiling-first";
  nativeFiles: number;
  registeredOptimizations: number;
  nonOptimizationArtifacts: number;
  benchmarkTasks: string[];
}

interface ProfilingEvidence {
  formatVersion?: unknown;
  optimizationId?: unknown;
  sourceCommit?: unknown;
  benchmarkTask?: unknown;
  bottleneck?: unknown;
  reproduction?: unknown;
  finding?: unknown;
}

interface ValidProfilingEvidence extends ProfilingEvidence {
  formatVersion: 1;
  optimizationId: string;
  sourceCommit: string;
  benchmarkTask: "bench" | "bench:postgres";
  bottleneck: string;
  reproduction: string;
  finding: string;
}

interface BenchmarkIdentity {
  schemaVersion?: unknown;
  engine?: unknown;
  git?: { commit?: unknown; dirty?: unknown };
  runner?: { id?: unknown; gateEligible?: unknown; hardwareFingerprint?: unknown };
  configuration?: unknown;
}

export type OptimizationEvidenceLoader = (path: string) => Promise<unknown>;

if (import.meta.main) {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const manifest = JSON.parse(
    await Deno.readTextFile(join(root, "optimization-policy.json")),
  ) as OptimizationPolicyManifest;
  const denoConfig = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as {
    tasks?: Record<string, string>;
  };
  const trackedFiles = await repositoryTrackedFiles(root);
  const result = await auditOptimizationPolicy(
    manifest,
    trackedFiles,
    Object.keys(denoConfig.tasks ?? {}),
    async (path) => JSON.parse(await Deno.readTextFile(repoFile(root, path))),
  );
  console.log(JSON.stringify(result));
}

export async function auditOptimizationPolicy(
  manifest: OptimizationPolicyManifest,
  trackedFiles: readonly string[],
  taskNames: readonly string[],
  loadEvidence: OptimizationEvidenceLoader,
): Promise<OptimizationPolicyAudit> {
  if (manifest.formatVersion !== 1 || manifest.policy !== "profiling-first") {
    throw new Error("optimization-policy.json must use profiling-first format version 1");
  }
  for (const requiredTask of ["bench", "bench:postgres", "bench:compare"]) {
    if (!taskNames.includes(requiredTask)) {
      throw new Error(`Optimization policy requires deno task ${requiredTask}`);
    }
  }

  const tracked = new Set(trackedFiles.map(normalizeRepositoryPath));
  const nativeFiles = [...tracked].filter(isNativeFile).sort((left, right) =>
    left.localeCompare(right, "en")
  );
  const coveredNativeFiles = new Map<string, string>();
  const optimizationIds = new Set<string>();

  for (const record of manifest.nativeOptimizations) {
    validateOptimizationRecord(record, optimizationIds);
    for (const rawPath of record.implementationPaths) {
      const path = normalizeRepositoryPath(rawPath);
      assertTrackedNativeFile(tracked, path, `optimization ${record.id}`);
      registerNativeFile(coveredNativeFiles, path, `optimization ${record.id}`);
    }
    for (
      const evidencePath of [
        record.profilingReport,
        record.benchmarkBefore,
        record.benchmarkAfter,
      ]
    ) {
      const path = normalizeRepositoryPath(evidencePath);
      if (!tracked.has(path)) {
        throw new Error(`Optimization ${record.id} evidence is not tracked: ${path}`);
      }
      if (!path.startsWith(`benchmarks/profiling/${record.id}/`)) {
        throw new Error(
          `Optimization ${record.id} evidence must be under benchmarks/profiling/${record.id}/`,
        );
      }
    }
    if (record.benchmarkBefore === record.benchmarkAfter) {
      throw new Error(`Optimization ${record.id} requires distinct before and after reports`);
    }
    const profiling = validateProfilingEvidence(
      record,
      await loadEvidence(record.profilingReport),
    );
    validateBenchmarkPair(
      record,
      profiling,
      await loadEvidence(record.benchmarkBefore),
      await loadEvidence(record.benchmarkAfter),
    );
  }

  const nonOptimizationPaths = new Set<string>();
  for (const artifact of manifest.nonOptimizationNativeArtifacts) {
    const path = normalizeRepositoryPath(artifact.path);
    assertTrackedNativeFile(tracked, path, "non-optimization artifact");
    if (nonOptimizationPaths.has(path)) {
      throw new Error(`Duplicate non-optimization native artifact: ${path}`);
    }
    nonOptimizationPaths.add(path);
    registerNativeFile(coveredNativeFiles, path, `non-optimization ${artifact.purpose}`);
    if (
      artifact.purpose === "compatibility-fixture" &&
      !(path.startsWith("fixtures/") || path.startsWith("tests/fixtures/"))
    ) {
      throw new Error(
        `Compatibility native artifact must remain inside a fixture directory: ${path}`,
      );
    }
    if (
      artifact.purpose === "third-party-runtime" &&
      !(path.startsWith("release/assets/") && path.endsWith(".wasm"))
    ) {
      throw new Error(
        `Third-party native artifact must be a release/assets WebAssembly runtime: ${path}`,
      );
    }
    if (artifact.reason.trim().length < 20) {
      throw new Error(`Non-optimization native artifact needs a concrete reason: ${path}`);
    }
    const licenseDocument = normalizeRepositoryPath(artifact.licenseDocument);
    if (!tracked.has(licenseDocument) || !licenseDocument.endsWith(".md")) {
      throw new Error(`Non-optimization native artifact needs a tracked license document: ${path}`);
    }
  }

  const uncovered = nativeFiles.filter((path) => !coveredNativeFiles.has(path));
  if (uncovered.length > 0) {
    throw new Error(
      `Unregistered Rust/WASM product files require profiling evidence: ${uncovered.join(", ")}`,
    );
  }

  return {
    ok: true,
    policy: "profiling-first",
    nativeFiles: nativeFiles.length,
    registeredOptimizations: manifest.nativeOptimizations.length,
    nonOptimizationArtifacts: manifest.nonOptimizationNativeArtifacts.length,
    benchmarkTasks: ["bench", "bench:postgres", "bench:compare"],
  };
}

export async function repositoryTrackedFiles(root: string): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `Unable to enumerate tracked files: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).split("\0").filter((path) => path.length > 0);
}

function validateOptimizationRecord(
  record: NativeOptimizationRecord,
  optimizationIds: Set<string>,
): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record.id) || optimizationIds.has(record.id)) {
    throw new Error(`Invalid or duplicate native optimization id: ${record.id}`);
  }
  optimizationIds.add(record.id);
  if (record.kind !== "rust" && record.kind !== "wasm") {
    throw new Error(`Optimization ${record.id} must be rust or wasm`);
  }
  if (record.implementationPaths.length === 0) {
    throw new Error(`Optimization ${record.id} must list its implementation paths`);
  }
  if (record.bottleneck.trim().length < 20 || record.conclusion.trim().length < 20) {
    throw new Error(`Optimization ${record.id} needs concrete bottleneck and conclusion text`);
  }
  if (record.benchmarkTask !== "bench" && record.benchmarkTask !== "bench:postgres") {
    throw new Error(`Optimization ${record.id} must use a real Minibase benchmark task`);
  }
  if (
    record.kind === "rust" &&
    !record.implementationPaths.some((path) =>
      path.endsWith(".rs") || /(?:^|\/)Cargo\.toml$/u.test(path)
    )
  ) {
    throw new Error(`Rust optimization ${record.id} must include Rust source or a Cargo manifest`);
  }
  if (
    record.kind === "wasm" &&
    !record.implementationPaths.some((path) => path.endsWith(".wasm") || path.endsWith(".wat"))
  ) {
    throw new Error(`WebAssembly optimization ${record.id} must include a WebAssembly artifact`);
  }
}

function validateProfilingEvidence(
  record: NativeOptimizationRecord,
  rawEvidence: unknown,
): ValidProfilingEvidence {
  const evidence = rawEvidence as ProfilingEvidence;
  if (
    evidence === null || typeof evidence !== "object" || evidence.formatVersion !== 1 ||
    evidence.optimizationId !== record.id || evidence.benchmarkTask !== record.benchmarkTask ||
    evidence.bottleneck !== record.bottleneck ||
    typeof evidence.sourceCommit !== "string" || !/^[0-9a-f]{40}$/u.test(evidence.sourceCommit) ||
    typeof evidence.reproduction !== "string" || evidence.reproduction.trim().length < 20 ||
    typeof evidence.finding !== "string" || evidence.finding.trim().length < 20
  ) {
    throw new Error(`Optimization ${record.id} has invalid profiling evidence`);
  }
  return evidence as ValidProfilingEvidence;
}

function validateBenchmarkPair(
  record: NativeOptimizationRecord,
  profiling: ValidProfilingEvidence,
  rawBefore: unknown,
  rawAfter: unknown,
): void {
  const before = benchmarkIdentity(record, "before", rawBefore);
  const after = benchmarkIdentity(record, "after", rawAfter);
  if (before.engine !== after.engine) {
    throw new Error(`Optimization ${record.id} benchmark engines do not match`);
  }
  const expectedEngine = record.benchmarkTask === "bench" ? "pglite" : "postgres";
  if (before.engine !== expectedEngine) {
    throw new Error(`Optimization ${record.id} benchmark task does not match its engine`);
  }
  if (
    before.runner!.id !== after.runner!.id ||
    before.runner!.hardwareFingerprint !== after.runner!.hardwareFingerprint
  ) {
    throw new Error(`Optimization ${record.id} benchmarks must use the same fixed runner`);
  }
  if (JSON.stringify(before.configuration) !== JSON.stringify(after.configuration)) {
    throw new Error(`Optimization ${record.id} benchmark configurations do not match`);
  }
  if (before.git!.commit === after.git!.commit) {
    throw new Error(`Optimization ${record.id} before and after commits must differ`);
  }
  if (profiling.sourceCommit !== before.git!.commit) {
    throw new Error(`Optimization ${record.id} profiling commit must match the before benchmark`);
  }
}

function benchmarkIdentity(
  record: NativeOptimizationRecord,
  label: "before" | "after",
  rawReport: unknown,
): BenchmarkIdentity {
  const report = rawReport as BenchmarkIdentity;
  if (
    report === null || typeof report !== "object" || report.schemaVersion !== 3 ||
    (report.engine !== "pglite" && report.engine !== "postgres") ||
    report.git === undefined || report.git.dirty !== false ||
    typeof report.git.commit !== "string" || !/^[0-9a-f]{40}$/u.test(report.git.commit) ||
    report.runner === undefined || report.runner.gateEligible !== true ||
    typeof report.runner.id !== "string" || report.runner.id.length === 0 ||
    typeof report.runner.hardwareFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(report.runner.hardwareFingerprint) ||
    report.configuration === undefined
  ) {
    throw new Error(`Optimization ${record.id} has invalid ${label} benchmark evidence`);
  }
  return report;
}

function assertTrackedNativeFile(tracked: Set<string>, path: string, owner: string): void {
  if (!tracked.has(path) || !isNativeFile(path)) {
    throw new Error(`${owner} does not reference a tracked Rust/WASM file: ${path}`);
  }
}

function registerNativeFile(covered: Map<string, string>, path: string, owner: string): void {
  const existing = covered.get(path);
  if (existing !== undefined) {
    throw new Error(`Native file ${path} is registered by both ${existing} and ${owner}`);
  }
  covered.set(path, owner);
}

function isNativeFile(path: string): boolean {
  const name = path.split("/").at(-1)!;
  return path.endsWith(".rs") || path.endsWith(".wasm") || path.endsWith(".wat") ||
    name === "Cargo.toml" || name === "Cargo.lock" || name === "rust-toolchain" ||
    name === "rust-toolchain.toml" || name === "build.rs" || path.includes("/.cargo/");
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Repository path must be a normalized relative path: ${path}`);
  }
  return normalized;
}

function repoFile(root: string, path: string): string {
  return join(root, ...normalizeRepositoryPath(path).split("/"));
}
