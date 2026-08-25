import { dirname, resolve } from "@std/path";
import {
  type ComparableMinibaseReport,
  compareSupabaseDocker,
  type SupabaseDockerReport,
} from "./supabase_docker_report.ts";

let minibasePath: string | undefined;
let supabasePath: string | undefined;
let outputPath: string | undefined;
for (let index = 0; index < Deno.args.length; index++) {
  const argument = Deno.args[index]!;
  if (argument === "--minibase") minibasePath = requiredValue(Deno.args, ++index, argument);
  else if (argument === "--supabase") supabasePath = requiredValue(Deno.args, ++index, argument);
  else if (argument === "--output") outputPath = requiredValue(Deno.args, ++index, argument);
  else throw new Error(`Unknown comparison option: ${argument}`);
}
if (minibasePath === undefined || supabasePath === undefined) {
  throw new Error(
    "Usage: compare_supabase_docker.ts --minibase <file> --supabase <file> [--output <file>]",
  );
}

const minibase = JSON.parse(
  await Deno.readTextFile(resolve(minibasePath)),
) as ComparableMinibaseReport;
const supabase = JSON.parse(await Deno.readTextFile(resolve(supabasePath))) as SupabaseDockerReport;
const comparison = compareSupabaseDocker(minibase, supabase);
if (outputPath !== undefined) {
  const resolvedOutput = resolve(outputPath);
  await Deno.mkdir(dirname(resolvedOutput), { recursive: true });
  await Deno.writeTextFile(resolvedOutput, JSON.stringify(comparison, null, 2) + "\n");
}
console.log(JSON.stringify(comparison));
if (!comparison.passed) Deno.exit(2);

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
