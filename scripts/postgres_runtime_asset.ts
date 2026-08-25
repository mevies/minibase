import { fromFileUrl, isAbsolute, join, relative } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  POSTGRES_RUNTIME_ARCHIVE_MAGIC,
  type PostgresRuntimeFileRecord,
  type PostgresRuntimeManifest,
  postgresRuntimeTreeSha256,
} from "../src/database/postgres_bundled.ts";
import { currentReleasePlatform, releasePlatformLabel } from "../src/release/platform.ts";
import {
  type LinuxPostgresPackage,
  type LinuxPostgresSource,
  prepareLinuxPostgresSource,
} from "./postgres_linux_source.ts";
import { assertPinnedLinuxRuntimeDependency, pathWithin } from "./postgres_linux_policy.ts";
import { type MacosPostgresSource, prepareMacosPostgresSource } from "./postgres_macos_source.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const VERSION = toolchain.components.postgres.required;
const POSTGRES_MAJOR = VERSION.split(".", 1)[0]!;
const PLATFORM = currentReleasePlatform();
const REQUIRED_EXECUTABLES = new Set(
  ["initdb", "pg_ctl", "pg_isready", "postgres"].map((name) => `${name}${PLATFORM.artifactSuffix}`),
);
const REPRODUCIBLE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");
const WINDOWS_ICU_LICENSE = join(ROOT, "release", "ICU_LICENSE.txt");

export interface RuntimePackageRecord {
  name: string;
  version: string;
}

export interface PostgresRuntimeAssets {
  sourceDir: string;
  archivePath: string;
  manifestPath: string;
  licenseFiles: string[];
  licenseHeading: string;
  packages: RuntimePackageRecord[];
  manifest: PostgresRuntimeManifest;
  sourceBytes: number;
}

export async function buildPostgresRuntimeAssets(): Promise<PostgresRuntimeAssets> {
  const source = await findRuntimeSource();
  await assertRuntimeVersion(source);
  const collected = await collectRuntimeFiles(source);
  const selected = collected.files;
  const files: PostgresRuntimeFileRecord[] = [];
  let sourceBytes = 0;
  for (const file of selected) {
    const stat = await Deno.stat(file.source);
    files.push({ path: file.path, bytes: stat.size, sha256: await sha256File(file.source) });
    sourceBytes += stat.size;
  }

  const assetsDir = join(ROOT, "release", "assets");
  await Deno.mkdir(assetsDir, { recursive: true });
  const archivePath = join(assetsDir, `postgresql-${VERSION}-${PLATFORM.name}.mbpg.gz`);
  const manifestPath = join(assetsDir, `postgresql-${VERSION}-${PLATFORM.name}.json`);
  await writeArchive(archivePath, selected, files);
  const manifest: PostgresRuntimeManifest = {
    formatVersion: 1,
    product: "postgresql-runtime",
    version: VERSION,
    platform: PLATFORM.name,
    archiveSha256: await sha256File(archivePath),
    treeSha256: postgresRuntimeTreeSha256(files),
    files,
  };
  await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await Promise.all([
    Deno.utime(archivePath, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP),
    Deno.utime(manifestPath, REPRODUCIBLE_TIMESTAMP, REPRODUCIBLE_TIMESTAMP),
  ]);
  for (const path of collected.licenseFiles) {
    if (!(await Deno.stat(path)).isFile) {
      throw new Error(`PostgreSQL license file is missing: ${path}`);
    }
  }
  return {
    sourceDir: source.sourceDir,
    archivePath,
    manifestPath,
    licenseFiles: collected.licenseFiles,
    licenseHeading: collected.licenseHeading,
    packages: collected.packages,
    manifest,
    sourceBytes,
  };
}

interface SelectedFile {
  source: string;
  path: string;
}

interface RuntimeSource {
  sourceDir: string;
  packageRoot?: string;
  libraryDir?: string;
  shareDir?: string;
  licenseFiles?: string[];
  packages: RuntimePackageRecord[];
}

interface CollectedRuntime {
  files: SelectedFile[];
  licenseFiles: string[];
  licenseHeading: string;
  packages: RuntimePackageRecord[];
}

