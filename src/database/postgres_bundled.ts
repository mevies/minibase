import { dirname, isAbsolute, join } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../../toolchain.json" with { type: "json" };
import { currentReleasePlatform } from "../release/platform.ts";

export const POSTGRES_RUNTIME_ARCHIVE_MAGIC = "MINIBASE_POSTGRES_RUNTIME_V1\n";

const POSTGRES_VERSION = toolchain.components.postgres.required;
let standaloneRuntime: Promise<string> | undefined;

export interface PostgresRuntimeFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PostgresRuntimeManifest {
  formatVersion: 1;
  product: "postgresql-runtime";
  version: string;
  platform: string;
  archiveSha256: string;
  treeSha256: string;
  files: PostgresRuntimeFileRecord[];
}

export interface BundledPostgresRuntimeOptions {
  cacheRoot: string;
  archive: URL | string;
  manifest: URL | string;
}

export async function bundledPostgresRuntime(): Promise<string | null> {
  if (!Deno.build.standalone) return null;
  const bundled = bundledPostgresDescriptor();
  try {
    if (!(await Deno.stat(bundled.manifest)).isFile) return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  standaloneRuntime ??= ensureBundledPostgresRuntime({
    cacheRoot: runtimeCacheRoot(),
    archive: bundled.archive,
    manifest: bundled.manifest,
  });
  return await standaloneRuntime;
}

function bundledPostgresDescriptor(): { archive: URL; manifest: URL } {
  const platform = currentReleasePlatform();
  return {
    archive: new URL(
      `../../release/assets/postgresql-${POSTGRES_VERSION}-${platform.name}.mbpg.gz`,
      import.meta.url,
    ),
    manifest: new URL(
      `../../release/assets/postgresql-${POSTGRES_VERSION}-${platform.name}.json`,
      import.meta.url,
    ),
  };
}

export async function resolvePostgresRuntimePath(
  configuredPath: string | undefined,
): Promise<string | null> {
  return configuredPath ?? await bundledPostgresRuntime();
}

export async function ensureBundledPostgresRuntime(
  options: BundledPostgresRuntimeOptions,
): Promise<string> {
  if (!isAbsolute(options.cacheRoot)) {
    throw new Error("PostgreSQL Runtime cache root must be absolute");
  }
  const manifest = await loadManifest(options.manifest);
  const runtimeParent = join(
    options.cacheRoot,
    "postgresql",
    manifest.version,
  );
  const runtimeDir = join(runtimeParent, manifest.platform);
  await Deno.mkdir(runtimeParent, { recursive: true });
  const lock = await Deno.open(join(runtimeParent, `${manifest.platform}.extract.lock`), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(true);
  try {
    if (await pathExists(runtimeDir)) {
      await assertRuntimeIntegrity(runtimeDir, manifest);
      return runtimeDir;
    }

    const archiveSha256 = await sha256File(options.archive);
    if (archiveSha256 !== manifest.archiveSha256) {
      throw new Error(
        `Embedded PostgreSQL Runtime archive SHA-256 mismatch: expected ${manifest.archiveSha256}, got ${archiveSha256}`,
      );
    }
    const temporary = `${runtimeDir}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.mkdir(temporary, { recursive: true, mode: 0o700 });
      await extractArchive(options.archive, temporary, manifest);
      await verifyRuntime(temporary, manifest);
      await Deno.rename(temporary, runtimeDir);
      return runtimeDir;
    } finally {
      await Deno.remove(temporary, { recursive: true }).catch(ignoreNotFound);
    }
  } finally {
    await lock.unlock();
    lock.close();
  }
}

export function postgresRuntimeTreeSha256(files: PostgresRuntimeFileRecord[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.bytes));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function loadManifest(source: URL | string): Promise<PostgresRuntimeManifest> {
  const parsed = JSON.parse(await Deno.readTextFile(source)) as Partial<PostgresRuntimeManifest>;
  if (
    parsed.formatVersion !== 1 || parsed.product !== "postgresql-runtime" ||
    typeof parsed.version !== "string" || !/^[0-9]+(?:\.[0-9]+){1,2}$/u.test(parsed.version) ||
    parsed.platform !== "windows-x64" && parsed.platform !== "linux-x64" &&
      parsed.platform !== "macos-x64" && parsed.platform !== "macos-arm64" ||
    typeof parsed.archiveSha256 !== "string" || !isSha256(parsed.archiveSha256) ||
    typeof parsed.treeSha256 !== "string" || !isSha256(parsed.treeSha256) ||
    !Array.isArray(parsed.files) || parsed.files.length === 0
  ) {
    throw new Error("Bundled PostgreSQL Runtime manifest is invalid");
  }
  const files = parsed.files.map((file) => validateFileRecord(file));
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`Duplicate PostgreSQL Runtime path: ${file.path}`);
    paths.add(file.path);
  }
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (files.some((file, index) => file.path !== sorted[index]?.path)) {
    throw new Error("Bundled PostgreSQL Runtime manifest files are not sorted");
  }
  if (postgresRuntimeTreeSha256(files) !== parsed.treeSha256) {
    throw new Error("Bundled PostgreSQL Runtime manifest tree SHA-256 is invalid");
  }
  const executableSuffix = parsed.platform === "windows-x64" ? ".exe" : "";
  const executableRoot = parsed.platform === "linux-x64"
    ? `usr/lib/postgresql/${parsed.version.split(".", 1)[0]!}/bin`
    : "bin";
  for (
    const required of ["postgres", "initdb", "pg_ctl"].map((name) =>
      `${executableRoot}/${name}${executableSuffix}`
    )
  ) {
    if (!paths.has(required)) throw new Error(`Bundled PostgreSQL Runtime is missing ${required}`);
  }
  return {
    formatVersion: 1,
    product: "postgresql-runtime",
    version: parsed.version,
    platform: parsed.platform,
    archiveSha256: parsed.archiveSha256,
    treeSha256: parsed.treeSha256,
    files,
  };
}

function validateFileRecord(value: unknown): PostgresRuntimeFileRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Bundled PostgreSQL Runtime file record is invalid");
  }
  const file = value as Partial<PostgresRuntimeFileRecord>;
  if (
    typeof file.path !== "string" || !safeArchivePath(file.path) ||
    typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
    typeof file.sha256 !== "string" || !isSha256(file.sha256)
  ) {
    throw new Error("Bundled PostgreSQL Runtime file record is invalid");
  }
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

async function assertRuntimeIntegrity(
  runtimeDir: string,
  manifest: PostgresRuntimeManifest,
): Promise<void> {
  try {
    await verifyRuntime(runtimeDir, manifest);
  } catch (error) {
    throw new Error(
      `Bundled PostgreSQL Runtime integrity check failed at ${runtimeDir}: ${
        errorMessage(error)
      }; ` +
        `remove ${runtimeDir} and restart Minibase to restore the versioned Runtime`,
    );
  }
}

async function verifyRuntime(
  runtimeDir: string,
  manifest: PostgresRuntimeManifest,
): Promise<void> {
  await verifyRuntimeTree(runtimeDir, manifest);
  for (const file of manifest.files) {
    const path = archiveDestination(runtimeDir, file.path);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error(`missing ${file.path}`);
      throw error;
    }
    if (!stat.isFile || stat.size !== file.bytes) {
      throw new Error(`unexpected size or type for ${file.path}`);
    }
    const actual = await sha256File(path);
    if (actual !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.path}`);
  }
}

async function verifyRuntimeTree(
  runtimeDir: string,
  manifest: PostgresRuntimeManifest,
): Promise<void> {
  const files = new Set(manifest.files.map((file) => file.path));
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length++) {
      directories.add(parts.slice(0, length).join("/"));
    }
  }
  await walkRuntimeTree(runtimeDir, "", files, directories);
}

