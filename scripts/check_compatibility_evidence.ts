import { fromFileUrl } from "@std/path";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import evidence from "../fixtures/supabase-basic/compatibility-evidence.json" with { type: "json" };
import { validateCompatibilityEvidence } from "./compatibility_evidence.ts";

const root = fromFileUrl(new URL("../", import.meta.url));
const result = await validateCompatibilityEvidence(root, compatibility, evidence);
console.log(JSON.stringify({ ok: true, ...result }));
