import { dirname, fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../toolchain.json" with { type: "json" };
import { MINIBASE_VERSION } from "../src/version.ts";
import {
  buildPostgresRuntimeAssets,
  type PostgresRuntimeAssets,
} from "./postgres_runtime_asset.ts";
import {
  currentReleasePlatform,
  denoExecutableSha256,
  denoRuntimeAssetName,
  functionWorkerAssetName,
  releasePlatform,
  type ReleasePlatformDescriptor,
  runtimeCachePath,
} from "../src/release/platform.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const OPTIONS = parseOptions(Deno.args);
const PLATFORM = releasePlatform(OPTIONS.platform ?? currentReleasePlatform().name);
const EDITION = OPTIONS.edition;
const DENO_VERSION = toolchain.runtimes.deno.required;
const DENO_SHA256 = denoExecutableSha256(PLATFORM);
const DENO_ARCHIVE = join(
  ROOT,
  "release",
  "assets",
  denoRuntimeAssetName(DENO_VERSION, PLATFORM),
);
const OUTPUT_DIR = join(ROOT, "dist", PLATFORM.name, EDITION);
const ARTIFACT_NAME = `minibase-${EDITION}-${PLATFORM.name}${PLATFORM.artifactSuffix}`;
const ARTIFACT = join(OUTPUT_DIR, ARTIFACT_NAME);
const LICENSE_SOURCE = join(ROOT, "release", "THIRD_PARTY_LICENSES.txt");
const APACHE_LICENSE_SOURCE = join(ROOT, "release", "APACHE-2.0.txt");
const LICENSE_OUTPUT = join(OUTPUT_DIR, "THIRD_PARTY_LICENSES.txt");
const WORKER_ENTRYPOINT = join(ROOT, "src", "functions", "worker_entry.ts");
const BUNDLED_FUNCTION_WORKER = join(
  ROOT,
  "release",
  "assets",
  functionWorkerAssetName(PLATFORM),
);
const PGLITE_WORKER = join(ROOT, "src", "database", "pglite_worker.ts");
const REPRODUCIBLE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");

if (
  Deno.build.os !== PLATFORM.os || Deno.build.arch !== PLATFORM.arch
) {
  throw new Error(
    `The ${PLATFORM.name} release must be built on ${PLATFORM.os}/${PLATFORM.arch}; ` +
      `current host is ${Deno.build.os}/${Deno.build.arch}`,
  );
}
if (Deno.version.deno !== DENO_VERSION) {
  throw new Error(`Release build requires Deno ${DENO_VERSION}, got ${Deno.version.deno}`);
}

const runtimeSha256 = await sha256File(Deno.execPath());
if (runtimeSha256 !== DENO_SHA256) {
  throw new Error(
    `Deno executable SHA-256 mismatch: expected ${DENO_SHA256}, got ${runtimeSha256}`,
  );
}

await Deno.mkdir(dirname(DENO_ARCHIVE), { recursive: true });
await gzipFile(Deno.execPath(), DENO_ARCHIVE);
await bundleFunctionWorker();
const postgresAssets = EDITION === "server" ? await buildPostgresRuntimeAssets() : null;
await Promise.all([
  Deno.utime(DENO_ARCHIVE, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP),
  Deno.utime(BUNDLED_FUNCTION_WORKER, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP),
]);
const archive = await fileRecord(DENO_ARCHIVE);
await Deno.mkdir(OUTPUT_DIR, { recursive: true });
await removeFile(ARTIFACT);

const includes = [
  BUNDLED_FUNCTION_WORKER,
  PGLITE_WORKER,
  DENO_ARCHIVE,
  ...(postgresAssets === null ? [] : [postgresAssets.archivePath, postgresAssets.manifestPath]),
];
const compile = await new Deno.Command(Deno.execPath(), {
  cwd: ROOT,
  args: [
    "compile",
    "--quiet",
    "--unstable-no-legacy-abort",
    "--allow-all",
    "--cached-only",
    "--frozen=true",
    "--exclude-unused-npm",
    `--app-name=minibase-${EDITION}`,
    "--target",
    PLATFORM.target,
    ...includes.flatMap((path) => ["--include", path]),
    "--output",
    ARTIFACT,
    join(ROOT, "src", "main.ts"),
  ],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!compile.success) {
  throw new Error(`Deno compile failed: ${decode(compile.stderr).trim()}`);
}
await normalizeMacosSignature();

const versionSmoke = await new Deno.Command(ARTIFACT, {
  args: ["version", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!versionSmoke.success || versionSmoke.stderr.byteLength !== 0) {
  throw new Error(
    `Compiled version smoke failed: ${decode(versionSmoke.stderr).trim()}`,
  );
}
const versionPayload = JSON.parse(decode(versionSmoke.stdout)) as { version?: unknown };
if (versionPayload.version !== MINIBASE_VERSION) {
  throw new Error("Compiled version smoke returned an unexpected Minibase version");
}

if (postgresAssets === null) await writeSharedLicenses(LICENSE_OUTPUT);
else await writeServerLicenses(postgresAssets, LICENSE_OUTPUT);
const artifact = await fileRecord(ARTIFACT);
const license = await fileRecord(LICENSE_OUTPUT);
const workerSource = await fileRecord(WORKER_ENTRYPOINT);
const workerBundle = await fileRecord(BUNDLED_FUNCTION_WORKER);
const pgliteWorker = await fileRecord(PGLITE_WORKER);
const source = await gitSourceState();
const manifest = {
  formatVersion: 1,
  product: "minibase",
  version: MINIBASE_VERSION,
  edition: EDITION,
  platform: PLATFORM.name,
  target: PLATFORM.target,
  source,
  toolchain: {
    deno: DENO_VERSION,
    pglite: toolchain.components.pglite.required,
    postgres: postgresAssets?.manifest.version,
  },
  artifact: {
    fileName: ARTIFACT_NAME,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  },
  bundledFunctionRuntime: {
    version: DENO_VERSION,
    executableSha256: runtimeSha256,
    archiveBytes: archive.bytes,
    archiveSha256: archive.sha256,
    cachePath: runtimeCachePath(DENO_VERSION, PLATFORM),
    workerSourceSha256: workerSource.sha256,
    workerBundleSha256: workerBundle.sha256,
  },
  embeddedModules: {
    pgliteWorkerSha256: pgliteWorker.sha256,
  },
  bundledPostgresRuntime: postgresAssets === null ? undefined : {
    version: postgresAssets.manifest.version,
    platform: postgresAssets.manifest.platform,
    archiveBytes: (await Deno.stat(postgresAssets.archivePath)).size,
    archiveSha256: postgresAssets.manifest.archiveSha256,
    treeSha256: postgresAssets.manifest.treeSha256,
    fileCount: postgresAssets.manifest.files.length,
    extractedBytes: postgresAssets.sourceBytes,
    cachePath: postgresRuntimeCachePath(postgresAssets.manifest.version, PLATFORM),
    packages: postgresAssets.packages,
    excluded: postgresRuntimeExclusions(PLATFORM),
  },
  licenses: {
    fileName: "THIRD_PARTY_LICENSES.txt",
    bytes: license.bytes,
    sha256: license.sha256,
  },
  verification: {
    versionJson: true,
    compiledWithCachedDependenciesOnly: true,
    unusedNpmPackagesExcluded: true,
    generatedInputTimestampsNormalized: true,
    macosAdHocSignatureNormalized: PLATFORM.os === "darwin",
    postgresRuntimeTrimmed: postgresAssets !== null,
  },
};
await Deno.writeTextFile(
  join(OUTPUT_DIR, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await Deno.writeTextFile(
  join(OUTPUT_DIR, `${ARTIFACT_NAME}.sha256`),
  `${artifact.sha256}  ${ARTIFACT_NAME}\n`,
);

console.log(JSON.stringify({ ok: true, outputDir: OUTPUT_DIR, ...manifest.artifact }));

type Edition = "embedded" | "server";

interface BuildOptions {
  edition: Edition;
  platform?: string;
}

function parseOptions(args: string[]): BuildOptions {
  let edition: Edition = "embedded";
  let platform: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw usageError();
    if (flag === "--edition" && (value === "embedded" || value === "server")) {
      edition = value;
      continue;
    }
    if (flag === "--platform") {
      platform = value;
      continue;
    }
    throw usageError();
  }
  return { edition, platform };
}

function usageError(): Error {
  return new Error(
    "Usage: build_release.ts [--edition embedded|server] " +
      "[--platform windows-x64|linux-x64|macos-x64|macos-arm64]",
  );
}

async function writeServerLicenses(
  postgresAssets: PostgresRuntimeAssets,
  destination: string,
): Promise<void> {
  const sections = [
    await sharedLicenses(),
    "\n-------------------------------------------------------------------------------\n" +
    `${postgresAssets.licenseHeading}\n` +
    "The following notices are copied from the Runtime distribution.\n" +
    "-------------------------------------------------------------------------------\n\n",
  ];
  for (const licenseFile of postgresAssets.licenseFiles) {
    sections.push(await Deno.readTextFile(licenseFile), "\n");
  }
  await Deno.writeTextFile(destination, sections.join(""));
}

function postgresRuntimeCachePath(
  version: string,
  platform: ReleasePlatformDescriptor,
): string {
  if (platform.os === "windows") {
    return `%LOCALAPPDATA%\\minibase\\runtimes\\postgresql\\${version}\\${platform.name}`;
  }
  return `$XDG_CACHE_HOME/minibase/runtimes/postgresql/${version}/${platform.name}`;
}

function postgresRuntimeExclusions(platform: ReleasePlatformDescriptor): string[] {
  if (platform.os === "windows") {
    return ["doc", "include", "pgAdmin 4", "StackBuilder", "static libraries"];
  }
  if (platform.os === "darwin") {
    return [
      "documentation",
      "headers",
      "static libraries",
      "unused client tools",
      "optional non-system libraries",
    ];
  }
  return ["documentation", "headers", "JIT", "unused client tools", "glibc"];
}

async function normalizeMacosSignature(): Promise<void> {
  if (PLATFORM.os !== "darwin") return;
  const result = await new Deno.Command("codesign", {
    args: [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--preserve-metadata=entitlements,requirements,flags,runtime",
      "--identifier",
      `dev.minibase.${EDITION}`,
      ARTIFACT,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`macOS ad-hoc signature normalization failed: ${decode(result.stderr).trim()}`);
  }
}

async function writeSharedLicenses(destination: string): Promise<void> {
  await Deno.writeTextFile(destination, await sharedLicenses());
}

async function sharedLicenses(): Promise<string> {
  return [
    await Deno.readTextFile(LICENSE_SOURCE),
    "\n-------------------------------------------------------------------------------\n" +
    "Apache License 2.0 for PGlite 0.5.4\n" +
    "-------------------------------------------------------------------------------\n\n",
    await Deno.readTextFile(APACHE_LICENSE_SOURCE),
    "\n",
  ].join("");
}

async function gzipFile(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const input = await Deno.open(source, { read: true });
    const output = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    await input.readable.pipeThrough(new CompressionStream("gzip")).pipeTo(output.writable);
    await removeFile(destination);
    await Deno.rename(temporary, destination);
  } finally {
    await removeFile(temporary);
  }
}

async function bundleFunctionWorker(): Promise<void> {
  await removeFile(BUNDLED_FUNCTION_WORKER);
  const bundled = await new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: [
      "bundle",
      "--quiet",
      "--no-remote",
      "--no-npm",
      "--frozen=true",
      "--platform=deno",
      "--format=esm",
      "--output",
      BUNDLED_FUNCTION_WORKER,
      WORKER_ENTRYPOINT,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!bundled.success) {
    throw new Error(`Function worker bundle failed: ${decode(bundled.stderr).trim()}`);
  }
}

async function fileRecord(path: string): Promise<{ bytes: number; sha256: string }> {
  return { bytes: (await Deno.stat(path)).size, sha256: await sha256File(path) };
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

async function gitSourceState(): Promise<{ commit: string; dirty: boolean }> {
  const commit = await git(["rev-parse", "HEAD"]);
  const status = await git(["status", "--porcelain"]);
  return { commit, dirty: status.length > 0 };
}

async function git(args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    cwd: ROOT,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(`git ${args.join(" ")} failed: ${decode(output.stderr)}`);
  return decode(output.stdout).trim();
}

async function removeFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
