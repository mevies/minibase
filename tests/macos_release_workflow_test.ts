import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import toolchain from "../toolchain.json" with { type: "json" };

const embeddedWorkflow = await Deno.readTextFile(
  fromFileUrl(new URL("../.github/workflows/macos-embedded-release.yml", import.meta.url)),
);
const serverWorkflow = await Deno.readTextFile(
  fromFileUrl(new URL("../.github/workflows/macos-server-release.yml", import.meta.url)),
);
const evidenceScript = await Deno.readTextFile(
  fromFileUrl(new URL("../scripts/record_macos_runner_evidence.ts", import.meta.url)),
);
const buildScript = await Deno.readTextFile(
  fromFileUrl(new URL("../scripts/build_release.ts", import.meta.url)),
);

Deno.test("macOS Embedded workflow pins hosts, Deno assets, actions and release evidence", () => {
  assertStringIncludes(embeddedWorkflow, "workflow_dispatch:");
  assertEquals(embeddedWorkflow.includes("push:"), false);
  assertStringIncludes(embeddedWorkflow, "runner: macos-15-intel");
  assertStringIncludes(embeddedWorkflow, "runner: macos-15");
  assertEquals(embeddedWorkflow.includes("macos-latest"), false);
  assertStringIncludes(embeddedWorkflow, "platform: macos-x64");
  assertStringIncludes(embeddedWorkflow, "platform: macos-arm64");
  assertStringIncludes(embeddedWorkflow, "fetch-depth: 0");
  assertStringIncludes(embeddedWorkflow, "persist-credentials: false");
  assertStringIncludes(embeddedWorkflow, "deno install --frozen=true");
  assertStringIncludes(embeddedWorkflow, "deno task check");
  assertStringIncludes(embeddedWorkflow, 'deno task "release:smoke:embedded:$PLATFORM"');
  assertStringIncludes(embeddedWorkflow, "smoke.jsonl");
  assertStringIncludes(embeddedWorkflow, "scripts/record_macos_runner_evidence.ts");
  assertStringIncludes(embeddedWorkflow, "--allow-run=git,sw_vers,uname");
  assertStringIncludes(evidenceScript, "sourceDirty:");
  assertStringIncludes(evidenceScript, "imageVersion:");
  assertStringIncludes(buildScript, '"--timestamp=none"');
  assertStringIncludes(
    buildScript,
    '"--preserve-metadata=entitlements,requirements,flags,runtime"',
  );
  assertStringIncludes(buildScript, "macosAdHocSignatureNormalized");
  assertStringIncludes(embeddedWorkflow, "retention-days: 30");

  const deno = toolchain.runtimes.deno;
  for (
    const value of [
      deno.macosX64ArchiveSha256,
      deno.macosArm64ArchiveSha256,
      deno.macosX64ExecutableSha256,
      deno.macosArm64ExecutableSha256,
      String(deno.macosX64ArchiveBytes),
      String(deno.macosArm64ArchiveBytes),
    ]
  ) {
    assert(typeof value === "string" && value.length > 0);
    assertStringIncludes(embeddedWorkflow, value);
  }

  for (
    const action of [
      toolchain.components.githubActionsCheckout.commitSha,
      toolchain.components.githubActionsUploadArtifact.commitSha,
    ]
  ) {
    assert(typeof action === "string" && /^[0-9a-f]{40}$/u.test(action));
    assertStringIncludes(embeddedWorkflow, `@${action}`);
  }
});

Deno.test("macOS Server workflow builds fixed source PostgreSQL on both native hosts", () => {
  assertStringIncludes(serverWorkflow, "workflow_dispatch:");
  assertEquals(serverWorkflow.includes("push:"), false);
  assertEquals(serverWorkflow.includes("macos-latest"), false);
  assertStringIncludes(serverWorkflow, "runner: macos-15-intel");
  assertStringIncludes(serverWorkflow, "runner: macos-15");
  assertStringIncludes(serverWorkflow, "MINIBASE_RELEASE_CACHE_DIR:");
  assertStringIncludes(serverWorkflow, "${{ runner.temp }}/minibase-release-cache");
  assertEquals(serverWorkflow.includes("${{ github.workspace }}/.release-cache"), false);
  assertStringIncludes(serverWorkflow, 'deno task "release:prepare:postgres:$PLATFORM"');
  assertStringIncludes(serverWorkflow, 'deno task "release:smoke:server:$PLATFORM"');
  assertStringIncludes(serverWorkflow, "postgres-18.4-openssl-3.6.2");
  assertStringIncludes(
    serverWorkflow,
    `actions/cache/restore@${toolchain.components.githubActionsCache.commitSha}`,
  );
  assertStringIncludes(
    serverWorkflow,
    `actions/cache/save@${toolchain.components.githubActionsCache.commitSha}`,
  );
  assertStringIncludes(serverWorkflow, "postgres-source.jsonl");
  assertStringIncludes(serverWorkflow, "smoke.jsonl");
  assertStringIncludes(serverWorkflow, "retention-days: 30");

  for (
    const value of [
      toolchain.components.postgres.macosSource.sha256,
      toolchain.components.postgresMacosOpenSsl.sourceSha256,
    ]
  ) {
    assert(typeof value === "string" && value.length === 64);
  }
});
