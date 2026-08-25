import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { verifySupabaseEvidenceRoot } from "../scripts/check_supabase_evidence.ts";

Deno.test("committed Supabase Docker evidence recomputes and tampering fails closed", async () => {
  const evidenceRoot = fromFileUrl(new URL("../benchmarks/supabase", import.meta.url));
  const verified = await verifySupabaseEvidenceRoot(evidenceRoot);
  assertEquals(verified, [{
    runnerId: "minibase-windows-lab-01",
    sourceCommit: "751250a5876ba336d972421bab3f419952184b52",
    significantAdvantages: 2,
  }]);

  const tamperedRoot = await Deno.makeTempDir({ prefix: "minibase-supabase-evidence-test-" });
  try {
    await copyTree(evidenceRoot, tamperedRoot);
    const comparison = join(tamperedRoot, "minibase-windows-lab-01", "comparison.json");
    await Deno.writeTextFile(comparison, await Deno.readTextFile(comparison) + " ");
    await assertRejects(
      () => verifySupabaseEvidenceRoot(tamperedRoot),
      Error,
      "hash mismatch",
    );
  } finally {
    await Deno.remove(tamperedRoot, { recursive: true });
  }
});

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile) await Deno.copyFile(sourcePath, destinationPath);
  }
}
