import { fromFileUrl } from "@std/path";
import evidence from "../quality-evidence.json" with { type: "json" };
import { validateQualityEvidence } from "./quality_evidence.ts";

const root = fromFileUrl(new URL("../", import.meta.url));
const result = await validateQualityEvidence(root, evidence);
console.log(JSON.stringify({ ok: true, ...result }));