async function walkRuntimeTree(
  root: string,
  prefix: string,
  files: Set<string>,
  directories: Set<string>,
): Promise<void> {
  for await (const entry of Deno.readDir(join(root, ...prefix.split("/").filter(Boolean)))) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) throw new Error(`unexpected symbolic link ${path}`);
    if (entry.isFile) {
      if (!files.has(path)) throw new Error(`unexpected file ${path}`);
      continue;
    }
    if (entry.isDirectory) {
      if (!directories.has(path)) throw new Error(`unexpected directory ${path}`);
      await walkRuntimeTree(root, path, files, directories);
      continue;
    }
    throw new Error(`unexpected filesystem entry ${path}`);
  }
}

async function extractArchive(
  archivePath: URL | string,
  destination: string,
  manifest: PostgresRuntimeManifest,
): Promise<void> {
  const archive = await Deno.open(archivePath, { read: true });
  const reader = new BufferedReader(
    archive.readable.pipeThrough(new DecompressionStream("gzip")).getReader(),
  );
  const magic = new TextEncoder().encode(POSTGRES_RUNTIME_ARCHIVE_MAGIC);
  const actualMagic = await reader.readExactly(magic.byteLength);
  if (!bytesEqual(actualMagic, magic)) throw new Error("Invalid PostgreSQL Runtime archive header");

  for (const expected of manifest.files) {
    const pathLength = uint32(await reader.readExactly(4));
    if (pathLength === 0 || pathLength > 4_096) {
      throw new Error("Invalid PostgreSQL Runtime archive path length");
    }
    const bytes = uint64(await reader.readExactly(8));
    const digest = hex(await reader.readExactly(32));
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      await reader.readExactly(pathLength),
    );
    if (path !== expected.path || bytes !== expected.bytes || digest !== expected.sha256) {
      throw new Error(`PostgreSQL Runtime archive manifest mismatch at ${expected.path}`);
    }
    const targetPath = archiveDestination(destination, path);
    await Deno.mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const target = await Deno.open(targetPath, { createNew: true, write: true, mode: 0o700 });
    const hash = createHash("sha256");
    try {
      await reader.copyExactly(bytes, target, hash);
    } finally {
      target.close();
    }
    if (hash.digest("hex") !== expected.sha256) {
      throw new Error(`PostgreSQL Runtime archive data mismatch at ${path}`);
    }
  }
  if (uint32(await reader.readExactly(4)) !== 0) {
    throw new Error("PostgreSQL Runtime archive contains unexpected files");
  }
  if (!(await reader.atEnd())) throw new Error("PostgreSQL Runtime archive has trailing data");
}

