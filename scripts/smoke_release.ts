import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import toolchain from "../toolchain.json" with { type: "json" };
import { activeAuthSigningKey, normalizeAuthSecrets } from "../src/auth/secrets.ts";
import { signJwt } from "../src/auth/jwt.ts";
import { windowsPowerShellEnvironment } from "../src/security/windows_acl.ts";
import { MINIBASE_VERSION } from "../src/version.ts";
import {
  assertSupabaseServerWorkerContract,
  installSupabaseServerContextFixture,
  seedSupabaseServerFunctionCache,
} from "./supabase_server_context_fixture.ts";
import {
  currentReleasePlatform,
  releasePlatform,
  type ReleasePlatformDescriptor,
  releasePlatformLabel,
} from "../src/release/platform.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const OPTIONS = parseOptions(Deno.args);
const PLATFORM = releasePlatform(OPTIONS.platform ?? currentReleasePlatform().name);
const EDITION = OPTIONS.edition;
const ENGINE = EDITION === "server" ? "postgres" : "pglite";
const BUILD_TASK = `release:build:${EDITION}:${PLATFORM.name}`;
const OUTPUT_DIR = join(ROOT, "dist", PLATFORM.name, EDITION);
const ARTIFACT_NAME = `minibase-${EDITION}-${PLATFORM.name}${PLATFORM.artifactSuffix}`;
const ARTIFACT = join(OUTPUT_DIR, ARTIFACT_NAME);
const DENO_VERSION = toolchain.runtimes.deno.required;
const POSTGRES_VERSION = toolchain.components.postgres.required;
// A clean release smoke extracts the bundled Runtime and warms every Function
// dependency cache. Windows real-time scanning can make that one-time path take
// longer than a normal application startup, so keep this reliability budget
// separate from the benchmark gates.
const RUNTIME_START_TIMEOUT_MS = 180_000;

if (Deno.build.os !== PLATFORM.os || Deno.build.arch !== PLATFORM.arch) {
  throw new Error(
    `The ${PLATFORM.name} release smoke must run on ${PLATFORM.os}/${PLATFORM.arch}; ` +
      `current host is ${Deno.build.os}/${Deno.build.arch}`,
  );
}

const manifest = JSON.parse(
  await Deno.readTextFile(join(OUTPUT_DIR, "release-manifest.json")),
) as ReleaseManifest;
assertEquals(manifest.formatVersion, 1);
assertEquals(manifest.version, MINIBASE_VERSION);
assertEquals(manifest.edition, EDITION);
assertEquals(manifest.platform, PLATFORM.name);
assertEquals(manifest.target, PLATFORM.target);
assertEquals(manifest.toolchain.deno, DENO_VERSION);
assertEquals(
  manifest.verification.macosAdHocSignatureNormalized,
  PLATFORM.os === "darwin",
);
if (EDITION === "server") {
  assertEquals(manifest.toolchain.postgres, POSTGRES_VERSION);
  assertEquals(manifest.bundledPostgresRuntime?.version, POSTGRES_VERSION);
  assertEquals(manifest.bundledPostgresRuntime?.platform, PLATFORM.name);
  assert(
    (manifest.bundledPostgresRuntime?.fileCount ?? 0) >
      (PLATFORM.os === "windows" ? 1_000 : 500),
  );
  assert((manifest.bundledPostgresRuntime?.extractedBytes ?? 0) < 150_000_000);
  assertEquals(
    manifest.bundledPostgresRuntime?.excluded,
    PLATFORM.os === "windows"
      ? ["doc", "include", "pgAdmin 4", "StackBuilder", "static libraries"]
      : PLATFORM.os === "darwin"
      ? [
        "documentation",
        "headers",
        "static libraries",
        "unused client tools",
        "optional non-system libraries",
      ]
      : ["documentation", "headers", "JIT", "unused client tools", "glibc"],
  );
  assert((manifest.bundledPostgresRuntime?.packages.length ?? 0) >= 1);
}
if (Deno.env.get("MINIBASE_RELEASE_ALLOW_DIRTY") !== "1") {
  assertEquals(manifest.source.dirty, false, "Release smoke must run from a clean commit");
}
assertEquals(manifest.artifact.fileName, ARTIFACT_NAME);
assertEquals(manifest.artifact.bytes, (await Deno.stat(ARTIFACT)).size);
assertEquals(manifest.artifact.sha256, await sha256File(ARTIFACT));
await assertReproducibleRebuild(manifest);
assertEquals(
  (await Deno.readTextFile(join(OUTPUT_DIR, `${ARTIFACT_NAME}.sha256`))).trim(),
  `${manifest.artifact.sha256}  ${ARTIFACT_NAME}`,
);
const licensePath = join(OUTPUT_DIR, manifest.licenses.fileName);
assertEquals(manifest.licenses.bytes, (await Deno.stat(licensePath)).size);
assertEquals(manifest.licenses.sha256, await sha256File(licensePath));
const licenses = await Deno.readTextFile(licensePath);
for (
  const expected of [
    "Deno 2.9.2",
    "PGlite 0.5.4",
    "Apache License 2.0 for PGlite 0.5.4",
    "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    "PostgreSQL License",
    "postgres.js 3.4.9",
    "smol-toml 1.7.0",
    ...(EDITION === "server"
      ? [
        `PostgreSQL ${POSTGRES_VERSION} ${releasePlatformLabel(PLATFORM)} Runtime`,
        ...(PLATFORM.os === "windows" ? ["openssl license", "ICU 77.1"] : PLATFORM.os === "darwin"
          ? [
            `OpenSSL ${toolchain.components.postgresMacosOpenSsl.required} notices`,
            "PostgreSQL Database Management System",
            "Apache License",
          ]
          : ["PostgreSQL Database Management System", "OpenSSL", "Unicode"]),
      ]
      : []),
  ]
) {
  assertStringIncludes(licenses, expected);
}

