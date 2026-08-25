import { assertEquals, assertThrows } from "@std/assert";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  assertMacosPostgresSourceRecords,
  macosPostgresModuleName,
  patchMacosLibpqStaticOpenSslCheck,
} from "../scripts/postgres_macos_source.ts";

const source = await Deno.readTextFile(
  new URL("../scripts/postgres_macos_source.ts", import.meta.url),
);
const runtimeAssetSource = await Deno.readTextFile(
  new URL("../scripts/postgres_runtime_asset.ts", import.meta.url),
);

const postgres = toolchain.components.postgres.macosSource;
const openssl = {
  fileName: toolchain.components.postgresMacosOpenSsl.sourceFileName,
  url: toolchain.components.postgresMacosOpenSsl.sourceUrl,
  bytes: toolchain.components.postgresMacosOpenSsl.sourceBytes,
  sha256: toolchain.components.postgresMacosOpenSsl.sourceSha256,
  updatedAt: toolchain.components.postgresMacosOpenSsl.sourceUpdatedAt,
};

Deno.test("macOS PostgreSQL Runtime accepts only the fixed official source records", () => {
  assertMacosPostgresSourceRecords(postgres, openssl);
  assertThrows(
    () => assertMacosPostgresSourceRecords({ ...postgres, bytes: 0 }, openssl),
    Error,
    "Invalid fixed source size",
  );
  assertThrows(
    () =>
      assertMacosPostgresSourceRecords(postgres, {
        ...openssl,
        url: "https://example.invalid/openssl-3.6.2.tar.gz",
      }),
    Error,
    "fixed official release",
  );
  assertThrows(
    () => assertMacosPostgresSourceRecords({ ...postgres, sha256: "0".repeat(64) }, openssl),
    Error,
    "does not match the audited fixed input",
  );
});

Deno.test("macOS PostgreSQL build keeps the LC_UUID required by bundle linking", () => {
  if (source.includes("-Wl,-no_uuid")) {
    throw new Error("PostgreSQL macOS build must not remove LC_UUID globally");
  }
  if (!source.includes("bundle loader without LC_UUID")) {
    throw new Error("PostgreSQL macOS build must retain the native linker rationale");
  }
});

Deno.test("macOS PostgreSQL Mach-O inspection uses a directory working path", () => {
  if (!source.includes('runChecked("otool", ["-L", file], dirname(file), {})')) {
    throw new Error("PostgreSQL macOS otool inspection must use the Mach-O parent directory");
  }
});

Deno.test("macOS PostgreSQL Runtime requires Darwin module suffixes", () => {
  assertEquals(macosPostgresModuleName("plpgsql"), "plpgsql.dylib");
  assertEquals(macosPostgresModuleName("pgcrypto"), "pgcrypto.dylib");
  assertEquals(macosPostgresModuleName("uuid-ossp"), "uuid-ossp.dylib");
  assertThrows(
    () => macosPostgresModuleName("../plpgsql"),
    Error,
    "Invalid PostgreSQL macOS module name",
  );
  if (!source.includes('join(runtimeDir, "lib", macosPostgresModuleName(extension))')) {
    throw new Error("PostgreSQL macOS Runtime validation must use Darwin module suffixes");
  }
});

Deno.test("macOS PostgreSQL notices use the shared human-readable platform label", () => {
  if (!runtimeAssetSource.includes("releasePlatformLabel(PLATFORM)")) {
    throw new Error("PostgreSQL macOS Runtime notices must use the shared platform label");
  }
  if (runtimeAssetSource.includes("${PLATFORM.name} Runtime and OpenSSL")) {
    throw new Error("PostgreSQL macOS Runtime notices must not expose the machine platform name");
  }
});

Deno.test("macOS PostgreSQL build skips only the inapplicable static-OpenSSL libpq check", () => {
  const original = [
    "# Skip the test on platforms where libpq infrastructure may be provided",
    "# by statically-linked libraries, as we can't expect them to honor this",
    "# coding rule.",
    "all: all-lib libpq-refs-stamp",
    "",
  ].join("\n");
  assertEquals(
    patchMacosLibpqStaticOpenSslCheck(original),
    original.replace("all: all-lib libpq-refs-stamp", "all: all-lib"),
  );
  assertThrows(
    () => patchMacosLibpqStaticOpenSslCheck("all: all-lib libpq-refs-stamp\n"),
    Error,
    "no longer matches",
  );
  assertThrows(
    () => patchMacosLibpqStaticOpenSslCheck(`${original}${original}`),
    Error,
    "no longer matches",
  );
});