async function collectRuntimeFiles(source: RuntimeSource): Promise<CollectedRuntime> {
  if (PLATFORM.os === "windows") return await collectWindowsRuntimeFiles(source);
  if (PLATFORM.os === "darwin") return await collectMacosRuntimeFiles(source);
  return await collectLinuxRuntimeFiles(source);
}

async function collectWindowsRuntimeFiles(source: RuntimeSource): Promise<CollectedRuntime> {
  const sourceDir = source.sourceDir;
  const selected: SelectedFile[] = [];
  await walk(join(sourceDir, "bin"), (source) => {
    const name = source.slice(source.lastIndexOf("\\") + 1).toLowerCase();
    if (name.endsWith(".dll") || REQUIRED_EXECUTABLES.has(name)) {
      selected.push({ source, path: runtimePath(sourceDir, source) });
    }
  });
  await walk(join(sourceDir, "lib"), (source) => {
    if (source.toLowerCase().endsWith(".dll")) {
      selected.push({ source, path: runtimePath(sourceDir, source) });
    }
  });
  await walk(join(sourceDir, "share"), (source) => {
    selected.push({ source, path: runtimePath(sourceDir, source) });
  });
  selected.sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const required of REQUIRED_EXECUTABLES) {
    if (!selected.some((file) => file.path === `bin/${required}`)) {
      throw new Error(`PostgreSQL Runtime source is missing bin/${required}`);
    }
  }
  return {
    files: selected,
    licenseFiles: [
      join(sourceDir, "server_license.txt"),
      join(sourceDir, "commandlinetools_3rd_party_licenses.txt"),
      WINDOWS_ICU_LICENSE,
    ],
    licenseHeading: `PostgreSQL ${VERSION} Windows x64 Runtime notices`,
    packages: source.packages,
  };
}

async function collectMacosRuntimeFiles(source: RuntimeSource): Promise<CollectedRuntime> {
  if (source.licenseFiles === undefined || source.licenseFiles.length !== 2) {
    throw new Error("PostgreSQL macOS Runtime source must provide PostgreSQL and OpenSSL licenses");
  }
  const selected: SelectedFile[] = [];
  for (const executable of REQUIRED_EXECUTABLES) {
    selected.push({
      source: join(source.sourceDir, "bin", executable),
      path: `bin/${executable}`,
    });
  }
  await walk(join(source.sourceDir, "lib"), (path) => {
    if (path.endsWith(".dylib") || path.endsWith(".so")) {
      selected.push({ source: path, path: runtimePath(source.sourceDir, path) });
    }
  });
  await walk(join(source.sourceDir, "share"), (path) => {
    selected.push({ source: path, path: runtimePath(source.sourceDir, path) });
  });
  for (const required of REQUIRED_EXECUTABLES) {
    if (!(await Deno.stat(join(source.sourceDir, "bin", required))).isFile) {
      throw new Error(`PostgreSQL Runtime source is missing bin/${required}`);
    }
  }
  selected.sort((left, right) => left.path.localeCompare(right.path, "en"));
  assertUniqueRuntimePaths(selected, "macOS");
  return {
    files: selected,
    licenseFiles: source.licenseFiles,
    licenseHeading: `PostgreSQL ${VERSION} ${
      releasePlatformLabel(PLATFORM)
    } Runtime and OpenSSL ${toolchain.components.postgresMacosOpenSsl.required} notices`,
    packages: source.packages,
  };
}

const GLIBC_RUNTIME_LIBRARIES = new Set([
  "ld-linux-x86-64.so.2",
  "libc.so.6",
  "libdl.so.2",
  "libm.so.6",
  "libpthread.so.0",
  "libresolv.so.2",
  "librt.so.1",
]);

