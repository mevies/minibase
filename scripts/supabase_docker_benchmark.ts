import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { dirname, join, resolve } from "@std/path";
import postgres from "postgres";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  copyTree,
  delay,
  gitReport,
  hardwareReport,
  runConcurrencyMatrix,
  runWorkloads,
  sha256Text,
} from "./benchmark.ts";
import {
  parseDockerMemoryBytes,
  SUPABASE_DOCKER_REPORT_SCHEMA,
  type SupabaseDockerContainer,
  type SupabaseDockerReport,
} from "./supabase_docker_report.ts";

interface Options {
  output: string;
  iterations: number;
  warmups: number;
  concurrencyRequests: number;
}

interface CommandResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

interface SupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface DockerPsRow {
  ID: string;
  Image: string;
  Names: string;
}

interface DockerStatsRow {
  ID: string;
  MemUsage: string;
}

interface DockerImageInspect {
  Id: string;
  RepoDigests: string[] | null;
}

const CONCURRENCY_LEVELS = [1, 10, 50, 100];
const MEMORY_SAMPLES = 5;
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const INCLUDED_SERVICES = ["auth", "db", "edge_runtime", "kong", "rest", "storage"];
const EXCLUDED_SERVICES = [
  "realtime",
  "imgproxy",
  "mailpit",
  "postgres-meta",
  "studio",
  "logflare",
  "vector",
  "supavisor",
];

