import { isAbsolute, join, relative, resolve } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  assertLinuxPostgresPackageManifest,
  type LinuxPostgresPackageRecord,
  pathWithin,
} from "./postgres_linux_policy.ts";

const POSTGRES_VERSION = toolchain.components.postgres.required;
const POSTGRES_MAJOR = POSTGRES_VERSION.split(".", 1)[0]!;
const PLATFORM = "linux-x64";

export type LinuxPostgresPackage = LinuxPostgresPackageRecord;

export interface LinuxPostgresSource {
  cacheRoot: string;
  packageRoot: string;
  runtimeDir: string;
  libraryDir: string;
  shareDir: string;
  packages: LinuxPostgresPackage[];
}

export async function prepareLinuxPostgresSource(): Promise<LinuxPostgresSource> {
  if (Deno.build.os !== "linux" || Deno.build.arch !== "x86_64") {
    throw new Error("PostgreSQL Linux Runtime source preparation requires Linux x64");
  }
  await assertBuildOs();
  const directPackages = toolchain.components.postgres.linuxX64Packages;
  const dependencyPackages = toolchain.components.postgres.linuxX64DependencyPackages;
  assertLinuxPostgresPackageManifest(directPackages, dependencyPackages);
  const packages = [...directPackages, ...dependencyPackages];
  const cacheRoot = join(releaseCacheRoot(), `postgresql-${POSTGRES_VERSION}-${PLATFORM}`);
  const packageDir = join(cacheRoot, "packages");
  const packageRoot = join(cacheRoot, "root");
  await Deno.mkdir(packageDir, { recursive: true, mode: 0o700 });

  const archives: string[] = [];
  for (const packageRecord of packages) {
    validatePackage(packageRecord);
    const archive = join(packageDir, packageRecord.fileName);
    await ensurePackageArchive(packageRecord, archive);
    archives.push(archive);
  }

  const temporaryRoot = `${packageRoot}.${crypto.randomUUID()}.tmp`;
  assertWithinCache(cacheRoot, temporaryRoot);
  try {
    await Deno.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const archive of archives) {
      const extracted = await new Deno.Command("dpkg-deb", {
        args: ["--extract", archive, temporaryRoot],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!extracted.success) {
        throw new Error(
          `dpkg-deb failed for ${archive}: ${new TextDecoder().decode(extracted.stderr).trim()}`,
        );
      }
    }
    const prepared = sourcePaths(cacheRoot, temporaryRoot, packages);
    await assertPreparedSource(prepared);
    await Deno.writeTextFile(
      join(temporaryRoot, "minibase-source-manifest.json"),
      `${
        JSON.stringify(
          {
            formatVersion: 1,
            product: "postgresql-runtime-source",
            version: POSTGRES_VERSION,
            platform: PLATFORM,
            buildOs: toolchain.components.postgres.linuxX64BuildOs,
            packages,
          },
          null,
          2,
        )
      }\n`,
      { mode: 0o600 },
    );
    assertWithinCache(cacheRoot, packageRoot);
    await Deno.remove(packageRoot, { recursive: true }).catch(ignoreNotFound);
    await Deno.rename(temporaryRoot, packageRoot);
  } finally {
    await Deno.remove(temporaryRoot, { recursive: true }).catch(ignoreNotFound);
  }

  const prepared = sourcePaths(cacheRoot, packageRoot, packages);
  await assertPreparedSource(prepared);
  return prepared;
}

function sourcePaths(
  cacheRoot: string,
  packageRoot: string,
  packages: LinuxPostgresPackage[],
): LinuxPostgresSource {
  return {
    cacheRoot,
    packageRoot,
    runtimeDir: join(packageRoot, "usr", "lib", "postgresql", POSTGRES_MAJOR),
    libraryDir: join(packageRoot, "usr", "lib", "x86_64-linux-gnu"),
    shareDir: join(packageRoot, "usr", "share", "postgresql", POSTGRES_MAJOR),
    packages: packages.map((packageRecord) => ({ ...packageRecord })),
  };
}

function releaseCacheRoot(): string {
  const configured = Deno.env.get("MINIBASE_RELEASE_CACHE_DIR");
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new Error("MINIBASE_RELEASE_CACHE_DIR must be an absolute path");
    }
    return configured;
  }
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  if (xdg !== undefined) {
    if (!isAbsolute(xdg)) throw new Error("XDG_CACHE_HOME must be an absolute path");
    return join(xdg, "minibase-release");
  }
  const home = Deno.env.get("HOME");
  if (home === undefined || !isAbsolute(home)) {
    throw new Error("HOME must be an absolute path for the Linux release cache");
  }
  return join(home, ".cache", "minibase-release");
}

