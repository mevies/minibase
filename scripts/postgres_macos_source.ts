import { basename, dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../toolchain.json" with { type: "json" };
import { currentReleasePlatform } from "../src/release/platform.ts";

const POSTGRES_VERSION = toolchain.components.postgres.required;
const OPENSSL_VERSION = toolchain.components.postgresMacosOpenSsl.required;
const MINIMUM_MACOS_VERSION = toolchain.components.postgres.macosMinimumVersion;
const POSTGRES_PREFIX = `/opt/minibase/postgresql/${POSTGRES_VERSION}`;
const OPENSSL_PREFIX = `/opt/minibase/openssl/${OPENSSL_VERSION}`;
const BUILD_JOBS = "2";
const SOURCE_DATE_EPOCH = "946684800";
const LIBPQ_ALL_TARGET = "all: all-lib libpq-refs-stamp";
const FIXED_POSTGRES_SOURCE = {
  fileName: "postgresql-18.4.tar.bz2",
  url: "https://ftp.postgresql.org/pub/source/v18.4/postgresql-18.4.tar.bz2",
  bytes: 22_567_173,
  sha256: "81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094",
  updatedAt: "2026-05-11T19:54:17Z",
} satisfies SourceRecord;
const FIXED_OPENSSL_SOURCE = {
  fileName: "openssl-3.6.2.tar.gz",
  url: "https://github.com/openssl/openssl/releases/download/openssl-3.6.2/openssl-3.6.2.tar.gz",
  bytes: 54_913_556,
  sha256: "aaf51a1fe064384f811daeaeb4ec4dce7340ec8bd893027eee676af31e83a04f",
  updatedAt: "2026-04-07T12:21:26Z",
} satisfies SourceRecord;

interface SourceRecord {
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
  updatedAt: string;
}

export interface MacosPostgresSource {
  cacheRoot: string;
  runtimeDir: string;
  licenseFiles: string[];
  packages: Array<{ name: string; version: string }>;
}

export function assertMacosPostgresSourceRecords(
  postgres: SourceRecord,
  openssl: SourceRecord,
): void {
  validateSourceRecord(postgres, `postgresql-${POSTGRES_VERSION}.tar.bz2`, POSTGRES_VERSION);
  validateSourceRecord(openssl, `openssl-${OPENSSL_VERSION}.tar.gz`, OPENSSL_VERSION);
  if (new URL(postgres.url).hostname !== "ftp.postgresql.org") {
    throw new Error("PostgreSQL macOS Runtime source must use ftp.postgresql.org");
  }
  const opensslUrl = new URL(openssl.url);
  if (
    opensslUrl.hostname !== "github.com" ||
    !opensslUrl.pathname.includes(`/openssl-${OPENSSL_VERSION}/`)
  ) {
    throw new Error("PostgreSQL macOS OpenSSL source must use the fixed official release");
  }
  assertFixedSourceRecord("PostgreSQL", postgres, FIXED_POSTGRES_SOURCE);
  assertFixedSourceRecord("OpenSSL", openssl, FIXED_OPENSSL_SOURCE);
}

export function macosPostgresModuleName(extension: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(extension)) {
    throw new Error(`Invalid PostgreSQL macOS module name: ${extension}`);
  }
  return `${extension}.dylib`;
}