async function runBenchmark(options: Options): Promise<SupabaseDockerReport> {
  assertWindowsX64();
  const archive = resolve(
    Deno.env.get("MINIBASE_SUPABASE_CLI_ARCHIVE") ??
      join(".benchmarks", "tooling", "supabase-2.110.0", "supabase_windows_amd64.tar.gz"),
  );
  await verifyCliArchive(archive);
  await assertDockerAvailable();

  const toolRoot = await Deno.makeTempDir({ prefix: "minibase-supabase-cli-" });
  const projectRoot = await Deno.makeTempDir({ prefix: "minibase-supabase-benchmark-" });
  const projectId = `minibase-benchmark-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const cli = join(toolRoot, "supabase.exe");
  try {
    await extractCli(archive, toolRoot);
    const cliVersion = (await runRequired(cli, ["--version"], "Supabase CLI version")).stdout
      .trim();
    if (cliVersion !== toolchain.components.supabaseCli.required) {
      throw new Error(`Supabase CLI ${toolchain.components.supabaseCli.required} is required`);
    }

    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), projectRoot);
    await configureProject(projectRoot, projectId);
    await startSupabase(cli, projectRoot);
    await stopSupabase(cli, projectRoot, true);

    const coldMs = await measureStart(cli, projectRoot);
    await stopSupabase(cli, projectRoot, false);
    const warmMs = await measureStart(cli, projectRoot);
    const containers = await inspectStack(projectId);
    const idleContainerBytes = await sampleStackMemory(containers);
    const status = await supabaseStatus(cli, projectRoot);
    await grantBenchmarkServiceAccess(status.DB_URL);
    const clients = await prepareClients(status);
    const benchmarkOptions = {
      engine: "pglite" as const,
      output: options.output,
      iterations: options.iterations,
      warmups: options.warmups,
      concurrencyRequests: options.concurrencyRequests,
    };
    const workloads = await runWorkloads(clients, benchmarkOptions);
    const concurrency = (await runConcurrencyMatrix(
      clients.user,
      clients.userId,
      options.concurrencyRequests,
    )).measurements;
    const git = await gitReport();
    const hardware = await hardwareReport();
    const runnerId = normalizedRunnerId(Deno.env.get("MINIBASE_BENCHMARK_RUNNER"));
    const docker = await dockerToolchain();
    const report: SupabaseDockerReport = {
      schemaVersion: SUPABASE_DOCKER_REPORT_SCHEMA,
      kind: "supabase-docker",
      runId: new Date().toISOString().replaceAll(/[:.]/gu, "-"),
      recordedAt: new Date().toISOString(),
      git,
      runner: {
        id: runnerId,
        gateEligible: runnerId !== null && !git.dirty,
        hardwareFingerprint: await sha256Text(JSON.stringify(hardware)),
        hardware,
      },
      fixture: {
        path: "fixtures/supabase-basic",
        sha256: await fixtureFingerprint(join(Deno.cwd(), "fixtures", "supabase-basic")),
      },
      configuration: {
        iterations: options.iterations,
        warmups: options.warmups,
        concurrencyRequests: options.concurrencyRequests,
        concurrencyLevels: CONCURRENCY_LEVELS,
        excludedServices: EXCLUDED_SERVICES,
        memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
      },
      toolchain: {
        deno: Deno.version.deno,
        supabaseCli: cliVersion,
        supabaseCliArchiveSha256: toolchain.components.supabaseCli.windowsX64ArchiveSha256,
        ...docker,
      },
      stack: {
        memoryScope: "sum-of-running-container-working-sets",
        containers,
      },
      startup: { coldMs: round(coldMs), warmMs: round(warmMs) },
      memory: {
        idleMedianContainerBytes: median(idleContainerBytes),
        idleContainerBytes,
      },
      workloads,
      concurrency,
    };
    await Deno.mkdir(dirname(options.output), { recursive: true });
    await Deno.writeTextFile(options.output, JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await stopSupabase(cli, projectRoot, true).catch(() => undefined);
    await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    await Deno.remove(toolRoot, { recursive: true }).catch(() => undefined);
  }
}

async function prepareClients(status: SupabaseStatus) {
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  const user = createClient(status.API_URL, status.ANON_KEY, clientOptions);
  const email = `benchmark-${crypto.randomUUID()}@example.com`;
  const password = "benchmark password with enough entropy 2026";
  const signup = await user.auth.signUp({
    email,
    password,
    options: { data: { display_name: "Benchmark User" } },
  });
  if (signup.error !== null || signup.data.user === null || signup.data.session === null) {
    throw new Error("Supabase benchmark Auth signup failed");
  }
  return {
    service: createClient(status.API_URL, status.SERVICE_ROLE_KEY, clientOptions),
    user,
    userId: signup.data.user.id,
    email,
    password,
  };
}

async function measureStart(cli: string, projectRoot: string): Promise<number> {
  const startedAt = performance.now();
  await startSupabase(cli, projectRoot);
  return performance.now() - startedAt;
}

async function startSupabase(cli: string, projectRoot: string): Promise<void> {
  await runRequired(
    cli,
    [
      "start",
      "--workdir",
      projectRoot,
      "--exclude",
      EXCLUDED_SERVICES.join(","),
      "--yes",
      "--agent",
      "no",
      "--output-format",
      "json",
    ],
    "Supabase Docker start",
  );
}

async function stopSupabase(cli: string, projectRoot: string, noBackup: boolean): Promise<void> {
  try {
    if (!(await Deno.stat(cli)).isFile) return;
  } catch {
    return;
  }
  const args = ["stop", "--workdir", projectRoot, "--yes", "--agent", "no"];
  if (noBackup) args.push("--no-backup");
  await runRequired(cli, args, "Supabase Docker stop");
}

async function supabaseStatus(cli: string, projectRoot: string): Promise<SupabaseStatus> {
  const output = await runRequired(
    cli,
    ["status", "--workdir", projectRoot, "-o", "json", "--agent", "no"],
    "Supabase Docker status",
  );
  const parsed = JSON.parse(output.stdout) as Partial<SupabaseStatus>;
  if (
    typeof parsed.API_URL !== "string" || typeof parsed.ANON_KEY !== "string" ||
    typeof parsed.DB_URL !== "string" ||
    typeof parsed.SERVICE_ROLE_KEY !== "string"
  ) {
    throw new Error("Supabase Docker status omitted required client configuration");
  }
  return parsed as SupabaseStatus;
}

async function grantBenchmarkServiceAccess(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql`grant select, insert, update, delete on table public.notes to service_role`;
    await sql`grant usage, select on sequence public.notes_id_seq to service_role`;
  } catch {
    throw new Error("Unable to grant the temporary Supabase benchmark service-role privileges");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function inspectStack(projectId: string): Promise<SupabaseDockerContainer[]> {
  const output = await runRequired(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.supabase.cli.project=${projectId}`,
      "--format",
      "{{json .}}",
    ],
    "Docker container listing",
  );
  const rows = jsonLines<DockerPsRow>(output.stdout);
  const containers: SupabaseDockerContainer[] = [];
  for (const row of rows) {
    const prefix = "supabase_";
    const suffix = `_${projectId}`;
    if (!row.Names.startsWith(prefix) || !row.Names.endsWith(suffix)) {
      throw new Error("Supabase Docker container name does not match the isolated project");
    }
    const role = row.Names.slice(prefix.length, -suffix.length);
    const inspect = JSON.parse(
      (await runRequired(
        "docker",
        ["image", "inspect", row.Image, "--format", "{{json .}}"],
        "Docker image inspection",
      )).stdout,
    ) as DockerImageInspect;
    containers.push({
      role,
      name: row.Names,
      image: row.Image,
      imageId: inspect.Id,
      repoDigests: [...(inspect.RepoDigests ?? [])].sort(),
    });
  }
  containers.sort((left, right) => left.role.localeCompare(right.role));
  if (JSON.stringify(containers.map((entry) => entry.role)) !== JSON.stringify(INCLUDED_SERVICES)) {
    throw new Error(
      `Unexpected Supabase Docker service set: ${containers.map((entry) => entry.role).join(",")}`,
    );
  }
  for (const container of containers) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(container.imageId) || container.repoDigests.length === 0) {
      throw new Error(`Supabase Docker image ${container.image} lacks immutable digest evidence`);
    }
  }
  return containers;
}

