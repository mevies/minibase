import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import evidence from "../fixtures/supabase-basic/compatibility-evidence.json" with { type: "json" };
import { validateCompatibilityEvidence } from "../scripts/compatibility_evidence.ts";

const root = fromFileUrl(new URL("../", import.meta.url));

Deno.test("compatibility claims resolve to executable test and release evidence", async () => {
  const result = await validateCompatibilityEvidence(root, compatibility, evidence);
  assertEquals(result.claims, 55);
  assertEquals(result.entries, evidence.entries.length);
  assertEquals(result.files > 10, true);
});

Deno.test("compatibility evidence fails closed on missing claims and source markers", async () => {
  const missing = structuredClone(evidence);
  missing.entries[0]!.targets.shift();
  await assertRejects(
    () => validateCompatibilityEvidence(root, compatibility, missing),
    Error,
    "lack automated evidence",
  );

  const stale = structuredClone(evidence);
  stale.entries[0]!.markers[0] = "missing-compatibility-marker";
  await assertRejects(
    () => validateCompatibilityEvidence(root, compatibility, stale),
    Error,
    "cannot find marker",
  );
});
