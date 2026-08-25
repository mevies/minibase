import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { runCli } from "../src/cli/run.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { runDoctor } from "../src/diagnostics/doctor.ts";
import { MigrationCompatibilityError } from "../src/migrations/compatibility.ts";
import {
  applyMigrations,
  applySeed,
  inspectMigrationAttempts,
  InterruptedMigrationError,
  migrationsReady,
} from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import { assertRequestContextContract } from "./helpers/request_context.ts";
import { assertSqlSafetyContract } from "./helpers/sql_safety.ts";

const aliceId = "11111111-1111-4111-8111-111111111111";

Deno.test("PGlite runs an unchanged Supabase migration and seed fixture", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-migration-test-" });
  const projectRoot = join(temp, "project");
  await Deno.mkdir(projectRoot);
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), projectRoot);
  const fixture = await discoverProject(projectRoot);
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    const applied = await applyMigrations(engine, fixture);
    assertEquals(
      applied.map((migration) => migration.version),
      compatibility.inputs.migrations.map((migration) => migration.version),
    );
    assertEquals(await applySeed(engine, fixture), true);
    assertEquals(await applySeed(engine, fixture), false);

    const profiles = await engine.query<{ id: string; display_name: string }>(
      "select id::text, display_name from public.profiles order by id",
    );
    assertEquals(
      profiles.rows,
      compatibility.expectations.profiles.map((profile) => ({
        id: profile.id,
        display_name: profile.displayName,
      })),
    );
    const storagePolicies = await engine.query<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
       order by policyname`,
    );
    assertEquals(
      storagePolicies.rows.map((row) => row.policyname),
      compatibility.expectations.storagePolicies.toSorted(),
    );
    await assertSqlSafetyContract(engine);

    const aliceNotes = await engine.withRequestContext(
      {
        role: "authenticated",
        claims: { sub: aliceId, role: "authenticated" },
      },
      (session) => session.query<{ body: string }>("select body from public.notes order by id"),
    );
    assertEquals(
      aliceNotes.rows,
      compatibility.expectations.notesByUser[aliceId].map((body) => ({ body })),
    );

    assertEquals(await applyMigrations(engine, fixture), []);
    const firstMigration = join(
      fixture.migrationsDir,
      "20260803000100_create_profiles.sql",
    );
    await Deno.writeTextFile(firstMigration, "\n-- modified after apply\n", { append: true });
    await assertRejects(
      () => applyMigrations(engine, fixture),
      Error,
      "was modified after it was applied",
    );
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

Deno.test("PGlite request contexts isolate all roles and roll back failures", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-context-test-" });
  const fixture = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, fixture);
    await applySeed(engine, fixture);

    await assertRequestContextContract(engine);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("migration capabilities fail before system or user schema writes", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-migration-capability-test-" });
  const projectRoot = join(temp, "project");
  await Deno.mkdir(join(projectRoot, "supabase", "migrations"), { recursive: true });
  await Deno.writeTextFile(
    join(projectRoot, "supabase", "migrations", "20260804000100_postgis.sql"),
    "create extension postgis;\ncreate table public.must_not_exist(id integer);\n",
  );
  const project = await discoverProject(projectRoot);
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await assertRejects(
      () => engine.applyMigrations(project),
      MigrationCompatibilityError,
      "Extension postgis is unavailable",
    );
    const state = await engine.query<{ system_table: string | null; user_table: string | null }>(
      `select
         to_regclass('supabase_migrations.schema_migrations')::text as system_table,
         to_regclass('public.must_not_exist')::text as user_table`,
    );
    assertEquals(state.rows[0], { system_table: null, user_table: null });
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("interrupted non-transactional migrations require explicit recover before replay", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-migration-recover-test-" });
  const migrationsDir = join(temp, "supabase", "migrations");
  await Deno.mkdir(migrationsDir, { recursive: true });
  await Deno.writeTextFile(
    join(migrationsDir, "20260805000100_base.sql"),
    "create table public.recovery_base(id integer primary key);\n",
  );
  const project = await discoverProject(temp);
  await prepareProject(project, "pglite");
  const engine = new PGliteEngine(project.pgliteDataDir);
  const interruptedVersion = "20260805000200";
  const interruptedName = "partial";
  const interruptedSql = `-- minibase:no-transaction
create table if not exists public.partial_recovery(id integer primary key);
insert into public.partial_recovery(id) values (1) on conflict do nothing;
`;
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await Deno.writeTextFile(
      join(migrationsDir, `${interruptedVersion}_${interruptedName}.sql`),
      interruptedSql,
    );
    await engine.exec(
      "create table if not exists public.partial_recovery(id integer primary key)",
    );
    await engine.query(
      `insert into minibase_meta.migration_attempts(
         version, name, hash, transactional, state, attempt, started_at
       ) values ($1, $2, $3, false, 'running', 1, now())`,
      [interruptedVersion, interruptedName, await sha256(interruptedSql)],
    );
    await assertRejects(
      () => applyMigrations(engine, project),
      InterruptedMigrationError,
      "migration recover",
    );
    assertEquals(await migrationsReady(engine, project), false);
    await engine.close();

    const doctor = await runDoctor(await loadConfig(project));
    const interrupted = doctor.checks.find((check) => check.code === "migration.attempt.running");
    assertEquals(interrupted?.severity, "error");
    assertEquals(interrupted?.fix?.includes("migration recover"), true);

    assertEquals(
      await runCli([
        "migration",
        "recover",
        "--project",
        temp,
        "--migration-version",
        interruptedVersion,
      ]),
      1,
    );
    assertEquals(
      await runCli([
        "migration",
        "recover",
        "--project",
        temp,
        "--migration-version",
        interruptedVersion,
        "--force",
        "--json",
      ]),
      0,
    );

    await engine.start();
    assertEquals(
      (await inspectMigrationAttempts(engine)).find((attempt) =>
        attempt.version === interruptedVersion
      ),
      {
        version: interruptedVersion,
        name: interruptedName,
        hash: await sha256(interruptedSql),
        transactional: false,
        state: "applied",
        attempt: 2,
        errorCode: null,
      },
    );
    assertEquals(
      (await engine.query<{ id: number }>("select id from public.partial_recovery")).rows,
      [{ id: 1 }],
    );
    assertEquals(await migrationsReady(engine, project), true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