async function collectLinuxRuntimeFiles(source: RuntimeSource): Promise<CollectedRuntime> {
  if (source.packageRoot === undefined || source.libraryDir === undefined) {
    throw new Error("PostgreSQL Linux Runtime source is missing its package root");
  }
  const selected: SelectedFile[] = [];
  for (const executable of REQUIRED_EXECUTABLES) {
    selected.push({
      source: join(source.sourceDir, "bin", executable),
      path: `usr/lib/postgresql/${POSTGRES_MAJOR}/bin/${executable}`,
    });
  }
  await walk(join(source.sourceDir, "lib"), (path) => {
    if (path.endsWith(".so")) {
      selected.push({
        source: path,
        path: `usr/lib/postgresql/${POSTGRES_MAJOR}/lib/${path.slice(path.lastIndexOf("/") + 1)}`,
      });
    }
  });
  const shareDir = source.shareDir ?? join(source.sourceDir, "share");
  await walk(shareDir, (path) => {
    const sharePath = relative(shareDir, path).replaceAll("\\", "/");
    if (sharePath.includes("../")) {
      throw new Error(`PostgreSQL share file escaped the source directory: ${path}`);
    }
    selected.push({
      source: path,
      path: `usr/share/postgresql/${POSTGRES_MAJOR}/${sharePath}`,
    });
  });
  for (const required of REQUIRED_EXECUTABLES) {
    if (!(await Deno.stat(join(source.sourceDir, "bin", required))).isFile) {
      throw new Error(`PostgreSQL Runtime source is missing bin/${required}`);
    }
  }

  const dynamic = await collectLinuxDynamicLibraries(source, selected);
  selected.push(...dynamic.files);
  selected.sort((left, right) => left.path.localeCompare(right.path, "en"));
  assertUniqueRuntimePaths(selected, "Linux");

  const licenseFiles = await linuxLicenseFiles(source);
  return {
    files: selected,
    licenseFiles,
    licenseHeading: `PostgreSQL ${VERSION} Linux x64 Runtime notices`,
    packages: source.packages,
  };
}

function assertUniqueRuntimePaths(selected: SelectedFile[], platform: string): void {
  for (let index = 1; index < selected.length; index++) {
    if (selected[index - 1]!.path === selected[index]!.path) {
      throw new Error(`Duplicate PostgreSQL ${platform} Runtime path: ${selected[index]!.path}`);
    }
  }
}

async function linuxLicenseFiles(source: RuntimeSource): Promise<string[]> {
  const packageRoot = source.packageRoot!;
  const licenses = new Set<string>();
  for (const packageRecord of source.packages) {
    const candidate = join(
      packageRoot,
      "usr",
      "share",
      "doc",
      packageRecord.name,
      "copyright",
    );
    const resolved = await Deno.realPath(candidate);
    if (!pathWithin(packageRoot, resolved) || !(await Deno.stat(resolved)).isFile) {
      throw new Error(`PostgreSQL package license escaped the pinned package root: ${candidate}`);
    }
    licenses.add(resolved);
  }
  return [...licenses].sort((left, right) => left.localeCompare(right, "en"));
}

async function collectLinuxDynamicLibraries(
  source: RuntimeSource,
  runtimeFiles: SelectedFile[],
): Promise<{
  files: SelectedFile[];
}> {
  const libraries = new Map<string, string>();
  for (const runtimeFile of runtimeFiles) {
    if (!(runtimeFile.path.includes("/bin/") || runtimeFile.path.endsWith(".so"))) continue;
    const output = await new Deno.Command("ldd", {
      args: [runtimeFile.source],
      env: { LD_LIBRARY_PATH: source.libraryDir! },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `ldd failed for ${runtimeFile.source}: ${new TextDecoder().decode(output.stderr).trim()}`,
      );
    }
    for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
      if (line.includes("=> not found")) {
        throw new Error(`PostgreSQL Linux Runtime has an unresolved library: ${line.trim()}`);
      }
      const matched = line.match(/^\s*([^\s]+)\s+=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)/u);
      if (matched === null) continue;
      const soname = matched[1]!;
      if (GLIBC_RUNTIME_LIBRARIES.has(soname)) continue;
      const path = await Deno.realPath(matched[2]!);
      if (source.packageRoot === undefined) {
        throw new Error("PostgreSQL Linux Runtime source is missing its package root");
      }
      assertPinnedLinuxRuntimeDependency(source.packageRoot, soname, path);
      const existing = libraries.get(soname);
      if (existing !== undefined && existing !== path) {
        if (await sha256File(existing) !== await sha256File(path)) {
          throw new Error(`Conflicting PostgreSQL Linux Runtime library: ${soname}`);
        }
        continue;
      }
      libraries.set(soname, path);
    }
  }

  const files = [...libraries.entries()].map(([soname, path]) => ({
    source: path,
    path: `usr/lib/x86_64-linux-gnu/${soname}`,
  }));
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { files };
}