async function assertBuildOs(): Promise<void> {
  const osRelease = await Deno.readTextFile("/etc/os-release");
  const expected = `PRETTY_NAME=\"${toolchain.components.postgres.linuxX64BuildOs}\"`;
  if (!osRelease.split("\n").includes(expected)) {
    throw new Error(
      `PostgreSQL Linux Runtime build requires ${toolchain.components.postgres.linuxX64BuildOs}`,
    );
  }
}

function validatePackage(packageRecord: LinuxPostgresPackage): void {
  if (!/^[0-9A-Za-z.+~-]+$/u.test(packageRecord.name)) {
    throw new Error(`Invalid PostgreSQL Runtime package name: ${packageRecord.name}`);
  }
  if (!/^[0-9A-Za-z.+:~_-]+$/u.test(packageRecord.version)) {
    throw new Error(`Invalid PostgreSQL Runtime package version: ${packageRecord.version}`);
  }
  if (!/^[0-9A-Za-z.+~_-]+\.deb$/u.test(packageRecord.fileName)) {
    throw new Error(`Invalid PostgreSQL Runtime package file: ${packageRecord.fileName}`);
  }
  const url = new URL(packageRecord.url);
  if (url.protocol !== "https:" || url.pathname.split("/").at(-1) !== packageRecord.fileName) {
    throw new Error(`Invalid PostgreSQL Runtime package URL: ${packageRecord.url}`);
  }
  if (!Number.isSafeInteger(packageRecord.bytes) || packageRecord.bytes <= 0) {
    throw new Error(`Invalid PostgreSQL Runtime package size: ${packageRecord.name}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(packageRecord.sha256)) {
    throw new Error(`Invalid PostgreSQL Runtime package SHA-256: ${packageRecord.name}`);
  }
}

async function ensurePackageArchive(
  packageRecord: LinuxPostgresPackage,
  destination: string,
): Promise<void> {
  if (await matchesRecord(destination, packageRecord)) return;
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const response = await fetch(packageRecord.url, { redirect: "follow" });
    if (!response.ok || response.body === null) {
      throw new Error(
        `Failed to download ${packageRecord.name}: HTTP ${response.status}`,
      );
    }
    const output = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    await response.body.pipeTo(output.writable);
    if (!(await matchesRecord(temporary, packageRecord))) {
      throw new Error(`Downloaded package integrity mismatch: ${packageRecord.name}`);
    }
    await Deno.remove(destination).catch(ignoreNotFound);
    await Deno.rename(temporary, destination);
  } finally {
    await Deno.remove(temporary).catch(ignoreNotFound);
  }
}

async function matchesRecord(path: string, packageRecord: LinuxPostgresPackage): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile && stat.size === packageRecord.bytes &&
      await sha256File(path) === packageRecord.sha256;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function assertPreparedSource(source: LinuxPostgresSource): Promise<void> {
  if (!(await Deno.stat(source.shareDir)).isDirectory) {
    throw new Error(`Prepared PostgreSQL share directory is missing: ${source.shareDir}`);
  }
  const postgres = join(source.runtimeDir, "bin", "postgres");
  const output = await new Deno.Command(postgres, {
    args: ["--version"],
    env: { LD_LIBRARY_PATH: source.libraryDir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const version = new TextDecoder().decode(output.stdout).trim();
  if (!output.success || !version.includes(`PostgreSQL) ${POSTGRES_VERSION}`)) {
    throw new Error(
      `Prepared PostgreSQL Runtime must be ${POSTGRES_VERSION}, got ${version}: ` +
        new TextDecoder().decode(output.stderr).trim(),
    );
  }
  for (const name of source.packages.map((packageRecord) => packageRecord.name)) {
    const copyright = join(source.packageRoot, "usr", "share", "doc", name, "copyright");
    let resolved: string;
    try {
      resolved = await Deno.realPath(copyright);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Prepared PostgreSQL package license is missing: ${copyright}`);
      }
      throw error;
    }
    if (!pathWithin(source.packageRoot, resolved) || !(await Deno.stat(resolved)).isFile) {
      throw new Error(`Prepared PostgreSQL package license is missing: ${copyright}`);
    }
  }
}

function assertWithinCache(cacheRoot: string, path: string): void {
  const relativePath = relative(resolve(cacheRoot), resolve(path));
  if (
    relativePath.length === 0 || relativePath === ".." ||
    relativePath.startsWith(`..${separator()}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`PostgreSQL Runtime path escaped the release cache: ${path}`);
  }
}

function separator(): string {
  return Deno.build.os === "windows" ? "\\" : "/";
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