const version = await runArtifact(["version", "--json"]);
assertEquals(version.code, 0, version.stderr);
assertEquals(version.stderr, "");
assertEquals(JSON.parse(version.stdout), { version: MINIBASE_VERSION });

const temp = await Deno.makeTempDir({ prefix: `minibase-${EDITION}-release-smoke-` });
const project = join(temp, "project");
const secondProject = EDITION === "server" ? join(temp, "project-second") : project;
const cacheHome = join(temp, "cache-home");
const runtimeDir = join(cacheHome, "minibase", "runtimes", "deno", DENO_VERSION);
const runtimeExecutable = join(runtimeDir, PLATFORM.denoExecutableName);
const postgresRuntimeDir = join(
  cacheHome,
  "minibase",
  "runtimes",
  "postgresql",
  POSTGRES_VERSION,
  PLATFORM.name,
);
const postgresExecutable = join(
  postgresRuntimeDir,
  ...(PLATFORM.os === "linux"
    ? ["usr", "lib", "postgresql", POSTGRES_VERSION.split(".", 1)[0]!, "bin"]
    : ["bin"]),
  PLATFORM.os === "windows" ? "postgres.exe" : "postgres",
);
const childEnvironment = releaseEnvironment(temp, cacheHome, PLATFORM);
const children: Deno.ChildProcess[] = [];
try {
  await Deno.mkdir(project, { recursive: true });
  if (PLATFORM.os !== "windows") {
    await Deno.mkdir(childEnvironment.HOME!, { recursive: true, mode: 0o700 });
  }
  await copyTree(join(ROOT, "fixtures", "supabase-basic"), project);
  await addFunctionFixtures(project);
  await seedSupabaseServerFunctionCache(join(project, ".minibase", "cache", "deno"));
  if (secondProject !== project) {
    await Deno.mkdir(secondProject, { recursive: true });
    await copyTree(join(ROOT, "fixtures", "supabase-basic"), secondProject);
    await addFunctionFixtures(secondProject);
    await seedSupabaseServerFunctionCache(join(secondProject, ".minibase", "cache", "deno"));
  }

  const firstPort = availablePort();
  const first = startArtifact(project, firstPort, childEnvironment);
  children.push(first);
  const firstRuntime = await waitForRuntime(project, first);
  await assertHealth(firstRuntime.apiUrl, ENGINE);
  await assertSecretPermissions(join(project, ".minibase", "secrets.json"));
  await assertSupabaseFixture(project, firstRuntime.apiUrl);

  const runtimeBefore = await runtimeRecord(runtimeExecutable);
  const postgresRuntimeBefore = EDITION === "server"
    ? await runtimeRecord(postgresExecutable)
    : null;
  const workerFiles = [];
  for await (const entry of Deno.readDir(runtimeDir)) {
    if (
      entry.isFile && entry.name.startsWith("minibase-function-worker-") &&
      entry.name.endsWith(".js")
    ) {
      workerFiles.push(entry.name);
    }
  }
  assertEquals(workerFiles.length, 1);
  await stopArtifact(project, childEnvironment);
  await assertChildSuccess(first);

  const secondPort = availablePort();
  const second = startArtifact(secondProject, secondPort, childEnvironment);
  children.push(second);
  const secondRuntime = await waitForRuntime(secondProject, second);
  await assertHealth(secondRuntime.apiUrl, ENGINE);
  const aliasResponse = await fetch(new URL("/functions/v1/release-alias", secondRuntime.apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${await roleToken(secondProject, "anon")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ restart: true }),
  });
  assertEquals(aliasResponse.status, 200);
  assertEquals(await aliasResponse.json(), {
    marker: "external-deno-json-import-map",
    body: { restart: true },
  });
  await stopArtifact(secondProject, childEnvironment);
  await assertChildSuccess(second);
  assertEquals(await runtimeRecord(runtimeExecutable), runtimeBefore);
  if (EDITION === "server") {
    assertEquals(await runtimeRecord(postgresExecutable), postgresRuntimeBefore);
    assertEquals(
      await fileExists(join(project, ".minibase", "data", "postgres", "PG_VERSION")),
      true,
    );
    assertEquals(
      await fileExists(join(secondProject, ".minibase", "data", "postgres", "PG_VERSION")),
      true,
    );
    await assertBundledPostgresDiagnostics(secondProject, childEnvironment);
  }

  const tamperedRuntime = EDITION === "server"
    ? (PLATFORM.os === "windows"
      ? join(postgresRuntimeDir, "bin", "version.dll")
      : postgresExecutable)
    : runtimeExecutable;
  const tamperedRuntimeDir = EDITION === "server" ? postgresRuntimeDir : runtimeDir;
  await Deno.writeTextFile(tamperedRuntime, "tampered-runtime");
  const rejected = startArtifact(secondProject, availablePort(), childEnvironment);
  children.push(rejected);
  const rejectedOutput = await withTimeout(rejected.output(), 30_000, "tampered Runtime rejection");
  assertEquals(rejectedOutput.success, false);
  const rejectedStderr = decode(rejectedOutput.stderr);
  assertStringIncludes(
    rejectedStderr,
    EDITION === "server"
      ? "Bundled PostgreSQL Runtime integrity check failed"
      : "Bundled Deno Runtime integrity check failed",
  );
  assertStringIncludes(rejectedStderr, `remove ${tamperedRuntimeDir}`);

  console.log(JSON.stringify({
    ok: true,
    artifact: ARTIFACT,
    bytes: manifest.artifact.bytes,
    sha256: manifest.artifact.sha256,
    reproducibleBuild: true,
    runtimeExtractedOnce: true,
    postgresRuntimeShared: EDITION === "server",
    projectDataIsolated: EDITION === "server",
    unexpectedRuntimeEntryRejected: EDITION === "server" && PLATFORM.os === "windows",
    bundledRuntimeDiagnostics: EDITION === "server",
    externalDenoConfigImport: true,
    supabaseServerContextWorker: true,
    tamperRejected: true,
    secretPermissions: true,
  }));
} finally {
  for (const candidate of new Set([project, secondProject])) {
    try {
      await stopArtifact(candidate, childEnvironment);
    } catch {
      // A normal stop or failed startup may already have removed the runtime state.
    }
  }
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Normal stop or expected startup rejection already reaped the process.
    }
  }
  await Promise.all(children.map(async (child) => {
    try {
      await withTimeout(child.status, 15_000, "release smoke child cleanup");
    } catch {
      // Preserve the primary smoke result; directory cleanup remains the final leak detector.
    }
  }));
  if (Deno.env.get("MINIBASE_RELEASE_KEEP_TEMP") === "1") {
    console.error(`Preserved release smoke directory: ${temp}`);
  } else {
    await removeTreeWithRetries(temp);
  }
}

