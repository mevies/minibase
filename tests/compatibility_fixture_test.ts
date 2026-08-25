import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import toolchain from "../toolchain.json" with { type: "json" };

const fixtureRoot = fromFileUrl(new URL("../fixtures/supabase-basic", import.meta.url));
const repositoryRoot = fromFileUrl(new URL("../", import.meta.url));

Deno.test("Supabase compatibility fixture has a complete machine-readable contract", async () => {
  assertEquals(compatibility.formatVersion, 2);
  assertEquals(compatibility.projectId, "minibase-compat-basic");
  assertEquals(
    compatibility.verifiedWith.supabaseCli.version,
    toolchain.components.supabaseCli.required,
  );
  assertEquals(
    compatibility.verifiedWith.supabaseCli.archiveSha256,
    toolchain.components.supabaseCli.windowsX64ArchiveSha256,
  );
  assertEquals(
    compatibility.verifiedWith.supabaseCli.archiveBytes,
    toolchain.components.supabaseCli.windowsX64ArchiveBytes,
  );
  assertEquals(
    compatibility.verifiedWith.supabaseCli.archiveUpdatedAt,
    toolchain.components.supabaseCli.windowsX64ArchiveUpdatedAt,
  );
  assertEquals(
    compatibility.verifiedWith.supabaseJs.version,
    toolchain.components.supabaseJs.required,
  );
  assertEquals(
    compatibility.verifiedWith.supabaseServer.version,
    toolchain.components.supabaseServer.required,
  );
  assertEquals(compatibility.verifiedWith.supabaseServer.engines, ["pglite", "postgres"]);
  assert(compatibility.verifiedWith.supabaseServer.supported.includes("auth.user"));
  assert(compatibility.verifiedWith.supabaseServer.supported.includes("context.admin-storage"));
  assert(compatibility.verifiedWith.supabaseServer.supported.includes("worker.isolated"));
  assert(compatibility.verifiedWith.supabaseServer.supported.includes("worker.release-smoke"));
  assert(compatibility.verifiedWith.supabaseServer.unsupported.includes("key.named"));
  assertEquals(compatibility.projectLayout.config, "supabase/config.toml");
  assertEquals(compatibility.projectLayout.migrations, "supabase/migrations/*.sql");
  assertEquals(compatibility.projectLayout.seed, "supabase/seed.sql");
  assertEquals(
    compatibility.projectLayout.functionEntrypoint,
    "supabase/functions/<name>/index.ts",
  );
  assertEquals(compatibility.verifiedWith.supabaseCli.commands.length, 3);
  const functionTemplate = compatibility.verifiedWith.supabaseCli.functionTemplate;
  const generatedFunctionRoot = join(
    repositoryRoot,
    ...functionTemplate.fixture.split("/"),
  );
  assertEquals(
    await sha256File(join(generatedFunctionRoot, "index.ts")),
    functionTemplate.entrypointSha256,
  );
  assertEquals(
    await sha256File(join(generatedFunctionRoot, "deno.json")),
    functionTemplate.denoConfigSha256,
  );
  assertEquals(functionTemplate.runtimeProbe.status, 200);
  assertEquals(functionTemplate.runtimeProbe.response, { message: "Hello Functions!" });

  const versions = new Set<string>();
  for (const migration of compatibility.inputs.migrations) {
    assertMatch(migration.version, /^\d{14}$/);
    assert(!versions.has(migration.version), `duplicate migration version ${migration.version}`);
    versions.add(migration.version);
    assert(
      migration.file.split("/").at(-1)?.startsWith(`${migration.version}_`),
      `${migration.file} does not match migration version ${migration.version}`,
    );
    assert((await Deno.stat(resolveFixturePath(migration.file))).isFile);
  }

  assert((await Deno.stat(resolveFixturePath(compatibility.inputs.seed))).isFile);
  assertEquals(compatibility.inputs.functions.length, 2);
  for (const functionInput of compatibility.inputs.functions) {
    assertEquals(functionInput.route, `/functions/v1/${functionInput.name}`);
    assert((await Deno.stat(resolveFixturePath(functionInput.entrypoint))).isFile);
  }

  assertEquals(compatibility.expectations.profiles.length, 2);
  assertEquals(Object.keys(compatibility.expectations.notesByUser).sort(), [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
  assertEquals(compatibility.expectations.storagePolicies.length, 3);

  for (const engine of Object.values(compatibility.engines)) {
    assert(engine.supported.length > 0);
    for (const unsupported of engine.unsupported) {
      assert(unsupported.capability.length > 0);
      assert(unsupported.reason.length > 0);
      assert(!engine.supported.includes(unsupported.capability));
    }
  }
  assert(
    compatibility.engines.postgres.supported.includes("logical-replication-configuration"),
  );
  assert(!compatibility.engines.postgres.supported.includes("logical-replication"));

  const supportLevels = new Set(["supported", "partial", "experimental", "not-in-mvp"]);
  assertEquals(
    compatibility.modules.map((module) => module.id).sort(),
    ["auth", "functions", "migrations", "rest", "storage"],
  );
  for (const module of compatibility.modules) {
    assert(module.label.length > 0);
    assert(module.summary.length > 0);
    assert(supportLevels.has(module.overall));
    assert(supportLevels.has(module.embedded));
    assert(supportLevels.has(module.server));
  }
});

function resolveFixturePath(relativePath: string): string {
  return join(fixtureRoot, ...relativePath.split("/"));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await Deno.readFile(path));
  return hash.digest("hex");
}
