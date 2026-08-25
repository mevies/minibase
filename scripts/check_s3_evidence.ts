import { fromFileUrl, join } from "@std/path";
import { validateRealS3EvidenceDirectory } from "./s3_real_report.ts";

export async function checkCommittedRealS3Evidence(root: string) {
  const summaries = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      summaries.push(await validateRealS3EvidenceDirectory(join(root, entry.name)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return summaries.toSorted((left, right) => left.runnerId.localeCompare(right.runnerId, "en"));
}

if (import.meta.main) {
  const root = fromFileUrl(new URL("../evidence/s3", import.meta.url));
  const summaries = await checkCommittedRealS3Evidence(root);
  console.log(JSON.stringify({
    ok: true,
    evidenceSets: summaries.map((summary) => ({
      runnerId: summary.runnerId,
      sourceCommit: summary.sourceCommit,
      providers: [summary.awsS3.provider, summary.cloudflareR2.provider],
      awsDurationMs: summary.awsS3.execution.durationMs,
      r2DurationMs: summary.cloudflareR2.execution.durationMs,
    })),
  }));
}