export async function prepareMacosPostgresSource(): Promise<MacosPostgresSource> {
  const platform = currentReleasePlatform();
  if (platform.os !== "darwin") {
    throw new Error("PostgreSQL macOS Runtime source preparation requires macOS");
  }
  const postgresRecord = postgresSourceRecord();
  const opensslRecord = opensslSourceRecord();
  assertMacosPostgresSourceRecords(postgresRecord, opensslRecord);

  const cacheRoot = join(
    releaseCacheRoot(),
    `postgresql-${POSTGRES_VERSION}-${platform.name}-${postgresRecord.sha256.slice(0, 12)}-${
      opensslRecord.sha256.slice(0, 12)
    }`,
  );
  const downloadsDir = join(cacheRoot, "downloads");
  const runtimeDir = join(cacheRoot, "runtime");
  const licensesDir = join(cacheRoot, "licenses");
  const markerPath = join(cacheRoot, "minibase-source-manifest.json");
  await Deno.mkdir(downloadsDir, { recursive: true, mode: 0o700 });

  const postgresArchive = join(downloadsDir, postgresRecord.fileName);
  const opensslArchive = join(downloadsDir, opensslRecord.fileName);
  await ensureSourceArchive(postgresRecord, postgresArchive);
  await ensureSourceArchive(opensslRecord, opensslArchive);

  const expectedMarker = sourceMarker(platform.name, postgresRecord, opensslRecord);
  if (await preparedRuntimeMatches(runtimeDir, licensesDir, markerPath, expectedMarker)) {
    return preparedSource(cacheRoot, runtimeDir, licensesDir);
  }

  const buildRoot = join(cacheRoot, `build-${crypto.randomUUID()}.tmp`);
  assertWithinCache(cacheRoot, buildRoot);
  try {
    await Deno.mkdir(buildRoot, { recursive: true, mode: 0o700 });
    const postgresSource = join(buildRoot, `postgresql-${POSTGRES_VERSION}`);
    const opensslSource = join(buildRoot, `openssl-${OPENSSL_VERSION}`);
    await extractSourceArchive(postgresArchive, buildRoot, "bzip2");
    await extractSourceArchive(opensslArchive, buildRoot, "gzip");
    await assertDirectory(postgresSource);
    await assertDirectory(opensslSource);
    await patchPostgresSource(postgresSource);

    const buildEnvironment = {
      LANG: "C",
      LC_ALL: "C",
      MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS_VERSION,
      SOURCE_DATE_EPOCH,
      ZERO_AR_DATE: "1",
      CFLAGS: `-O2 -ffile-prefix-map=${buildRoot}=.`,
    };
    const opensslStage = join(buildRoot, "openssl-stage");
    const opensslTarget = platform.arch === "aarch64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc";
    await runChecked(
      "perl",
      [
        join(opensslSource, "Configure"),
        opensslTarget,
        "no-shared",
        "no-tests",
        "no-docs",
        "no-module",
        `--prefix=${OPENSSL_PREFIX}`,
        `--openssldir=${OPENSSL_PREFIX}/ssl`,
      ],
      opensslSource,
      buildEnvironment,
    );
    await runChecked("make", [`-j${BUILD_JOBS}`], opensslSource, buildEnvironment);
    await runChecked(
      "make",
      ["install_sw", `DESTDIR=${opensslStage}`],
      opensslSource,
      buildEnvironment,
    );
    const opensslInstall = stagedPrefix(opensslStage, OPENSSL_PREFIX);
    await assertFile(join(opensslInstall, "lib", "libcrypto.a"));
    await assertFile(join(opensslInstall, "lib", "libssl.a"));

    const postgresStage = join(buildRoot, "postgres-stage");
    const postgresEnvironment = {
      ...buildEnvironment,
      CPPFLAGS: `-I${join(opensslInstall, "include")}`,
      // PostgreSQL's conversion modules use the server executable as a bundle
      // loader. Apple ld rejects a bundle loader without LC_UUID, so retain its
      // deterministic content UUID instead of applying -no_uuid globally.
      LDFLAGS: `-L${join(opensslInstall, "lib")}`,
    };
    await runChecked(
      "sh",
      [
        join(postgresSource, "configure"),
        `--prefix=${POSTGRES_PREFIX}`,
        "--with-ssl=openssl",
        "--with-uuid=e2fs",
        "--without-readline",
        "--without-icu",
        "--without-zstd",
        "--without-lz4",
        "--without-libxml",
        "--without-libxslt",
        "--without-ldap",
        "--without-gssapi",
        "--disable-nls",
      ],
      postgresSource,
      postgresEnvironment,
    );
    await runChecked("make", [`-j${BUILD_JOBS}`], postgresSource, postgresEnvironment);
    await runChecked(
      "make",
      ["install", `DESTDIR=${postgresStage}`],
      postgresSource,
      postgresEnvironment,
    );
    for (const extension of ["pgcrypto", "uuid-ossp"]) {
      await runChecked(
        "make",
        ["install", `DESTDIR=${postgresStage}`],
        join(postgresSource, "contrib", extension),
        postgresEnvironment,
      );
    }

    const preparedRuntime = stagedPrefix(postgresStage, POSTGRES_PREFIX);
    await materializeRuntimeLinks(preparedRuntime);
    await normalizeRuntimeMachO(preparedRuntime);
    await assertPreparedRuntime(preparedRuntime);

    const preparedLicenses = join(buildRoot, "licenses");
    await Deno.mkdir(preparedLicenses, { recursive: true, mode: 0o700 });
    await Deno.copyFile(
      join(postgresSource, "COPYRIGHT"),
      join(preparedLicenses, "POSTGRESQL_COPYRIGHT.txt"),
    );
    await Deno.copyFile(
      join(opensslSource, "LICENSE.txt"),
      join(preparedLicenses, "OPENSSL_LICENSE.txt"),
    );

    assertWithinCache(cacheRoot, runtimeDir);
    assertWithinCache(cacheRoot, licensesDir);
    await Deno.remove(runtimeDir, { recursive: true }).catch(ignoreNotFound);
    await Deno.remove(licensesDir, { recursive: true }).catch(ignoreNotFound);
    await Deno.rename(preparedRuntime, runtimeDir);
    await Deno.rename(preparedLicenses, licensesDir);
    await Deno.writeTextFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, {
      mode: 0o600,
    });
  } finally {
    await Deno.remove(buildRoot, { recursive: true }).catch(ignoreNotFound);
  }

  await assertPreparedRuntime(runtimeDir);
  return preparedSource(cacheRoot, runtimeDir, licensesDir);
}