async function sampleStackMemory(containers: SupabaseDockerContainer[]): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < MEMORY_SAMPLES; index++) {
    const output = await runRequired(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", ...containers.map((entry) => entry.name)],
      "Docker memory sampling",
    );
    const rows = jsonLines<DockerStatsRow>(output.stdout);
    if (rows.length !== containers.length) {
      throw new Error("Docker memory sampling omitted a Supabase container");
    }
    samples.push(rows.reduce((total, row) => total + parseDockerMemoryBytes(row.MemUsage), 0));
    if (index + 1 < MEMORY_SAMPLES) await delay(MEMORY_SAMPLE_INTERVAL_MS);
  }
  return samples;
}

async function dockerToolchain(): Promise<
  Pick<
    SupabaseDockerReport["toolchain"],
    "dockerDesktop" | "dockerEngine" | "dockerApi" | "dockerCompose"
  >
> {
  const version = JSON.parse(
    (await runRequired(
      "docker",
      ["version", "--format", "{{json .}}"],
      "Docker version",
    )).stdout,
  ) as {
    Server?: { Platform?: { Name?: string }; Version?: string; ApiVersion?: string };
  };
  const compose = (await runRequired(
    "docker",
    ["compose", "version", "--short"],
    "Docker Compose version",
  )).stdout.trim();
  const dockerDesktop = version.Server?.Platform?.Name;
  const dockerEngine = version.Server?.Version;
  const dockerApi = version.Server?.ApiVersion;
  if (!dockerDesktop || !dockerEngine || !dockerApi || !compose) {
    throw new Error("Docker version output is incomplete");
  }
  return { dockerDesktop, dockerEngine, dockerApi, dockerCompose: compose };
}

async function configureProject(projectRoot: string, projectId: string): Promise<void> {
  const path = join(projectRoot, "supabase", "config.toml");
  let config = await Deno.readTextFile(path);
  const apiPort = availablePort();
  const databasePort = availablePort();
  config = config.replace(/^project_id\s*=\s*"[^"]+"/mu, `project_id = "${projectId}"`);
  config = config.replace(/(\[api\]\s*\r?\nport\s*=\s*)\d+/mu, `$1${apiPort}`);
  config += `\n[db]\nport = ${databasePort}\n`;
  await Deno.writeTextFile(path, config);
}

