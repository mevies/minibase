import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "@std/path";
import {
  type ComparableMinibaseReport,
  compareSupabaseDocker,
  type SupabaseDockerReport,
} from "./supabase_docker_report.ts";

interface EvidenceManifest {
  schemaVersion: 1;
  runnerId: string;
  sourceCommit: string;
  hardwareFingerprint: string;
  createdAt: string;
  files: Record<"minibase.json" | "supabase.json" | "comparison.json", string>;
}

const options = parseArguments(Deno.args);
const evidenceRoot = resolve("benchmarks", "supabase");
const outputDir = resolve(options.outputDir);
assertWithin(evidenceRoot, outputDir);
if (basename(outputDir) === "supabase") {
  throw new Error("Evidence output must be benchmarks/supabase/<runner>");
}

const minibase = JSON.parse(
  await Deno.readTextFile(resolve(options.minibase)),
) as ComparableMinibaseReport;
const supabase = JSON.parse(
  await Deno.readTextFile(resolve(options.supabase)),
) as SupabaseDockerReport;
const comparison = compareSupabaseDocker(minibase, supabase);
if (!comparison.passed) {
  throw new Error("Refuse to promote a Supabase Docker comparison that did not pass");
}
if (basename(outputDir) !== comparison.runnerId) {
  throw new Error("Evidence directory name must match the fixed runner id");
}

const existing = await Deno.stat(outputDir).catch(() => null);
if (existing !== null && !options.force) {
  throw new Error("Supabase evidence already exists; use --force to replace it explicitly");
}
await Deno.mkdir(dirname(outputDir), { recursive: true });
const staging = await Deno.makeTempDir({ dir: dirname(outputDir), prefix: ".supabase-evidence-" });
try {
  await Deno.writeTextFile(
    join(staging, "minibase.json"),
    JSON.stringify(minibase, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(staging, "supabase.json"),
    JSON.stringify(supabase, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    join(staging, "comparison.json"),
    JSON.stringify(comparison, null, 2) + "\n",
  );
  const manifest: EvidenceManifest = {
    schemaVersion: 1,
    runnerId: comparison.runnerId,
    sourceCommit: comparison.sourceCommit,
    hardwareFingerprint: comparison.hardwareFingerprint,
    createdAt: new Date().toISOString(),
    files: {
      "minibase.json": await sha256File(join(staging, "minibase.json")),
      "supabase.json": await sha256File(join(staging, "supabase.json")),
      "comparison.json": await sha256File(join(staging, "comparison.json")),
    },
  };
  await Deno.writeTextFile(
    join(staging, "evidence.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  if (existing !== null) await Deno.remove(outputDir, { recursive: true });
  await Deno.rename(staging, outputDir);
  console.log(JSON.stringify({ ok: true, outputDir, ...manifest }));
} finally {
  await Deno.remove(staging, { recursive: true }).catch(() => undefined);
}

function parseArguments(args: string[]) {
  let minibase: string | undefined;
  let supabase: string | undefined;
  let outputDir: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--minibase") minibase = requiredValue(args, ++index, argument);
    else if (argument === "--supabase") supabase = requiredValue(args, ++index, argument);
    else if (argument === "--output-dir") outputDir = requiredValue(args, ++index, argument);
    else if (argument === "--force") force = true;
    else throw new Error(`Unknown evidence promotion option: ${argument}`);
  }
  if (minibase === undefined || supabase === undefined || outputDir === undefined) {
    throw new Error(
      "Usage: promote_supabase_evidence.ts --minibase <file> --supabase <file> " +
        "--output-dir benchmarks/supabase/<runner> [--force]",
    );
  }
  return { minibase, supabase, outputDir, force };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function assertWithin(root: string, target: string): void {
  if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) {
    throw new Error("Supabase evidence output escaped benchmarks/supabase");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await Deno.readFile(path));
  return hash.digest("hex");
}