function preparedSource(
  cacheRoot: string,
  runtimeDir: string,
  licensesDir: string,
): MacosPostgresSource {
  return {
    cacheRoot,
    runtimeDir,
    licenseFiles: [
      join(licensesDir, "POSTGRESQL_COPYRIGHT.txt"),
      join(licensesDir, "OPENSSL_LICENSE.txt"),
    ],
    packages: [
      { name: "postgresql-source", version: POSTGRES_VERSION },
      { name: "openssl-static", version: OPENSSL_VERSION },
    ],
  };
}

function sourceMarker(platform: string, postgres: SourceRecord, openssl: SourceRecord) {
  return {
    formatVersion: 1,
    product: "postgresql-runtime-source",
    platform,
    version: POSTGRES_VERSION,
    minimumMacosVersion: MINIMUM_MACOS_VERSION,
    postgres,
    openssl: { version: OPENSSL_VERSION, ...openssl },
    build: {
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      opensslShared: false,
      extensions: ["plpgsql", "pgcrypto", "uuid-ossp"],
      sourcePatches: ["skip-libpq-exit-check-for-static-openssl"],
    },
  };
}

export function patchMacosLibpqStaticOpenSslCheck(source: string): string {
  const occurrences = source.split(LIBPQ_ALL_TARGET).length - 1;
  if (
    occurrences !== 1 ||
    !source.includes("by statically-linked libraries, as we can't expect them to honor this")
  ) {
    throw new Error("PostgreSQL libpq Makefile no longer matches the audited static-OpenSSL patch");
  }
  return source.replace(LIBPQ_ALL_TARGET, "all: all-lib");
}

async function patchPostgresSource(postgresSource: string): Promise<void> {
  const makefile = join(postgresSource, "src", "interfaces", "libpq", "Makefile");
  const original = await Deno.readTextFile(makefile);
  await Deno.writeTextFile(makefile, patchMacosLibpqStaticOpenSslCheck(original));
}

async function preparedRuntimeMatches(
  runtimeDir: string,
  licensesDir: string,
  markerPath: string,
  expectedMarker: ReturnType<typeof sourceMarker>,
): Promise<boolean> {
  try {
    const actual = JSON.parse(await Deno.readTextFile(markerPath));
    if (JSON.stringify(actual) !== JSON.stringify(expectedMarker)) return false;
    await assertFile(join(licensesDir, "POSTGRESQL_COPYRIGHT.txt"));
    await assertFile(join(licensesDir, "OPENSSL_LICENSE.txt"));
    await assertPreparedRuntime(runtimeDir);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    return false;
  }
}

async function assertPreparedRuntime(runtimeDir: string): Promise<void> {
  for (const executable of ["postgres", "initdb", "pg_ctl", "pg_isready"]) {
    await assertFile(join(runtimeDir, "bin", executable));
  }
  for (const extension of ["plpgsql", "pgcrypto", "uuid-ossp"]) {
    await assertFile(join(runtimeDir, "share", "extension", `${extension}.control`));
    await assertFile(join(runtimeDir, "lib", macosPostgresModuleName(extension)));
  }
  const postgres = join(runtimeDir, "bin", "postgres");
  const version = await runChecked("postgres", ["--version"], runtimeDir, {}, postgres);
  if (!version.stdout.includes(`PostgreSQL) ${POSTGRES_VERSION}`)) {
    throw new Error(`Prepared PostgreSQL Runtime must be ${POSTGRES_VERSION}`);
  }
  const platform = currentReleasePlatform();
  const arches = await runChecked("lipo", ["-archs", postgres], runtimeDir, {});
  const expectedArch = platform.arch === "aarch64" ? "arm64" : "x86_64";
  if (arches.stdout.trim() !== expectedArch) {
    throw new Error(`Prepared PostgreSQL Runtime architecture must be ${expectedArch}`);
  }
  for (const file of await runtimeMachOFiles(runtimeDir)) {
    await assertRuntimeDependencies(file, runtimeDir);
    await runChecked("codesign", ["--verify", "--strict", file], runtimeDir, {});
  }
}

