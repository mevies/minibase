import { fromFileUrl, join } from "@std/path";
import { validateSoakEvidenceDirectory } from "./soak_evidence.ts";

export async function checkCommittedSoakEvidence(root: string) {
  const summaries = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      summaries.push(await validateSoakEvidenceDirectory(join(root, entry.name)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return summaries.toSorted((left, right) => left.runnerId.localeCompare(right.runnerId, "en"));
}

if (import.meta.main) {
  const root = fromFileUrl(new URL("../benchmarks/soak", import.meta.url));
  const summaries = await checkCommittedSoakEvidence(root);
  console.log(JSON.stringify({
    ok: true,
    runners: summaries.map((summary) => ({
      runnerId: summary.runnerId,
      sourceCommit: summary.sourceCommit,
      hardwareFingerprint: summary.hardwareFingerprint,
      pgliteDurationMs: summary.pglite.durationMs,
      postgresDurationMs: summary.postgres.durationMs,
      pgliteCycles: summary.pglite.completedCycles,
      postgresCycles: summary.postgres.completedCycles,
    })),
  }));
}