class BufferedReader {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async readExactly(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.#buffer.byteLength === 0) await this.#readChunk();
      const take = Math.min(length - offset, this.#buffer.byteLength);
      output.set(this.#buffer.subarray(0, take), offset);
      this.#buffer = this.#buffer.subarray(take);
      offset += take;
    }
    return output;
  }

  async copyExactly(length: number, target: Deno.FsFile, hash: ReturnType<typeof createHash>) {
    let remaining = length;
    while (remaining > 0) {
      if (this.#buffer.byteLength === 0) await this.#readChunk();
      const take = Math.min(remaining, this.#buffer.byteLength);
      const chunk = this.#buffer.subarray(0, take);
      await writeAll(target, chunk);
      hash.update(chunk);
      this.#buffer = this.#buffer.subarray(take);
      remaining -= take;
    }
  }

  async atEnd(): Promise<boolean> {
    if (this.#buffer.byteLength > 0) return false;
    const next = await this.reader.read();
    return next.done === true;
  }

  async #readChunk(): Promise<void> {
    const next = await this.reader.read();
    if (next.done || next.value === undefined) {
      throw new Error("Unexpected end of PostgreSQL Runtime archive");
    }
    this.#buffer = next.value;
  }
}

function runtimeCacheRoot(): string {
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA");
    if (localAppData === undefined || !isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path for the bundled PostgreSQL Runtime");
    }
    return join(localAppData, "minibase", "runtimes");
  }
  const configured = Deno.env.get("XDG_CACHE_HOME");
  if (configured !== undefined && isAbsolute(configured)) {
    return join(configured, "minibase", "runtimes");
  }
  const home = Deno.env.get("HOME");
  if (home === undefined || !isAbsolute(home)) {
    throw new Error("HOME must be an absolute path for the bundled PostgreSQL Runtime");
  }
  return join(home, ".cache", "minibase", "runtimes");
}

function archiveDestination(root: string, path: string): string {
  if (!safeArchivePath(path)) throw new Error(`Unsafe PostgreSQL Runtime archive path: ${path}`);
  return join(root, ...path.split("/"));
}

function safeArchivePath(path: string): boolean {
  if (
    path.includes("\\") || path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  const windowsPath = /^(?:bin|lib|share)\/[0-9A-Za-z._+ -]+(?:\/[0-9A-Za-z._+ -]+)*$/u;
  const linuxPath =
    /^usr\/(?:lib\/postgresql\/[0-9]+\/(?:bin|lib)|share\/postgresql\/[0-9]+|lib\/x86_64-linux-gnu)\/[0-9A-Za-z._+ -]+(?:\/[0-9A-Za-z._+ -]+)*$/u;
  return windowsPath.test(path) || linuxPath.test(path);
}

function uint32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

function uint64(bytes: Uint8Array): number {
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("PostgreSQL Runtime file is too large");
  return number;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) offset += await file.write(bytes.subarray(offset));
}

async function sha256File(path: URL | string): Promise<string> {
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

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
