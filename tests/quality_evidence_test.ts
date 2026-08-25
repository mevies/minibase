import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import evidence from "../quality-evidence.json" with { type: "json" };
import { EXPECTED_QUALITY_CLAIMS, validateQualityEvidence } from "../scripts/quality_evidence.ts";

const root = fromFileUrl(new URL("../", import.meta.url));

Deno.test("quality claims resolve to security, recovery, performance and lifecycle evidence", async () => {
  const result = await validateQualityEvidence(root, evidence);
  assertEquals(result.claims, EXPECTED_QUALITY_CLAIMS.length);
  assertEquals(result.entries, evidence.entries.length);
  assertEquals(result.files > 15, true);
});

Deno.test("quality evidence fails closed on missing claims, tasks and source markers", async () => {
  const missing = structuredClone(evidence);
  missing.entries[0]!.targets.shift();
  await assertRejects(
    () => validateQualityEvidence(root, missing),
    Error,
    "lack automated evidence",
  );

  const stale = structuredClone(evidence);
  stale.entries[0]!.markers[0] = "missing-quality-marker";
  await assertRejects(
    () => validateQualityEvidence(root, stale),
    Error,
    "cannot find marker",
  );

  const task = structuredClone(evidence);
  const taskEntry = task.entries.find((entry) => entry.kind === "task")!;
  taskEntry.task = "missing-quality-task";
  await assertRejects(
    () => validateQualityEvidence(root, task),
    Error,
    "references missing task",
  );
});