async function materializeRuntimeLinks(runtimeDir: string): Promise<void> {
  await materializeLinks(runtimeDir, runtimeDir);
}

async function materializeLinks(root: string, directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      await materializeLinks(root, path);
      continue;
    }
    if (!entry.isSymlink) continue;
    const resolved = await Deno.realPath(path);
    if (!pathWithin(root, resolved) || !(await Deno.stat(resolved)).isFile) {
      throw new Error(`PostgreSQL macOS Runtime symlink escaped its root: ${path}`);
    }
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.copyFile(resolved, temporary);
    await Deno.remove(path);
    await Deno.rename(temporary, path);
  }
}

async function normalizeRuntimeMachO(runtimeDir: string): Promise<void> {
  const files = await runtimeMachOFiles(runtimeDir);
  const libraries = new Map<string, string>();
  for (const file of files.filter((path) => path.startsWith(join(runtimeDir, "lib")))) {
    const name = basename(file);
    const existing = libraries.get(name);
    if (existing !== undefined && await sha256File(existing) !== await sha256File(file)) {
      throw new Error(`Conflicting PostgreSQL macOS Runtime library: ${name}`);
    }
    libraries.set(name, file);
  }
  for (const file of files) {
    for (const dependency of await machODependencies(file)) {
      if (isSystemDependency(dependency)) continue;
      const name = basename(dependency);
      if (!libraries.has(name)) {
        throw new Error(`Unbundled PostgreSQL macOS dependency ${dependency} in ${file}`);
      }
      const replacement = file.startsWith(join(runtimeDir, "bin"))
        ? `@loader_path/../lib/${name}`
        : `@loader_path/${name}`;
      if (dependency !== replacement) {
        await runChecked(
          "install_name_tool",
          ["-change", dependency, replacement, file],
          runtimeDir,
          {},
        );
      }
    }
    if (file.endsWith(".dylib")) {
      await runChecked(
        "install_name_tool",
        ["-id", `@loader_path/${basename(file)}`, file],
        runtimeDir,
        {},
      );
    }
  }
  for (const file of files) {
    const identifier = `dev.minibase.postgresql.${
      basename(file).replaceAll(/[^0-9A-Za-z.-]/gu, ".")
    }`;
    await runChecked(
      "codesign",
      ["--force", "--sign", "-", "--timestamp=none", "--identifier", identifier, file],
      runtimeDir,
      {},
    );
  }
}

async function assertRuntimeDependencies(file: string, runtimeDir: string): Promise<void> {
  for (const dependency of await machODependencies(file)) {
    if (isSystemDependency(dependency)) continue;
    const relativeTarget = dependency.startsWith("@loader_path/../lib/")
      ? join(runtimeDir, "lib", dependency.slice("@loader_path/../lib/".length))
      : dependency.startsWith("@loader_path/")
      ? join(runtimeDir, "lib", dependency.slice("@loader_path/".length))
      : null;
    if (relativeTarget === null || !(await Deno.stat(relativeTarget)).isFile) {
      throw new Error(
        `PostgreSQL macOS Runtime has unresolved dependency ${dependency} in ${file}`,
      );
    }
  }
}

function isSystemDependency(path: string): boolean {
  return path.startsWith("/usr/lib/") || path.startsWith("/System/Library/Frameworks/");
}

async function runtimeMachOFiles(runtimeDir: string): Promise<string[]> {
  const files = [
    ...["postgres", "initdb", "pg_ctl", "pg_isready"].map((name) => join(runtimeDir, "bin", name)),
  ];
  await walk(join(runtimeDir, "lib"), (path) => {
    if (path.endsWith(".dylib") || path.endsWith(".so")) files.push(path);
  });
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function machODependencies(file: string): Promise<string[]> {
  const output = await runChecked("otool", ["-L", file], dirname(file), {});
  return output.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((value) => value.length > 0);
}

async function extractSourceArchive(
  archive: string,
  destination: string,
  compression: "bzip2" | "gzip",
): Promise<void> {
  await runChecked(
    "tar",
    [compression === "bzip2" ? "-xjf" : "-xzf", archive, "-C", destination],
    destination,
    {},
  );
}

async function ensureSourceArchive(record: SourceRecord, destination: string): Promise<void> {
  if (await matchesSourceRecord(destination, record)) return;
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const response = await fetch(record.url, { redirect: "follow" });
    if (!response.ok || response.body === null) {
      throw new Error(`Failed to download ${record.fileName}: HTTP ${response.status}`);
    }
    const output = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    await response.body.pipeTo(output.writable);
    if (!(await matchesSourceRecord(temporary, record))) {
      throw new Error(`Downloaded source integrity mismatch: ${record.fileName}`);
    }
    await Deno.remove(destination).catch(ignoreNotFound);
    await Deno.rename(temporary, destination);
  } finally {
    await Deno.remove(temporary).catch(ignoreNotFound);
  }
}

