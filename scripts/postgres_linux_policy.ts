import { isAbsolute, relative, resolve } from "@std/path";

export interface LinuxPostgresPackageRecord {
  name: string;
  version: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
}

const DIRECT_PACKAGE_NAMES = [
  "postgresql-18",
  "postgresql-client-18",
  "libpq5",
  "libnuma1",
  "liburing2",
  "libxslt1.1",
] as const;

const DEPENDENCY_PACKAGE_NAMES = [
  "gcc-14-base",
  "libaudit1",
  "libcap-ng0",
  "libcap2",
  "libcom-err2",
  "libffi8",
  "libgcc-s1",
  "libgcrypt20",
  "libgmp10",
  "libgnutls30t64",
  "libgpg-error0",
  "libgssapi-krb5-2",
  "libhogweed6t64",
  "libicu74",
  "libidn2-0",
  "libk5crypto3",
  "libkeyutils1",
  "libkrb5-3",
  "libkrb5support0",
  "libldap2",
  "liblz4-1",
  "liblzma5",
  "libnettle8t64",
  "libp11-kit0",
  "libpam0g",
  "libpcre2-8-0",
  "libsasl2-2",
  "libselinux1",
  "libssl3t64",
  "libstdc++6",
  "libsystemd0",
  "libtasn1-6",
  "libunistring5",
  "libuuid1",
  "libxml2",
  "libzstd1",
  "zlib1g",
] as const;

export function assertLinuxPostgresPackageManifest(
  directPackages: readonly LinuxPostgresPackageRecord[],
  dependencyPackages: readonly LinuxPostgresPackageRecord[],
): void {
  assertPackageSet("source", directPackages, DIRECT_PACKAGE_NAMES);
  assertPackageSet("dependency", dependencyPackages, DEPENDENCY_PACKAGE_NAMES);

  const names = new Set<string>();
  const fileNames = new Set<string>();
  for (const packageRecord of [...directPackages, ...dependencyPackages]) {
    if (names.has(packageRecord.name) || fileNames.has(packageRecord.fileName)) {
      throw new Error(`Duplicate PostgreSQL Linux x64 package: ${packageRecord.name}`);
    }
    names.add(packageRecord.name);
    fileNames.add(packageRecord.fileName);
    assertPackageRecord(packageRecord);
  }
}

export function assertPinnedLinuxRuntimeDependency(
  packageRoot: string,
  soname: string,
  dependencyPath: string,
): void {
  if (!pathWithin(packageRoot, dependencyPath)) {
    throw new Error(
      `PostgreSQL Linux Runtime dependency is not pinned in toolchain.json: ${soname} -> ${dependencyPath}`,
    );
  }
}

export function pathWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value.length === 0 ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${separator()}`));
}

function assertPackageSet(
  kind: "source" | "dependency",
  packages: readonly LinuxPostgresPackageRecord[],
  requiredNames: readonly string[],
): void {
  if (packages.length !== requiredNames.length) {
    throw new Error(
      `PostgreSQL Linux x64 Runtime must pin ${requiredNames.length} ${kind} packages`,
    );
  }
  const actualNames = new Set(packages.map((packageRecord) => packageRecord.name));
  for (const requiredName of requiredNames) {
    if (!actualNames.has(requiredName)) {
      throw new Error(
        `PostgreSQL Linux x64 Runtime is missing ${kind} package ${requiredName}`,
      );
    }
  }
}

function assertPackageRecord(packageRecord: LinuxPostgresPackageRecord): void {
  const url = new URL(packageRecord.url);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "apt.postgresql.org" && url.hostname !== "archive.ubuntu.com") ||
    url.pathname.split("/").at(-1) !== packageRecord.fileName ||
    !/^[0-9A-Za-z.+~-]+$/u.test(packageRecord.name) ||
    !/^[0-9A-Za-z.+:~_-]+$/u.test(packageRecord.version) ||
    !/^[0-9A-Za-z.+~_-]+_amd64\.deb$/u.test(packageRecord.fileName) ||
    !Number.isSafeInteger(packageRecord.bytes) || packageRecord.bytes <= 0 ||
    !/^[0-9a-f]{64}$/u.test(packageRecord.sha256)
  ) {
    throw new Error(`Invalid PostgreSQL Linux x64 package record: ${packageRecord.name}`);
  }
}

function separator(): string {
  return Deno.build.os === "windows" ? "\\" : "/";
}
