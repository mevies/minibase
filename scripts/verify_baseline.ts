import { assertEquals } from "@std/assert";

const expectedDeno = "2.9.2";
assertEquals(Deno.version.deno, expectedDeno, "Deno version does not match the pinned baseline");

const git = await new Deno.Command("git", {
  args: ["rev-parse", "HEAD"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!git.success) {
  throw new Error(`Unable to resolve current Git commit: ${new TextDecoder().decode(git.stderr)}`);
}
const commit = new TextDecoder().decode(git.stdout).trim();
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`Invalid Git commit hash: ${commit}`);

const versions = await runDenoScript("scripts/check_versions.ts", ["--allow-read", "--allow-run"]);
const versionReport = parseLastJson(versions.stdout) as { ok?: boolean };
assertEquals(versionReport.ok, true, "Version policy probe did not report success");

const pgliteStarted = performance.now();
const pglite = await runDenoScript("scripts/probe_pglite.ts", ["-A"]);
const pgliteDurationMs = performance.now() - pgliteStarted;
const pgliteReport = parseLastJson(pglite.stdout) as {
  ok?: boolean;
  persistence?: boolean;
  plpgsql?: boolean;
  trigger?: boolean;
  rls?: boolean;
};
assertEquals(pgliteReport, {
  ok: true,
  persistence: true,
  plpgsql: true,
  trigger: true,
  rls: true,
});
if (pgliteDurationMs > 30_000) {
  throw new Error(`PGlite baseline exceeded its 30 second hang guard: ${pgliteDurationMs} ms`);
}

const cli = await new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "src/main.ts", "version", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output();
const stdout = new TextDecoder().decode(cli.stdout).trim();
const stderr = new TextDecoder().decode(cli.stderr);
if (!cli.success) throw new Error(`Baseline CLI exited with ${cli.code}: ${stderr}`);
assertEquals(stderr, "", "Baseline CLI leaked output to stderr");
const parsed = JSON.parse(stdout) as { version?: string };
assertEquals(typeof parsed.version, "string");

console.log(JSON.stringify({
  ok: true,
  commit,
  deno: Deno.version.deno,
  versionPolicy: true,
  pglite: pgliteReport,
  pgliteDurationMs: Number(pgliteDurationMs.toFixed(2)),
  cliVersion: parsed.version,
  stderrBytes: versions.stderrBytes + pglite.stderrBytes + cli.stderr.byteLength,
}));

async function runDenoScript(
  script: string,
  permissions: string[],
): Promise<{ stdout: string; stderrBytes: number }> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...permissions, script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) throw new Error(`${script} exited with ${result.code}: ${stderr}`);
  assertEquals(stderr, "", `${script} leaked output to stderr`);
  return { stdout: new TextDecoder().decode(result.stdout), stderrBytes: result.stderr.byteLength };
}

function parseLastJson(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/u);
  const last = lines.at(-1);
  if (last === undefined) throw new Error("Smoke command did not produce a JSON result");
  return JSON.parse(last);
}