async function matchesSourceRecord(path: string, record: SourceRecord): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile && stat.size === record.bytes && await sha256File(path) === record.sha256;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function postgresSourceRecord(): SourceRecord {
  return { ...toolchain.components.postgres.macosSource };
}

function opensslSourceRecord(): SourceRecord {
  const component = toolchain.components.postgresMacosOpenSsl;
  return {
    fileName: component.sourceFileName,
    url: component.sourceUrl,
    bytes: component.sourceBytes,
    sha256: component.sourceSha256,
    updatedAt: component.sourceUpdatedAt,
  };
}

function validateSourceRecord(record: SourceRecord, expectedFile: string, version: string): void {
  if (
    record.fileName !== expectedFile ||
    new URL(record.url).pathname.split("/").at(-1) !== expectedFile
  ) {
    throw new Error(`Invalid fixed source file for ${version}`);
  }
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
    throw new Error(`Invalid fixed source size for ${version}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(record.sha256)) {
    throw new Error(`Invalid fixed source SHA-256 for ${version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(record.updatedAt)) {
    throw new Error(`Invalid fixed source timestamp for ${version}`);
  }
}

function assertFixedSourceRecord(
  name: string,
  actual: SourceRecord,
  expected: SourceRecord,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} macOS Runtime source record does not match the audited fixed input`);
  }
}

function releaseCacheRoot(): string {
  const configured = Deno.env.get("MINIBASE_RELEASE_CACHE_DIR");
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error("MINIBASE_RELEASE_CACHE_DIR must be absolute");
    return configured;
  }
  const xdgCache = Deno.env.get("XDG_CACHE_HOME");
  if (xdgCache !== undefined) {
    if (!isAbsolute(xdgCache)) throw new Error("XDG_CACHE_HOME must be absolute");
    return join(xdgCache, "minibase-release");
  }
  const userHome = Deno.env.get("HOME");
  if (userHome === undefined || !isAbsolute(userHome)) {
    throw new Error("HOME must be absolute for the macOS release cache");
  }
  return join(userHome, ".cache", "minibase-release");
}

function stagedPrefix(stage: string, prefix: string): string {
  return join(stage, ...prefix.split("/").filter((part) => part.length > 0));
}

async function runChecked(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  executable = command,
): Promise<{ stdout: string; stderr: string }> {
  const output = await new Deno.Command(executable, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    const diagnostics = [stdout, stderr]
      .flatMap((value) => value.trim().split("\n"))
      .filter((line) => line.length > 0)
      .slice(-80)
      .join("\n");
    throw new Error(`${command} failed with code ${output.code}: ${diagnostics}`);
  }
  return { stdout, stderr };
}

async function walk(root: string, onFile: (path: string) => void | Promise<void>): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isSymlink) throw new Error(`PostgreSQL macOS Runtime contains a symlink: ${path}`);
    if (entry.isDirectory) await walk(path, onFile);
    else if (entry.isFile) await onFile(path);
  }
}

function pathWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value.length === 0 || (!isAbsolute(value) && value !== ".." && !value.startsWith("../"));
}

function assertWithinCache(cacheRoot: string, path: string): void {
  const value = relative(resolve(cacheRoot), resolve(path));
  if (value.length === 0 || isAbsolute(value) || value === ".." || value.startsWith("../")) {
    throw new Error(`PostgreSQL macOS Runtime path escaped the release cache: ${path}`);
  }
}

async function assertDirectory(path: string): Promise<void> {
  if (!(await Deno.stat(path)).isDirectory) {
    throw new Error(`Required directory is missing: ${path}`);
  }
}

async function assertFile(path: string): Promise<void> {
  if (!(await Deno.stat(path)).isFile) throw new Error(`Required file is missing: ${path}`);
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

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
