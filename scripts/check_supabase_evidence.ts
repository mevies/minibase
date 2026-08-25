import { createHash } from "node:crypto";
import { basename, fromFileUrl, join } from "@std/path";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  type ComparableMinibaseReport,
  compareSupabaseDocker,
  type SupabaseComparisonReport,
  type SupabaseDockerReport,
} from "./supabase_docker_report.ts";

interface EvidenceManifest {
  schemaVersion: 1;
  runnerId: string;
  sourceCommit: string;
  hardwareFingerprint: string;
  createdAt: string;
  files: Record<string, string>;
}

export async function verifySupabaseEvidenceRoot(root: string): Promise<
  Array<{
    runnerId: string;
    sourceCommit: string;
    significantAdvantages: number;
  }>
> {
  const summaries: Array<{
    runnerId: string;
    sourceCommit: string;
    significantAdvantages: number;
  }> = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    summaries.push(await verifyEvidenceDirectory(join(root, entry.name)));
  }
  if (summaries.length === 0) {
    throw new Error("No Supabase Docker comparison evidence is committed");
  }
  return summaries.sort((left, right) => left.runnerId.localeCompare(right.runnerId));
}

async function verifyEvidenceDirectory(directory: string) {
  const manifest = await readJson<EvidenceManifest>(join(directory, "evidence.json"));
  assert(manifest.schemaVersion === 1, "Supabase evidence manifest schema is invalid");
  assert(
    manifest.runnerId === basename(directory),
    "Supabase evidence runner directory is invalid",
  );
  assert(/^[0-9a-f]{40}$/u.test(manifest.sourceCommit), "Supabase evidence commit is invalid");
  assert(
    /^[0-9a-f]{64}$/u.test(manifest.hardwareFingerprint),
    "Supabase evidence hardware fingerprint is invalid",
  );
  const expectedFiles = ["comparison.json", "minibase.json", "supabase.json"];
  assert(
    JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(expectedFiles),
    "Supabase evidence manifest file set is invalid",
  );
  for (const file of expectedFiles) {
    assert(
      manifest.files[file] === await sha256File(join(directory, file)),
      `Supabase evidence hash mismatch: ${file}`,
    );
  }

  const minibase = await readJson<ComparableMinibaseReport>(join(directory, "minibase.json"));
  const supabase = await readJson<SupabaseDockerReport>(join(directory, "supabase.json"));
  const stored = await readJson<SupabaseComparisonReport>(join(directory, "comparison.json"));
  const fresh = compareSupabaseDocker(minibase, supabase, stored.generatedAt);
  assert(
    JSON.stringify(stored) === JSON.stringify(fresh),
    "Supabase comparison does not recompute",
  );
  assert(stored.passed, "Supabase comparison did not meet the two-category gate");
  assert(stored.runnerId === manifest.runnerId, "Supabase evidence runner id does not match");
  assert(stored.sourceCommit === manifest.sourceCommit, "Supabase evidence commit does not match");
  assert(
    stored.hardwareFingerprint === manifest.hardwareFingerprint,
    "Supabase evidence hardware fingerprint does not match",
  );
  assert(supabase.configuration.iterations === 20, "Supabase evidence must use 20 iterations");
  assert(supabase.configuration.warmups === 5, "Supabase evidence must use 5 warmups");
  assert(
    supabase.configuration.concurrencyRequests === 100,
    "Supabase evidence must use 100 requests per concurrency level",
  );
  assert(
    supabase.toolchain.supabaseCli === toolchain.components.supabaseCli.required &&
      supabase.toolchain.supabaseCliArchiveSha256 ===
        toolchain.components.supabaseCli.windowsX64ArchiveSha256,
    "Supabase evidence CLI toolchain does not match",
  );
  assert(
    supabase.stack.containers.every((container) =>
      container.repoDigests.length > 0 && /^sha256:[0-9a-f]{64}$/u.test(container.imageId)
    ),
    "Supabase evidence is missing immutable image digests",
  );
  return {
    runnerId: stored.runnerId,
    sourceCommit: stored.sourceCommit,
    significantAdvantages: stored.significantAdvantages,
  };
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    throw new Error(`Invalid Supabase evidence JSON at ${path}: ${errorMessage(error)}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await Deno.readFile(path));
  return hash.digest("hex");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const root = fromFileUrl(new URL("../benchmarks/supabase", import.meta.url));
  console.log(JSON.stringify({ ok: true, evidence: await verifySupabaseEvidenceRoot(root) }));
}
