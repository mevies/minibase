import { fromFileUrl, relative, resolve } from "@std/path";

interface Options {
  platform: "macos-x64" | "macos-arm64";
  runnerLabel: string;
  expectedArch: "x86_64" | "arm64";
  output: string;
}

const ROOT = fromFileUrl(new URL("../", import.meta.url));

if (import.meta.main) {
  const options = parseOptions(Deno.args);
  const output = resolve(ROOT, options.output);
  const nested = relative(ROOT, output).replaceAll("\\", "/");
  if (!nested.startsWith(".evidence/local/") || !nested.endsWith("-runner.json")) {
    throw new Error("macOS runner evidence output must stay under .evidence/local");
  }
  const kernelArch = await command("uname", "-m");
  if (kernelArch !== options.expectedArch) {
    throw new Error(`Expected macOS ${options.expectedArch}, got ${kernelArch}`);
  }
  const evidence = {
    formatVersion: 1,
    sourceCommit: await command("git", "rev-parse", "HEAD"),
    sourceDirty: (await command("git", "status", "--porcelain")).length !== 0,
    platform: options.platform,
    runnerLabel: options.runnerLabel,
    runnerArch: Deno.env.get("RUNNER_ARCH") ?? null,
    expectedArch: options.expectedArch,
    imageOs: Deno.env.get("ImageOS") ?? null,
    imageVersion: Deno.env.get("ImageVersion") ?? null,
    deno: Deno.version.deno,
    osRelease: await command("sw_vers", "-productVersion"),
    kernelArch,
    recordedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, output: nested, ...evidence }));
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || values.has(flag)) throw usageError();
    values.set(flag, value);
  }
  const platform = values.get("--platform");
  const runnerLabel = values.get("--runner-label");
  const expectedArch = values.get("--expected-arch");
  const output = values.get("--output");
  if (
    (platform !== "macos-x64" && platform !== "macos-arm64") ||
    typeof runnerLabel !== "string" || !/^macos-[0-9]+(?:-intel)?$/u.test(runnerLabel) ||
    (expectedArch !== "x86_64" && expectedArch !== "arm64") ||
    typeof output !== "string"
  ) {
    throw usageError();
  }
  return { platform, runnerLabel, expectedArch, output };
}

function usageError(): Error {
  return new Error(
    "Usage: record_macos_runner_evidence.ts --platform macos-x64|macos-arm64 " +
      "--runner-label <label> --expected-arch x86_64|arm64 --output .evidence/local/<file>",
  );
}

async function command(executable: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command(executable, {
    cwd: ROOT,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${executable} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}
