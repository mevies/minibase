import { isAbsolute, join, relative, resolve } from "@std/path";
import { createRealS3EvidenceManifest, validateRealS3EvidenceDirectory } from "./s3_real_report.ts";

interface PromoteOptions {
  aws: string;
  r2: string;
  outputDir: string;
  force: boolean;
}

export async function promoteRealS3Evidence(options: PromoteOptions) {
  const manifest = await createRealS3EvidenceManifest(options.aws, options.r2);
  await prepareOutputDirectory(options.outputDir, options.force);
  await Deno.mkdir(options.outputDir, { recursive: true });
  await Deno.copyFile(options.aws, join(options.outputDir, "aws-s3.json"));
  await Deno.copyFile(options.r2, join(options.outputDir, "cloudflare-r2.json"));
  await Deno.writeTextFile(
    join(options.outputDir, "evidence.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return await validateRealS3EvidenceDirectory(options.outputDir);
}

async function prepareOutputDirectory(path: string, force: boolean): Promise<void> {
  if (!(await pathExists(path))) return;
  if (!force) throw new Error(`Real S3 evidence directory already exists: ${path}; use --force`);
  const resolved = resolve(path);
  const allowedRoots = [resolve("evidence", "s3"), resolve(".evidence", "local")];
  const allowed = allowedRoots.some((root) => {
    const child = relative(root, resolved);
    return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
  });
  if (!allowed) {
    throw new Error("Refuse to replace real S3 evidence outside evidence/s3 or .evidence/local");
  }
  await Deno.remove(resolved, { recursive: true });
}

function parseArguments(args: string[]): PromoteOptions {
  let aws: string | undefined;
  let r2: string | undefined;
  let outputDir: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--aws") aws = requiredValue(args, ++index, argument);
    else if (argument === "--r2") r2 = requiredValue(args, ++index, argument);
    else if (argument === "--output-dir") outputDir = requiredValue(args, ++index, argument);
    else if (argument === "--force") force = true;
    else throw new Error(`Unknown real S3 promotion option: ${argument}`);
  }
  if (aws === undefined || r2 === undefined || outputDir === undefined) {
    throw new Error("--aws, --r2 and --output-dir are required");
  }
  return { aws: resolve(aws), r2: resolve(r2), outputDir: resolve(outputDir), force };
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
  const summary = await promoteRealS3Evidence(options);
  console.log(JSON.stringify({
    ok: true,
    outputDir: options.outputDir,
    runnerId: summary.runnerId,
    sourceCommit: summary.sourceCommit,
    providers: [summary.awsS3.provider, summary.cloudflareR2.provider],
  }));
}
