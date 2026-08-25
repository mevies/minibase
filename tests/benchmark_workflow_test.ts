import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("fixed benchmark workflow pins trusted runner and artifact boundaries", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/fixed-benchmark.yml", import.meta.url),
  );
  assertStringIncludes(
    workflow,
    "runs-on: [self-hosted, Windows, X64, minibase-benchmark]",
  );
  assertStringIncludes(workflow, "Runner 2.335.1 is required");
  assertLfCheckout(workflow);
  assertStringIncludes(workflow, "MINIBASE_BENCHMARK_RUNNER");
  assertStringIncludes(workflow, "MINIBASE_POSTGRES_RUNTIME_DIR");
  assertStringIncludes(workflow, "fetch-depth: 0");
  assertStringIncludes(workflow, "push:");
  assertStringIncludes(workflow, "branches:");
  assertStringIncludes(workflow, "- main");
  assertStringIncludes(workflow, "deno task test");
  assertStringIncludes(workflow, "deno task verify:baseline");
  assertStringIncludes(workflow, "deno task test:postgres");
  assertStringIncludes(workflow, "deno task bench --output");
  assertStringIncludes(workflow, "deno task bench:postgres --output");
  assertStringIncludes(workflow, "deno task bench:gate @arguments");
  assertStringIncludes(workflow, "${{ env.BENCHMARK_STATE_DIR }}/baseline");
  assertStringIncludes(workflow, "include-hidden-files: true");
  assertStringIncludes(workflow, "retention-days: 90");
  assertEquals(workflow.includes("pull_request:"), false);
  assertEquals(workflow.includes("pull_request_target:"), false);
  assertEquals(
    count(workflow, "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"),
    1,
  );
  assertEquals(
    count(workflow, "actions/cache/restore@2c8a9bd7457de244a408f35966fab2fb45fda9c8"),
    1,
  );
  assertEquals(
    count(workflow, "actions/cache/save@2c8a9bd7457de244a408f35966fab2fb45fda9c8"),
    1,
  );
  assertEquals(
    count(workflow, "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f"),
    1,
  );

  const actionlint = await Deno.readTextFile(
    new URL("../.github/actionlint.yaml", import.meta.url),
  );
  assertStringIncludes(actionlint, "- minibase-benchmark");
  assertStringIncludes(actionlint, "- MINIBASE_BENCHMARK_RUNNER");
  assertStringIncludes(actionlint, "- MINIBASE_POSTGRES_RUNTIME_DIR");
});

Deno.test("fixed soak workflow runs both 30-minute gates on the audited runner", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/fixed-soak.yml", import.meta.url),
  );
  assertStringIncludes(
    workflow,
    "runs-on: [self-hosted, Windows, X64, minibase-benchmark]",
  );
  assertStringIncludes(workflow, "Runner 2.335.1 is required");
  assertLfCheckout(workflow);
  assertStringIncludes(workflow, "MINIBASE_SOAK_RUNNER");
  assertStringIncludes(workflow, "MINIBASE_POSTGRES_RUNTIME_DIR");
  assertStringIncludes(workflow, "fetch-depth: 0");
  assertStringIncludes(workflow, "timeout-minutes: 120");
  assertStringIncludes(workflow, "deno task test");
  assertStringIncludes(workflow, "deno task verify:baseline");
  assertStringIncludes(workflow, "deno task test:postgres");
  assertStringIncludes(workflow, "deno task soak:pglite --duration-seconds 1800");
  assertStringIncludes(workflow, "deno task soak:postgres --duration-seconds 1800");
  assertStringIncludes(workflow, "include-hidden-files: true");
  assertStringIncludes(workflow, "retention-days: 90");
  assertEquals(workflow.includes("pull_request:"), false);
  assertEquals(workflow.includes("pull_request_target:"), false);
  assertEquals(
    count(workflow, "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"),
    1,
  );
  assertEquals(
    count(workflow, "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f"),
    1,
  );
});

Deno.test("real S3 workflow uses protected manual AWS and R2 evidence", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/real-s3.yml", import.meta.url),
  );
  assertStringIncludes(workflow, "workflow_dispatch:");
  assertStringIncludes(workflow, "environment: real-s3-evidence");
  assertStringIncludes(
    workflow,
    "runs-on: [self-hosted, Windows, X64, minibase-benchmark]",
  );
  assertStringIncludes(workflow, "MINIBASE_S3_EVIDENCE_RUNNER");
  assertLfCheckout(workflow);
  assertStringIncludes(workflow, "MINIBASE_REAL_S3_AWS_ACCESS_KEY_ID");
  assertStringIncludes(workflow, "MINIBASE_REAL_S3_R2_ACCESS_KEY_ID");
  assertStringIncludes(workflow, "fetch-depth: 0");
  assertStringIncludes(workflow, "deno task s3:real:probe --provider aws-s3");
  assertStringIncludes(workflow, "deno task s3:real:probe --provider cloudflare-r2");
  assertStringIncludes(workflow, "deno task s3:evidence:promote");
  assertStringIncludes(workflow, "include-hidden-files: true");
  assertStringIncludes(workflow, "retention-days: 30");
  assertEquals(workflow.includes("pull_request:"), false);
  assertEquals(workflow.includes("pull_request_target:"), false);
  assertEquals(workflow.includes("schedule:"), false);
  assertEquals(
    count(workflow, "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"),
    1,
  );
  assertEquals(
    count(workflow, "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f"),
    1,
  );

  const actionlint = await Deno.readTextFile(
    new URL("../.github/actionlint.yaml", import.meta.url),
  );
  assertStringIncludes(actionlint, "- MINIBASE_S3_EVIDENCE_RUNNER");
});

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function assertLfCheckout(workflow: string): void {
  assertStringIncludes(workflow, "name: Normalize Windows checkout");
  assertStringIncludes(workflow, "git archive --format=tar --output=$archive HEAD");
  assertStringIncludes(workflow, "tar -xf $archive -C $env:GITHUB_WORKSPACE");
  assertStringIncludes(workflow, "git add --all");
  assertStringIncludes(
    workflow,
    "Normalized checkout must match the audited commit exactly.",
  );
}
