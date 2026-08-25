import { type BenchmarkReport, compareBenchmarkReports } from "./benchmark_report.ts";

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const baseline = await readReport(options.baseline);
  const current = await readReport(options.current);
  const comparison = compareBenchmarkReports(baseline, current, {
    allowUnpinnedHardware: options.allowUnpinnedHardware,
  });
  console.log(JSON.stringify(comparison));
  if (comparison.regressions.length > 0) Deno.exit(2);
}

function parseArguments(args: string[]): {
  baseline: string;
  current: string;
  allowUnpinnedHardware: boolean;
} {
  let baseline: string | undefined;
  let current: string | undefined;
  let allowUnpinnedHardware = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--baseline") baseline = requiredValue(args, ++index, argument);
    else if (argument === "--current") current = requiredValue(args, ++index, argument);
    else if (argument === "--allow-unpinned-hardware") allowUnpinnedHardware = true;
    else throw new Error(`Unknown benchmark comparison option: ${argument}`);
  }
  if (baseline === undefined || current === undefined) {
    throw new Error("Usage: compare_benchmarks.ts --baseline <file> --current <file>");
  }
  return { baseline, current, allowUnpinnedHardware };
}

async function readReport(path: string): Promise<BenchmarkReport> {
  return JSON.parse(await Deno.readTextFile(path)) as BenchmarkReport;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