async function walk(root: string, onFile: (path: string) => void | Promise<void>): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isSymlink) throw new Error(`PostgreSQL Runtime source contains a symlink: ${path}`);
    if (entry.isDirectory) await walk(path, onFile);
    else if (entry.isFile) await onFile(path);
  }
}

function runtimePath(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/");
  if (!/^(?:bin|lib|share)\//u.test(value) || value.includes("../")) {
    throw new Error(`PostgreSQL Runtime file escaped the source directory: ${path}`);
  }
  return value;
}

async function writeArchive(
  destination: string,
  selected: SelectedFile[],
  records: PostgresRuntimeFileRecord[],
): Promise<void> {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const output = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    const compression = new CompressionStream("gzip");
    const piping = compression.readable.pipeTo(output.writable);
    const writer = compression.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(POSTGRES_RUNTIME_ARCHIVE_MAGIC));
      for (let index = 0; index < selected.length; index++) {
        const source = selected[index]!;
        const record = records[index]!;
        const path = new TextEncoder().encode(record.path);
        await writer.write(entryHeader(path.byteLength, record.bytes, record.sha256));
        await writer.write(path);
        const file = await Deno.open(source.source, { read: true });
        try {
          const buffer = new Uint8Array(1024 * 1024);
          while (true) {
            const read = await file.read(buffer);
            if (read === null) break;
            await writer.write(buffer.subarray(0, read));
          }
        } finally {
          file.close();
        }
      }
      await writer.write(new Uint8Array(4));
      await writer.close();
      await piping;
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      await piping.catch(() => undefined);
      throw error;
    }
    await removeFile(destination);
    await Deno.rename(temporary, destination);
  } finally {
    await removeFile(temporary);
  }
}

function entryHeader(
  pathLength: number,
  bytes: number,
  sha256: string,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  view.setUint32(0, pathLength);
  view.setBigUint64(4, BigInt(bytes));
  header.set(digestBytes(sha256), 12);
  return header;
}

function digestBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid SHA-256 digest: ${value}`);
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

async function findRuntimeSource(): Promise<RuntimeSource> {
  if (PLATFORM.os === "linux") {
    const prepared = await prepareLinuxPostgresSource();
    return linuxRuntimeSource(prepared);
  }
  if (PLATFORM.os === "darwin") {
    return macosRuntimeSource(await prepareMacosPostgresSource());
  }
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    `C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-${VERSION}-windows-x64\\pgsql`,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      if ((await Deno.stat(join(candidate, "bin", "postgres.exe"))).isFile) {
        return {
          sourceDir: candidate,
          packages: [{ name: "postgresql-windows-x64", version: VERSION }],
        };
      }
    } catch {
      // Try the next configured Runtime.
    }
  }
  throw new Error(
    `PostgreSQL ${VERSION} release build requires MINIBASE_POSTGRES_RUNTIME_DIR`,
  );
}

function macosRuntimeSource(prepared: MacosPostgresSource): RuntimeSource {
  return {
    sourceDir: prepared.runtimeDir,
    licenseFiles: prepared.licenseFiles,
    packages: prepared.packages.map(runtimePackageRecord),
  };
}

function linuxRuntimeSource(prepared: LinuxPostgresSource): RuntimeSource {
  return {
    sourceDir: prepared.runtimeDir,
    packageRoot: prepared.packageRoot,
    libraryDir: prepared.libraryDir,
    shareDir: prepared.shareDir,
    packages: prepared.packages.map(runtimePackageRecord),
  };
}

function runtimePackageRecord(
  packageRecord: Pick<LinuxPostgresPackage, "name" | "version">,
): RuntimePackageRecord {
  return { name: packageRecord.name, version: packageRecord.version };
}

async function assertRuntimeVersion(source: RuntimeSource): Promise<void> {
  const executable = join(source.sourceDir, "bin", `postgres${PLATFORM.artifactSuffix}`);
  const output = await new Deno.Command(executable, {
    args: ["--version"],
    env: source.libraryDir === undefined ? undefined : { LD_LIBRARY_PATH: source.libraryDir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const version = new TextDecoder().decode(output.stdout).trim();
  if (!output.success || !version.includes(` ${VERSION}`)) {
    throw new Error(`PostgreSQL Runtime must be ${VERSION}, got ${version}`);
  }
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

async function removeFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
