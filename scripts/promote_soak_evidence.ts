import { isAbsolute, join, relative, resolve } from "@std/path";
import { createSoakEvidenceManifest, validateSoakEvidenceDirectory } from "./soak_evidence.ts";

interface PromoteOptions {
  pglite: string;
  postgres: string;
  outputDir: string;
  force: boolean;
}

async function promote(options: PromoteOptions) {
  const manifest = await createSoakEvidenceManifest(options.pglite, options.postgres);
  if (await pathExists(options.outputDir)) {
    if (!options.force) {
      throw new Error(`Soak evidence directory already exists: ${options.outputDir}; use --force`);
    }
    const resolved = resolve(options.outputDir);
    const allowedRoot = resolve("benchmarks", "soak");
    const relativeTarget = relative(allowedRoot, resolved);
    if (
      relativeTarget.length === 0 || relativeTarget.startsWith("..") ||
      isAbsolute(relativeTarget)
    ) {
      throw new Error(
        "Refuse to replace a soak evidence directory outside benchmarks/soak/<runner>",
      );
    }
    await Deno.remove(resolved, { recursive: true });
  }
  await Deno.mkdir(options.outputDir, { recursive: true });
  await Deno.copyFile(options.pglite, join(options.outputDir, "pglite.json"));
  await Deno.copyFile(options.postgres, join(options.outputDir, "postgres.json"));
  await Deno.writeTextFile(
    join(options.outputDir, "evidence.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const summary = await validateSoakEvidenceDirectory(options.outputDir);
  return { manifest, summary };
}

function parseArguments(args: string[]): PromoteOptions {
  let pglite: string | undefined;
  let postgres: string | undefined;
  let outputDir: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--pglite") pglite = requiredValue(args, ++index, argument);
    else if (argument === "--postgres") postgres = requiredValue(args, ++index, argument);
    else if (argument === "--output-dir") outputDir = requiredValue(args, ++index, argument);
    else if (argument === "--force") force = true;
    else throw new Error(`Unknown soak promotion option: ${argument}`);
  }
  if (pglite === undefined || postgres === undefined || outputDir === undefined) {
    throw new Error("--pglite, --postgres and --output-dir are required");
  }
  return {
    pglite: resolve(pglite),
    postgres: resolve(postgres),
    outputDir: resolve(outputDir),
    force,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const result = await promote(options);
  console.log(JSON.stringify({
    ok: true,
    outputDir: options.outputDir,
    runnerId: result.manifest.runnerId,
    sourceCommit: result.manifest.sourceCommit,
    pgliteDurationMs: result.summary.pglite.durationMs,
    postgresDurationMs: result.summary.postgres.durationMs,
  }));
}
