import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertReleaseReadiness,
  parseReleaseArguments,
  readProjectLicense,
  releaseReadinessErrorMessage,
  type ReleaseReadinessInput,
} from "../scripts/check_release_readiness.ts";

const commit = "1".repeat(40);
const licenseText = `Copyright 2026 Minibase contributors

Permission is granted to use, copy, modify, and distribute this software under the final
project license terms. This fixture is intentionally long enough to represent a real license.`;

function readyInput(): ReleaseReadinessInput {
  return {
    version: "1.0.0",
    denoConfigVersion: "1.0.0",
    tag: "v1.0.0",
    gitCommit: commit,
    gitDirty: false,
    tagsAtHead: ["v1.0.0"],
    repositoryVisibility: "public",
    licenseText,
  };
}

Deno.test("release readiness requires version, tag, clean commit and final license", () => {
  assertEquals(assertReleaseReadiness(readyInput()), {
    ok: true,
    version: "1.0.0",
    tag: "v1.0.0",
    commit,
    repositoryVisibility: "public",
    projectLicense: "included",
    licenseSha256: "4fa73758a57b6d70644056b2942f371e9ac6df23820623d23d312dfdc0050e8a",
  });
});

Deno.test("release readiness allows a private repository to defer its project license", () => {
  assertEquals(
    assertReleaseReadiness({
      ...readyInput(),
      repositoryVisibility: "private",
      licenseText: null,
    }),
    {
      ok: true,
      version: "1.0.0",
      tag: "v1.0.0",
      commit,
      repositoryVisibility: "private",
      projectLicense: "deferred-private",
      licenseSha256: null,
    },
  );
});

Deno.test("release readiness fails closed on placeholders and mutable release state", () => {
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), version: "0.0.0" }),
    Error,
    "development placeholder",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), denoConfigVersion: "1.0.1" }),
    Error,
    "deno.json version",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), tag: "v1.0.1" }),
    Error,
    "tag must exactly match",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), gitDirty: true }),
    Error,
    "checkout must be clean",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), tagsAtHead: [] }),
    Error,
    "tag must point",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), licenseText: "TODO choose a license" }),
    Error,
    "final non-placeholder license",
  );
  for (const repositoryVisibility of ["public", "internal"] as const) {
    assertThrows(
      () => assertReleaseReadiness({ ...readyInput(), repositoryVisibility, licenseText: null }),
      Error,
      "only private repositories may defer it",
    );
  }
  assertThrows(
    () =>
      assertReleaseReadiness({
        ...readyInput(),
        repositoryVisibility: "private",
        licenseText: "TODO choose a license",
      }),
    Error,
    "final non-placeholder license",
  );
});

Deno.test("release readiness rejects malformed release identity", () => {
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), version: "1.0.0-rc.1" }),
    Error,
    "stable semantic version",
  );
  assertThrows(
    () => assertReleaseReadiness({ ...readyInput(), gitCommit: "not-a-full-sha" }),
    Error,
    "full Git SHA-1",
  );
});

Deno.test("release readiness reads an optional private project license", async () => {
  assertEquals(
    await readProjectLicense("tests/__missing_release_readiness_fixture__", "private"),
    null,
  );
  await assertRejects(
    () => readProjectLicense("tests/__missing_release_readiness_fixture__", "public"),
    Error,
    "only private repositories may defer it",
  );
});

Deno.test("release readiness parses trusted repository visibility", () => {
  assertEquals(
    parseReleaseArguments([
      "--tag",
      "v1.0.0",
      "--repository-visibility",
      "private",
    ]),
    { tag: "v1.0.0", repositoryVisibility: "private" },
  );
  assertThrows(
    () =>
      parseReleaseArguments([
        "--tag",
        "v1.0.0",
        "--repository-visibility",
        "secret",
      ]),
    Error,
    "visibility must be private, public or internal",
  );
});

Deno.test("release readiness formats failures without runtime details", () => {
  assertEquals(
    releaseReadinessErrorMessage(new Error("Project LICENSE is required")),
    "Project LICENSE is required",
  );
  assertEquals(releaseReadinessErrorMessage({ code: "ENOENT" }), "Release readiness check failed");
});