async function verifyCliArchive(path: string): Promise<void> {
  const stat = await Deno.stat(path).catch(() => null);
  if (stat === null || !stat.isFile) {
    throw new Error(`Supabase CLI archive is missing: ${path}`);
  }
  if (stat.size !== toolchain.components.supabaseCli.windowsX64ArchiveBytes) {
    throw new Error("Supabase CLI archive size does not match toolchain.json");
  }
  if (await sha256File(path) !== toolchain.components.supabaseCli.windowsX64ArchiveSha256) {
    throw new Error("Supabase CLI archive SHA-256 does not match toolchain.json");
  }
}

async function extractCli(archive: string, destination: string): Promise<void> {
  await runRequired(
    "tar",
    ["-xzf", archive, "-C", destination, "supabase.exe"],
    "Supabase CLI extraction",
  );
}

async function assertDockerAvailable(): Promise<void> {
  await runRequired("docker", ["info", "--format", "{{.ServerVersion}}"], "Docker engine probe");
}

function assertWindowsX64(): void {
  if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") {
    throw new Error("The pinned Supabase Docker comparison currently requires Windows x64");
  }
}

async function fixtureFingerprint(root: string): Promise<string> {
  const files: string[] = [];
  await collectFixtureFiles(root, root, files);
  files.sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await Deno.readFile(join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFixtureFiles(root: string, current: string, files: string[]): Promise<void> {
  for await (const entry of Deno.readDir(current)) {
    if (entry.name === ".minibase") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory) await collectFixtureFiles(root, path, files);
    else if (entry.isFile) files.push(path.slice(root.length + 1));
    else throw new Error(`Unsupported fixture entry: ${path}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await Deno.readFile(path));
  return hash.digest("hex");
}

async function runRequired(command: string, args: string[], label: string): Promise<CommandResult> {
  const output = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
    env: { SUPABASE_NO_UPDATE_CHECK: "true" },
  }).output();
  const result = {
    code: output.code,
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
  if (!result.success) {
    throw new Error(
      `${label} failed with exit code ${result.code}; stdoutBytes=${output.stdout.length}; ` +
        `stderrBytes=${output.stderr.length}`,
    );
  }
  return result;
}

function jsonLines<T>(value: string): T[] {
  return value.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean).map((line) =>
    JSON.parse(line) as T
  );
}

function normalizedRunnerId(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(normalized)) {
    throw new Error("MINIBASE_BENCHMARK_RUNNER has an invalid value");
  }
  return normalized;
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function parseArguments(args: string[]): Options {
  let output: string | undefined;
  let iterations = 20;
  let warmups = 5;
  let concurrencyRequests = 100;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--output") output = requiredValue(args, ++index, argument);
    else if (argument === "--iterations") {
      iterations = positiveInteger(requiredValue(args, ++index, argument), argument);
    } else if (argument === "--warmups") {
      warmups = nonNegativeInteger(requiredValue(args, ++index, argument), argument);
    } else if (argument === "--concurrency-requests") {
      concurrencyRequests = positiveInteger(requiredValue(args, ++index, argument), argument);
    } else throw new Error(`Unknown Supabase benchmark option: ${argument}`);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return {
    output: resolve(output ?? join(".benchmarks", "local", `${timestamp}-supabase-docker.json`)),
    iterations,
    warmups,
    concurrencyRequests,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error(`${option} must be an integer between 1 and 100000`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error(`${option} must be an integer between 0 and 100000`);
  }
  return parsed;
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const report = await runBenchmark(options);
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    runner: report.runner.id,
    gateEligible: report.runner.gateEligible,
    coldStartMs: report.startup.coldMs,
    warmStartMs: report.startup.warmMs,
    idleContainerBytes: report.memory.idleMedianContainerBytes,
    containers: report.stack.containers.length,
  }));
}
