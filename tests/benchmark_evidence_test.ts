import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { verifyBenchmarkEvidenceRoot } from "../scripts/check_benchmark_evidence.ts";

Deno.test("committed fixed-runner evidence is verified and tampering fails closed", async () => {
  const evidenceRoot = fromFileUrl(new URL("../benchmarks/fixed", import.meta.url));
  const verified = await verifyBenchmarkEvidenceRoot(evidenceRoot);
  assertEquals(verified.length, 1);
  assertEquals(verified[0]?.runnerId, "minibase-windows-lab-01");
  assertEquals(verified[0]?.pgliteChecks, 28);
  assertEquals(verified[0]?.postgresChecks, 37);
  assertEquals(verified[0]?.historyEntries, 2);

  const tamperedRoot = await Deno.makeTempDir({ prefix: "minibase-benchmark-evidence-test-" });
  try {
    await copyTree(evidenceRoot, tamperedRoot);
    const report = join(
      tamperedRoot,
      "minibase-windows-lab-01",
      "current",
      "pglite.json",
    );
    await Deno.writeTextFile(report, await Deno.readTextFile(report) + " ");
    await assertRejects(
      () => verifyBenchmarkEvidenceRoot(tamperedRoot),
      Error,
      "mismatch",
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
