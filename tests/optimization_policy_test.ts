import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import denoConfig from "../deno.json" with { type: "json" };
import manifest from "../optimization-policy.json" with { type: "json" };
import {
  auditOptimizationPolicy,
  type NativeOptimizationRecord,
  type OptimizationPolicyManifest,
  repositoryTrackedFiles,
} from "../scripts/check_optimization_policy.ts";

const TASKS = Object.keys(denoConfig.tasks);

Deno.test("repository enforces profiling-first native optimization policy", async () => {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const result = await auditOptimizationPolicy(
    manifest as unknown as OptimizationPolicyManifest,
    await repositoryTrackedFiles(root),
    TASKS,
    unexpectedEvidence,
  );

  assertEquals(result, {
    ok: true,
    policy: "profiling-first",
    nativeFiles: 0,
    registeredOptimizations: 0,
    nonOptimizationArtifacts: 0,
    benchmarkTasks: ["bench", "bench:postgres", "bench:compare"],
  });
});

Deno.test("unregistered Rust or WASM files fail closed", async () => {
  await assertRejects(
    () => auditOptimizationPolicy(emptyPolicy(), ["native/hash/src/lib.rs"], TASKS, noEvidence),
    Error,
    "Unregistered Rust/WASM product files require profiling evidence",
  );
});

Deno.test("product Rust cannot bypass profiling as a non-optimization artifact", async () => {
  const policy = emptyPolicy();
  policy.nonOptimizationNativeArtifacts.push({
    path: "native/hash/src/lib.rs",
    purpose: "third-party-runtime",
    reason: "Pretending product Rust is a third-party runtime must not bypass profiling.",
    licenseDocument: "docs/THIRD_PARTY_LICENSES.md",
  });
  await assertRejects(
    () =>
      auditOptimizationPolicy(
        policy,
        ["native/hash/src/lib.rs", "docs/THIRD_PARTY_LICENSES.md"],
        TASKS,
        noEvidence,
      ),
    Error,
    "must be a release/assets WebAssembly runtime",
  );
});

Deno.test("native optimizations require profiling and same-runner before-after evidence", async () => {
  const record = optimizationRecord();
  const files = trackedOptimizationFiles(record);
  const evidence = validEvidence(record);
  const result = await auditOptimizationPolicy(
    { ...emptyPolicy(), nativeOptimizations: [record] },
    files,
    TASKS,
    (path) => Promise.resolve(evidence.get(path)),
  );
  assertEquals(result.nativeFiles, 2);
  assertEquals(result.registeredOptimizations, 1);

  const mismatched = validEvidence(record);
  const after = structuredClone(mismatched.get(record.benchmarkAfter)) as Record<string, unknown>;
  after.runner = {
    id: "another-runner",
    gateEligible: true,
    hardwareFingerprint: "b".repeat(64),
  };
  mismatched.set(record.benchmarkAfter, after);
  await assertRejects(
    () =>
      auditOptimizationPolicy(
        { ...emptyPolicy(), nativeOptimizations: [record] },
        files,
        TASKS,
        (path) => Promise.resolve(mismatched.get(path)),
      ),
    Error,
    "benchmarks must use the same fixed runner",
  );
});

function emptyPolicy(): OptimizationPolicyManifest {
  return {
    formatVersion: 1,
    policy: "profiling-first",
    nativeOptimizations: [],
    nonOptimizationNativeArtifacts: [],
  };
}

function optimizationRecord(): NativeOptimizationRecord {
  return {
    id: "hash-hot-path",
    kind: "rust",
    implementationPaths: ["native/hash/Cargo.toml", "native/hash/src/lib.rs"],
    profilingReport: "benchmarks/profiling/hash-hot-path/profiling.json",
    benchmarkBefore: "benchmarks/profiling/hash-hot-path/before.json",
    benchmarkAfter: "benchmarks/profiling/hash-hot-path/after.json",
    benchmarkTask: "bench",
    bottleneck: "Hashing consumes most CPU time in the reproducible upload profile.",
    conclusion: "The native implementation is retained only after the fixed-runner comparison.",
  };
}

function trackedOptimizationFiles(record: NativeOptimizationRecord): string[] {
  return [
    ...record.implementationPaths,
    record.profilingReport,
    record.benchmarkBefore,
    record.benchmarkAfter,
  ];
}

function validEvidence(record: NativeOptimizationRecord): Map<string, unknown> {
  const runner = {
    id: "fixed-runner",
    gateEligible: true,
    hardwareFingerprint: "a".repeat(64),
  };
  const configuration = {
    iterations: 20,
    warmups: 5,
    concurrencyRequests: 100,
    concurrencyLevels: [1, 10, 50, 100],
  };
  return new Map<string, unknown>([
    [
      record.profilingReport,
      {
        formatVersion: 1,
        optimizationId: record.id,
        sourceCommit: "1".repeat(40),
        benchmarkTask: record.benchmarkTask,
        bottleneck: record.bottleneck,
        reproduction: "deno task bench --output profiling-before.json on the fixed runner",
        finding: "The CPU profile attributes a repeatable majority of samples to hashing.",
      },
    ],
    [
      record.benchmarkBefore,
      {
        schemaVersion: 3,
        engine: "pglite",
        git: { commit: "1".repeat(40), dirty: false },
        runner,
        configuration,
      },
    ],
    [
      record.benchmarkAfter,
      {
        schemaVersion: 3,
        engine: "pglite",
        git: { commit: "2".repeat(40), dirty: false },
        runner,
        configuration,
      },
    ],
  ]);
}

function noEvidence(): Promise<never> {
  return Promise.reject(new Error("unexpected evidence load"));
}

function unexpectedEvidence(): Promise<never> {
  return Promise.reject(
    new Error("the current TypeScript-only repository must not load optimization evidence"),
  );
}
