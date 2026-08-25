import { assertThrows } from "@std/assert";
import toolchain from "../toolchain.json" with { type: "json" };
import {
  assertLinuxPostgresPackageManifest,
  assertPinnedLinuxRuntimeDependency,
} from "../scripts/postgres_linux_policy.ts";

Deno.test("Linux PostgreSQL Runtime requires the complete pinned package manifest", () => {
  const direct = structuredClone(toolchain.components.postgres.linuxX64Packages);
  const dependencies = structuredClone(
    toolchain.components.postgres.linuxX64DependencyPackages,
  );
  assertLinuxPostgresPackageManifest(direct, dependencies);

  assertThrows(
    () => assertLinuxPostgresPackageManifest(direct, dependencies.slice(1)),
    Error,
    "must pin 37 dependency packages",
  );

  const malformed = structuredClone(dependencies);
  malformed[0]!.sha256 = "tampered";
  assertThrows(
    () => assertLinuxPostgresPackageManifest(direct, malformed),
    Error,
    `Invalid PostgreSQL Linux x64 package record: ${malformed[0]!.name}`,
  );

  const duplicate = structuredClone(dependencies);
  duplicate[1]!.fileName = duplicate[0]!.fileName;
  assertThrows(
    () => assertLinuxPostgresPackageManifest(direct, duplicate),
    Error,
    "Duplicate PostgreSQL Linux x64 package",
  );
});

Deno.test("Linux PostgreSQL Runtime rejects dynamic libraries outside the pinned package root", () => {
  const packageRoot = resolveFixturePath("package-root");
  assertPinnedLinuxRuntimeDependency(
    packageRoot,
    "libssl.so.3",
    resolveFixturePath("package-root", "usr", "lib", "libssl.so.3"),
  );

  assertThrows(
    () =>
      assertPinnedLinuxRuntimeDependency(
        packageRoot,
        "libssl.so.3",
        resolveFixturePath("host-root", "usr", "lib", "libssl.so.3"),
      ),
    Error,
    "dependency is not pinned in toolchain.json",
  );
});

function resolveFixturePath(...parts: string[]): string {
  const root = Deno.build.os === "windows" ? "C:\\minibase-policy-test" : "/minibase-policy-test";
  return [root, ...parts].join(Deno.build.os === "windows" ? "\\" : "/");
}
