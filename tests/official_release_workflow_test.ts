import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import toolchain from "../toolchain.json" with { type: "json" };

const workflow = await Deno.readTextFile(
  fromFileUrl(new URL("../.github/workflows/official-release.yml", import.meta.url)),
);

Deno.test("official release is manual, immutable and guarded by full preflight", () => {
  assertStringIncludes(workflow, "workflow_dispatch:");
  assertStringIncludes(workflow, "tag:");
  assertStringIncludes(workflow, "publish:");
  assertEquals(workflow.includes("push:"), false);
  assertEquals(workflow.includes("schedule:"), false);
  assertStringIncludes(workflow, "ref: ${{ inputs.tag }}");
  assertStringIncludes(workflow, "DISPATCH_REF_TYPE");
  assertStringIncludes(workflow, "DISPATCH_REF_NAME");
  assertStringIncludes(workflow, "Dispatch SHA $env:GITHUB_SHA does not match tagged commit");
  assertStringIncludes(workflow, "GitHub Actions Runner 2.335.1 is required");
  assertStringIncludes(workflow, "name: Normalize Windows checkout");
  assertStringIncludes(workflow, "git archive --format=tar --output=$archive HEAD");
  assertStringIncludes(workflow, "tar -xf $archive -C $env:GITHUB_WORKSPACE");
  assertStringIncludes(workflow, "git add --all");
  assertStringIncludes(
    workflow,
    "Normalized checkout must match the audited commit exactly.",
  );
  assertStringIncludes(workflow, "deno task fmt:check");
  assertStringIncludes(workflow, "deno task lint");
  assertStringIncludes(workflow, "deno task check");
  assertStringIncludes(workflow, "deno task test");
  assertStringIncludes(workflow, "deno task verify:baseline");
  assertStringIncludes(workflow, "deno task test:postgres");
  assertStringIncludes(
    workflow,
    "deno task release:ready:check --tag $env:TAG --repository-visibility $env:REPOSITORY_VISIBILITY",
  );
  assertStringIncludes(
    workflow,
    "REPOSITORY_VISIBILITY: ${{ github.event.repository.visibility }}",
  );
});

Deno.test("official release matrix pins all native Deno inputs and builds eight packages", () => {
  const deno = toolchain.runtimes.deno;
  for (
    const value of [
      deno.windowsX64ArchiveSha256,
      deno.windowsX64ExecutableSha256,
      String(deno.windowsX64ArchiveBytes),
      deno.linuxX64ArchiveSha256,
      deno.linuxX64ExecutableSha256,
      String(deno.linuxX64ArchiveBytes),
      deno.macosX64ArchiveSha256,
      deno.macosX64ExecutableSha256,
      String(deno.macosX64ArchiveBytes),
      deno.macosArm64ArchiveSha256,
      deno.macosArm64ExecutableSha256,
      String(deno.macosArm64ArchiveBytes),
    ]
  ) {
    assert(typeof value === "string" && value.length > 0);
    assertStringIncludes(workflow, value);
  }

  for (const platform of ["windows-x64", "linux-x64", "macos-x64", "macos-arm64"]) {
    for (const edition of ["embedded", "server"]) {
      assertStringIncludes(workflow, `platform: ${platform}\n            edition: ${edition}`);
      assertStringIncludes(workflow, `minibase-${edition}-${platform}-v$VERSION`);
    }
  }
  assertStringIncludes(
    workflow,
    'deno task "release:smoke:${env:EDITION}:${env:PLATFORM}"',
  );
  assertEquals(
    workflow.includes('deno task "release:smoke:$env:EDITION:$env:PLATFORM"'),
    false,
  );
  assertStringIncludes(workflow, 'deno task "release:smoke:$EDITION:$PLATFORM"');
  const buildJob = workflow.slice(
    workflow.indexOf("\n  build:\n"),
    workflow.indexOf("\n  publish:\n"),
  );
  const buildJobEnvironment = buildJob.slice(0, buildJob.indexOf("    steps:"));
  assertEquals(buildJobEnvironment.includes("MINIBASE_POSTGRES_RUNTIME_DIR"), false);
  assertStringIncludes(
    buildJob,
    "DENO_EXECUTABLE_SHA256: ${{ matrix.deno_executable_sha256 }}\n          " +
      "MINIBASE_POSTGRES_RUNTIME_DIR: ${{ vars.MINIBASE_POSTGRES_RUNTIME_DIR }}",
  );
  assertStringIncludes(
    buildJob,
    "name: Build and smoke Windows release\n        if: ${{ runner.os == 'Windows' }}\n" +
      "        shell: powershell\n        env:\n          " +
      "MINIBASE_POSTGRES_RUNTIME_DIR: ${{ vars.MINIBASE_POSTGRES_RUNTIME_DIR }}",
  );
  assertStringIncludes(workflow, "if (Test-Path -LiteralPath 'LICENSE' -PathType Leaf)");
  assertStringIncludes(workflow, "if [[ -f LICENSE ]]; then");
  assertStringIncludes(workflow, "$required += 'LICENSE'");
  assertStringIncludes(workflow, "required+=(LICENSE)");
  assertStringIncludes(workflow, "COMPATIBILITY.md");
  assertStringIncludes(workflow, "THIRD_PARTY_LICENSES.txt");
  assertEquals(workflow.toLowerCase().includes("docker"), false);
});

Deno.test("official release retains failures as drafts and never clobbers assets", () => {
  assertStringIncludes(workflow, "Refuse to replace an existing Release");
  assertStringIncludes(workflow, "draft: true");
  assertStringIncludes(workflow, "Create draft Release before native builds");
  assertStringIncludes(workflow, "needs: [preflight, draft]");
  assertStringIncludes(workflow, "needs.build.result == 'success'");
  assertStringIncludes(workflow, "actions: read");
  assertStringIncludes(workflow, "actions/runs/$RUN_ID/artifacts");
  assertStringIncludes(workflow, "actions/artifacts/$artifact_id/zip");
  assertStringIncludes(workflow, 'test "${#actual[@]}" -eq 8');
  assertStringIncludes(workflow, "SHA256SUMS.txt");
  assertStringIncludes(workflow, "-F draft=false");
  assertEquals(workflow.includes("--clobber"), false);

  for (
    const action of [
      toolchain.components.githubActionsCheckout.commitSha,
      toolchain.components.githubActionsCache.commitSha,
      toolchain.components.githubActionsUploadArtifact.commitSha,
    ]
  ) {
    assert(typeof action === "string" && /^[0-9a-f]{40}$/u.test(action));
    assertStringIncludes(workflow, `@${action}`);
  }
});