interface ReleaseManifest {
  formatVersion: number;
  version: string;
  edition: string;
  platform: string;
  target: string;
  source: { commit: string; dirty: boolean };
  toolchain: { deno: string; pglite: string; postgres?: string };
  artifact: { fileName: string; bytes: number; sha256: string };
  licenses: { fileName: string; bytes: number; sha256: string };
  verification: { macosAdHocSignatureNormalized: boolean };
  bundledPostgresRuntime?: {
    version: string;
    platform: string;
    fileCount: number;
    extractedBytes: number;
    excluded: string[];
    packages: Array<{ name: string; version: string }>;
  };
}

interface RuntimeState {
  apiUrl: string;
}

async function assertReproducibleRebuild(first: ReleaseManifest): Promise<void> {
  const rebuilt = await new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: ["task", BUILD_TASK],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(rebuilt.success, true, decode(rebuilt.stderr));
  const second = JSON.parse(
    await Deno.readTextFile(join(OUTPUT_DIR, "release-manifest.json")),
  ) as ReleaseManifest;
  assertEquals(second.source, first.source);
  assertEquals(second.artifact, first.artifact);
  assertEquals(await sha256File(ARTIFACT), first.artifact.sha256);
}

async function assertSupabaseFixture(project: string, apiUrl: string): Promise<void> {
  const anonKey = await roleToken(project, "anon");
  const serviceRoleKey = await roleToken(project, "service_role");
  const client = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signup = await client.auth.signUp({
    email: "release-smoke@example.com",
    password: "correct horse battery staple",
    options: { data: { display_name: "Release Smoke" } },
  });
  assertEquals(signup.error, null);
  assert(signup.data.user !== null);
  assert(signup.data.session !== null);

  const inserted = await client.from("notes").insert({
    owner_id: signup.data.user.id,
    body: "compiled artifact note",
  }).select("id,body").single();
  assertEquals(inserted.error, null);
  assertEquals(inserted.data?.body, "compiled artifact note");
  const updated = await client.from("notes").update({ body: "compiled artifact updated" })
    .eq("id", inserted.data!.id).select("body").single();
  assertEquals(updated.error, null);
  assertEquals(updated.data?.body, "compiled artifact updated");

  const other = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const otherSignup = await other.auth.signUp({
    email: "release-smoke-other@example.com",
    password: "correct horse battery staple",
    options: { data: { display_name: "Other User" } },
  });
  assertEquals(otherSignup.error, null);
  assert(otherSignup.data.user !== null);
  const otherInsert = await other.from("notes").insert({
    owner_id: otherSignup.data.user.id,
    body: "other user note",
  });
  assertEquals(otherInsert.error, null);
  const visible = await client.from("notes").select("body").in("body", [
    "compiled artifact updated",
    "other user note",
  ]);
  assertEquals(visible.error, null);
  assertEquals(visible.data, [{ body: "compiled artifact updated" }]);

  const service = createClient(apiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const bucket = await service.storage.createBucket("avatars", { public: false });
  assertEquals(bucket.error, null);
  const upload = await client.storage.from("avatars").upload(
    "release.txt",
    new Blob(["compiled local storage"], { type: "text/plain" }),
  );
  assertEquals(upload.error, null);
  const download = await client.storage.from("avatars").download("release.txt");
  assertEquals(download.error, null);
  assertEquals(await download.data?.text(), "compiled local storage");
  assertEquals(
    await Deno.readTextFile(join(project, ".minibase", "storage", "avatars", "release.txt")),
    "compiled local storage",
  );

  const invoked = await client.functions.invoke("release-alias", {
    body: { compiled: true },
  });
  assertEquals(invoked.error, null);
  assertEquals(invoked.data, {
    marker: "external-deno-json-import-map",
    body: { compiled: true },
  });

  const cliGenerated = await client.functions.invoke("compatibility-probe", {
    body: { name: "Functions" },
  });
  assertEquals(cliGenerated.error, null);
  assertEquals(cliGenerated.data, { message: "Hello Functions!" });

  await assertSupabaseServerWorkerContract({
    apiUrl,
    anonKey,
    serviceRoleKey,
    prefix: `${EDITION}-release`,
  });

  const removed = await client.from("notes").delete().eq("id", inserted.data!.id)
    .select("body").single();
  assertEquals(removed.error, null);
  assertEquals(removed.data?.body, "compiled artifact updated");
}

async function roleToken(project: string, role: "anon" | "service_role"): Promise<string> {
  const secrets = normalizeAuthSecrets(
    JSON.parse(await Deno.readTextFile(join(project, ".minibase", "secrets.json"))),
  );
  const now = Math.floor(Date.now() / 1_000);
  return await signJwt(
    { role, iat: now, exp: now + 3_600 },
    activeAuthSigningKey(secrets),
  );
}

async function addFunctionFixtures(project: string): Promise<void> {
  const shared = join(project, "supabase", "functions", "_shared");
  const functionDir = join(project, "supabase", "functions", "release-alias");
  await Deno.mkdir(shared, { recursive: true });
  await Deno.mkdir(functionDir, { recursive: true });
  await Deno.writeTextFile(
    join(project, "supabase", "deno.json"),
    `${
      JSON.stringify(
        { imports: { "release-alias": "./functions/_shared/release_alias.ts" } },
        null,
        2,
      )
    }\n`,
  );
  await Deno.writeTextFile(
    join(shared, "release_alias.ts"),
    'export const marker = "external-deno-json-import-map";\n',
  );
  await Deno.writeTextFile(
    join(functionDir, "index.ts"),
    [
      'import { marker } from "release-alias";',
      "Deno.serve(async (request) => Response.json({",
      "  marker,",
      "  body: await request.json(),",
      "}));",
      "",
    ].join("\n"),
  );
  const cliFunctionDir = join(project, "supabase", "functions", "compatibility-probe");
  await Deno.mkdir(cliFunctionDir, { recursive: true });
  await copyTree(
    join(
      ROOT,
      "fixtures",
      "supabase-cli-2.110.0-function",
      "supabase",
      "functions",
      "compatibility-probe",
    ),
    cliFunctionDir,
  );
  await installSupabaseServerContextFixture(project);
}

function startArtifact(
  project: string,
  port: number,
  environment: Record<string, string>,
): Deno.ChildProcess {
  return new Deno.Command(ARTIFACT, {
    cwd: project,
    clearEnv: true,
    args: [
      "start",
      "--project",
      project,
      "--engine",
      ENGINE,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    env: artifactEnvironment(environment),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function stopArtifact(
  project: string,
  environment: Record<string, string>,
): Promise<void> {
  const result = await runArtifact(["stop", "--project", project, "--engine", ENGINE, "--json"], {
    cwd: project,
    env: artifactEnvironment(environment),
  });
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.stderr, "");
  assertEquals((JSON.parse(result.stdout) as { stopped: boolean }).stopped, true);
}

async function assertBundledPostgresDiagnostics(
  project: string,
  environment: Record<string, string>,
): Promise<void> {
  const doctor = await runArtifact(
    ["doctor", "--project", project, "--engine", "postgres", "--json"],
    { cwd: project, env: artifactEnvironment(environment) },
  );
  assertEquals(doctor.code, 0, doctor.stderr);
  assertEquals(doctor.stderr, "");
  const doctorReport = JSON.parse(doctor.stdout) as {
    ok?: unknown;
    checks?: Array<{ code?: unknown; severity?: unknown }>;
  };
  assertEquals(doctorReport.ok, true);
  assertEquals(
    doctorReport.checks?.some((check) =>
      check.code === "database.runtime" && check.severity === "error"
    ),
    false,
  );
  for (const extension of ["pgcrypto", "uuid-ossp"]) {
    assertEquals(
      doctorReport.checks?.some((check) =>
        check.code === `database.extension.${extension}` && check.severity === "info"
      ),
      true,
      `Bundled PostgreSQL Runtime must report ${extension} as available`,
    );
  }

  const migration = await runArtifact(
    ["migration", "check", "--project", project, "--engine", "postgres", "--json"],
    { cwd: project, env: artifactEnvironment(environment) },
  );
  assertEquals(migration.code, 0, migration.stderr);
  assertEquals(migration.stderr, "");
  const migrationReport = JSON.parse(migration.stdout) as {
    ok?: unknown;
    complete?: unknown;
    engines?: Array<{ engine?: unknown; executed?: unknown }>;
  };
  assertEquals(migrationReport.ok, true);
  assertEquals(migrationReport.complete, true);
  assertEquals(
    migrationReport.engines?.map((engine) => ({
      engine: engine.engine,
      executed: engine.executed,
    })),
    [
      { engine: "pglite", executed: true },
      { engine: "postgres", executed: true },
    ],
  );
}

function artifactEnvironment(environment: Record<string, string>): Record<string, string> {
  const inherited = Deno.env.toObject();
  // The Server build needs an external source Runtime, but the compiled artifact
  // must prove that it starts from its own bundled Runtime during the smoke.
  for (const name of Object.keys(inherited)) {
    if (name.toUpperCase().startsWith("MINIBASE_")) delete inherited[name];
  }
  return {
    ...inherited,
    ...environment,
    ...(EDITION === "server" ? { MINIBASE_POSTGRES_PORT: String(availablePort()) } : {}),
  };
}

async function runArtifact(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(ARTIFACT, {
    args,
    cwd: options.cwd,
    clearEnv: true,
    env: options.env ?? artifactEnvironment({}),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decode(output.stdout).trim(),
    stderr: decode(output.stderr),
  };
}

async function waitForRuntime(project: string, child: Deno.ChildProcess): Promise<RuntimeState> {
  const runtimePath = join(project, ".minibase", "runtime.json");
  for (let attempt = 0; attempt < RUNTIME_START_TIMEOUT_MS / 50; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(runtimePath)) as RuntimeState;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const exited = await Promise.race([
      child.status.then((status) => status),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    if (exited !== null) {
      const output = await child.output();
      throw new Error(
        `Compiled Minibase exited during startup (${exited.code}): ${decode(output.stderr)}`,
      );
    }
  }
  throw new Error(
    `Timed out after ${RUNTIME_START_TIMEOUT_MS} ms waiting for compiled Minibase runtime state ` +
      `at ${runtimePath}`,
  );
}

async function assertHealth(apiUrl: string, engine: "pglite" | "postgres"): Promise<void> {
  const live = await fetch(new URL("/health/live", apiUrl));
  assertEquals(live.status, 200);
  assertEquals(await live.json(), {
    status: "live",
    version: MINIBASE_VERSION,
    engine,
  });
  const ready = await fetch(new URL("/health/ready", apiUrl));
  assertEquals(ready.status, 200);
  const readiness = await ready.json();
  assertEquals(readiness.status, "ready");
  assertEquals(readiness.engine, engine);
  assertEquals(readiness.checks.storage, { ready: true, driver: "local" });
  assertEquals(readiness.checks.functions, { ready: true });
}

async function assertSecretPermissions(path: string): Promise<void> {
  if (PLATFORM.os !== "windows") {
    const stat = await Deno.stat(path);
    assert(stat.mode !== null);
    assertEquals(stat.mode & 0o077, 0, "Secret file must not grant group or other permissions");
    return;
  }
  const powershell = await new Deno.Command("powershell.exe", {
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-Acl -LiteralPath $env:MINIBASE_ACL_TARGET | Out-Null",
    ],
    env: windowsPowerShellEnvironment(path),
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(powershell.success, true, decode(powershell.stderr));
  const icacls = await new Deno.Command("icacls.exe", {
    args: [path],
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(icacls.success, true, decode(icacls.stderr));
}

async function assertChildSuccess(child: Deno.ChildProcess): Promise<void> {
  const output = await withTimeout(child.output(), 15_000, "compiled Minibase shutdown");
  assertEquals(output.success, true, decode(output.stderr));
  assertEquals(decode(output.stderr), "");
}

async function runtimeRecord(path: string): Promise<{ sha256: string; mtime: number }> {
  const stat = await Deno.stat(path);
  assert(stat.mtime !== null);
  return { sha256: await sha256File(path), mtime: stat.mtime.getTime() };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(1024 * 1024);
    while (true) {
      const read = await file.read(buffer);
      if (read === null) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

async function removeTreeWithRetries(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.Busy) &&
        !(error instanceof Deno.errors.PermissionDenied)
      ) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 50 * (attempt + 1))));
    }
  }
  throw lastError;
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

interface SmokeOptions {
  edition: "embedded" | "server";
  platform?: string;
}

function parseOptions(args: string[]): SmokeOptions {
  let edition: "embedded" | "server" = "embedded";
  let platform: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw smokeUsageError();
    if (flag === "--edition" && (value === "embedded" || value === "server")) {
      edition = value;
      continue;
    }
    if (flag === "--platform") {
      platform = value;
      continue;
    }
    throw smokeUsageError();
  }
  return { edition, platform };
}

function smokeUsageError(): Error {
  return new Error(
    "Usage: smoke_release.ts [--edition embedded|server] " +
      "[--platform windows-x64|linux-x64|macos-x64|macos-arm64]",
  );
}

function releaseEnvironment(
  temp: string,
  cacheHome: string,
  platform: ReleasePlatformDescriptor,
): Record<string, string> {
  if (platform.os === "windows") {
    return { LOCALAPPDATA: cacheHome, DENO_NO_UPDATE_CHECK: "1" };
  }
  return {
    XDG_CACHE_HOME: cacheHome,
    HOME: join(temp, "home"),
    DENO_NO_UPDATE_CHECK: "1",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
