import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { PostgresEngine } from "../src/database/postgres.ts";
import { PostgresRuntime } from "../src/database/postgres_runtime.ts";
import {
  applyMigrations,
  applySeed,
  inspectMigrationAttempts,
  migrationsReady,
} from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { runWithRequestSignal } from "../src/request/context.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import { assertAuthSecurityContract } from "./helpers/auth_security.ts";
import { assertRequestContextContract } from "./helpers/request_context.ts";
import { assertSqlSafetyContract } from "./helpers/sql_safety.ts";
import { assertSupabaseStorageContract } from "./helpers/supabase_storage_contract.ts";
import { assertSupabaseServerContextContract } from "./helpers/supabase_server_context.ts";

const runtimeDir = await findPostgresRuntime();

Deno.test({
  name: "managed PostgreSQL 18.4 initializes, runs the shared fixture and recovers after a crash",
  ignore: runtimeDir === null,
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-test-" });
    const port = availablePort();
    const runtimeOptions = {
      runtimeDir: runtimeDir!,
      dataDir: join(temp, "postgres"),
      port,
      logsDir: join(temp, "logs"),
    };
    const runtime = new PostgresRuntime(runtimeOptions);
    const engine = new PostgresEngine(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      min: 2,
      max: 4,
      connectTimeoutMs: 1_000,
    });
    try {
      const cold = await runtime.start();
      assert(cold.initialized);
      assert(cold.initializeMs >= 0);
      assert(cold.startMs > 0);
      assertStringIncludes(cold.version, "18.4");
      const duplicate = new PostgresRuntime(runtimeOptions);
      await assertRejects(
        () => duplicate.start(),
        Error,
        "data directory is already running",
      );
      await engine.start();
      const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
      const applied = await applyMigrations(engine, project);
      assertEquals(
        applied.map((migration) => migration.version),
        compatibility.inputs.migrations.map((migration) => migration.version),
      );
      assertEquals(await migrationsReady(engine, project), true);
      assertEquals(
        (await inspectMigrationAttempts(engine)).map((attempt) => ({
          version: attempt.version,
          state: attempt.state,
          attempt: attempt.attempt,
        })),
        compatibility.inputs.migrations.map((migration) => ({
          version: migration.version,
          state: "applied",
          attempt: 1,
        })),
      );
      assertEquals(await applySeed(engine, project), true);
      const fixtureProfiles = await engine.query<{ id: string; display_name: string }>(
        "select id::text, display_name from public.profiles order by id",
      );
      assertEquals(
        fixtureProfiles.rows,
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
      await engine.exec("create extension if not exists pgcrypto");
      const capabilities = await engine.capabilities();
      assertStringIncludes(capabilities.postgresVersion, "18.4");
      assert(capabilities.extensions.includes("pgcrypto"));
      assert(capabilities.extensions.includes("uuid-ossp"));
      assert(compatibility.engines.postgres.supported.includes("extension.pgcrypto"));
      assert(compatibility.engines.postgres.supported.includes("extension.uuid-ossp"));
      await engine.exec('create extension if not exists "uuid-ossp"');
      const generatedUuid = await engine.query<{ id: string }>(
        "select uuid_generate_v4()::text as id",
      );
      assertEquals(typeof generatedUuid.rows[0]?.id, "string");

      const poolSize = await engine.query<{ count: number }>(
        `select count(*)::int as count from pg_stat_activity
         where application_name = 'minibase' and datname = current_database()`,
      );
      assert((poolSize.rows[0]?.count ?? 0) >= 2);
      assert((poolSize.rows[0]?.count ?? 0) <= 4);
      const concurrent = await Promise.all(
        Array.from({ length: 12 }, () =>
          engine.query<{ pid: number }>(
            "select pg_backend_pid()::int as pid from pg_sleep(0.05)",
          )),
      );
      const backendIds = new Set(concurrent.map((result) => result.rows[0]!.pid));
      assert(backendIds.size <= 4);

      const boundedByRequest = runWithRequestSignal(
        new AbortController().signal,
        () => engine.query("select pg_sleep(5)"),
        50,
      );
      await assertRejects(() => boundedByRequest, Error, "statement timeout");
      assertEquals(await engine.health(), true);

      const userId = crypto.randomUUID();
      await engine.query(
        `insert into auth.users(id, aud, role, email, raw_user_meta_data)
         values ($1, 'authenticated', 'authenticated', 'server@example.com', '{"display_name":"Server"}')`,
        [userId],
      );
      const profile = await engine.query<{ display_name: string }>(
        "select display_name from public.profiles where id = $1",
        [userId],
      );
      assertEquals(profile.rows, [{ display_name: "Server" }]);

      const cleanupAuth = new AuthService(engine, {
        jwtSecret: "postgres-auth-cleanup-secret-with-at-least-32-characters",
      });
      const expiredAnonymous = await cleanupAuth.signUp({});
      await engine.query(
        "update auth.users set created_at = $1 where id = $2",
        ["2000-01-01T00:00:00.000Z", expiredAnonymous.user.id],
      );
      assertEquals(
        (await cleanupAuth.cleanupAnonymousUsers(24 * 60 * 60 * 1_000, 10)).deleted,
        1,
      );
      assertEquals(
        (await engine.query<{ count: number }>(
          "select count(*)::int as count from auth.users where id = $1",
          [expiredAnonymous.user.id],
        )).rows,
        [{ count: 0 }],
      );
      await assertAuthSecurityContract(engine, "postgres");

      const own = await engine.withRequestContext(
        {
          role: "authenticated",
          claims: { sub: "11111111-1111-4111-8111-111111111111", role: "authenticated" },
        },
        (session) => session.query("select body from public.notes order by id"),
      );
      assertEquals(own.rows, [{ body: "Alice note" }]);
      const other = await engine.withRequestContext(
        {
          role: "authenticated",
          claims: { sub: crypto.randomUUID(), role: "authenticated" },
        },
        (session) => session.query("select body from public.notes order by id"),
      );
      assertEquals(other.rows, []);
      await assertRequestContextContract(engine);
      await assertSqlSafetyContract(engine);

      const storageConfig = await loadConfig(
        project,
        { storagePath: join(temp, "storage-contract") },
        {},
      );
      const storageAuth = new AuthService(engine, {
        jwtSecret: "postgres-storage-contract-secret-with-at-least-32-characters",
      });
      await assertSupabaseStorageContract({
        config: storageConfig,
        engine,
        auth: storageAuth,
        objectStore: new LocalObjectStore(storageConfig.storage.path),
        email: "storage-postgres@example.com",
      });
      const contextConfig = await loadConfig(
        project,
        { storagePath: join(temp, "storage-context") },
        {},
      );
      await assertSupabaseServerContextContract({
        config: contextConfig,
        engine,
        objectStore: new LocalObjectStore(contextConfig.storage.path),
        authSecrets: await loadOrCreateAuthSecrets(join(temp, "context-auth-secrets.json")),
        prefix: "server",
      });

      const externalConfig = await loadConfig(
        project,
        { engine: "postgres" },
        {
          MINIBASE_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
          MINIBASE_DATABASE_MANAGED: "false",
        },
      );
      const external = await startConfiguredDatabase(externalConfig);
      try {
        assertEquals(external.mode, "external");
        assertEquals(await external.engine.health(), true);
        await assertRejects(
          () => startConfiguredDatabase(externalConfig),
          Error,
          "Another Minibase instance already owns this PostgreSQL database",
        );
      } finally {
        await external.close();
      }
      const reacquired = await startConfiguredDatabase(externalConfig);
      try {
        assertEquals(await reacquired.engine.health(), true);
      } finally {
        await reacquired.close();
      }
      assertEquals(await runtime.status(), true);

      const incompatibleRoot = join(temp, "incompatible-project");
      await Deno.mkdir(join(incompatibleRoot, "supabase", "migrations"), { recursive: true });
      await Deno.writeTextFile(
        join(incompatibleRoot, "supabase", "migrations", "20260804009999_missing.sql"),
        "create extension definitely_missing;\ncreate table public.must_not_exist(id integer);\n",
      );
      const incompatibleProject = await discoverProject(incompatibleRoot);
      await assertRejects(
        () => engine.applyMigrations(incompatibleProject),
        Error,
        "Extension definitely_missing is unavailable",
      );
      const missingWrites = await engine.query<{ table_name: string | null; count: number }>(
        `select to_regclass('public.must_not_exist')::text as table_name,
                (select count(*)::int
                 from supabase_migrations.schema_migrations
                 where version = '20260804009999') as count`,
      );
      assertEquals(missingWrites.rows, [{ table_name: null, count: 0 }]);

      const persistedBeforeCrash = await engine.query<{ count: number }>(
        "select count(*)::int as count from public.notes",
      );
      const beforeCrash = await engine.query<{ pid: number }>(
        "select pg_backend_pid()::int as pid",
      );
      await runtime.crashForTest();
      await waitFor(() => runtime.status().then((running) => !running));
      assertEquals(await fileExists(join(runtimeOptions.logsDir, "postgres.log")), true);
      const warm = await runtime.start();
      assertEquals(warm.initialized, false);
      assertEquals(warm.initializeMs, 0);
      assert(warm.startMs > 0);
      await waitFor(() => engine.health());
      const afterCrash = await engine.query<{ pid: number }>(
        "select pg_backend_pid()::int as pid",
      );
      assert(beforeCrash.rows[0]?.pid !== afterCrash.rows[0]?.pid);
      const persisted = await engine.query<{ count: number }>(
        "select count(*)::int as count from public.notes",
      );
      assertEquals(persisted.rows[0]?.count, persistedBeforeCrash.rows[0]?.count);
    } finally {
      await engine.close().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      await Deno.remove(temp, { recursive: true });
    }
  },
});

Deno.test({
  name: "PostgreSQL instance ownership fails closed after the lock session is lost",
  ignore: runtimeDir === null,
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-ownership-test-" });
    const port = availablePort();
    const runtime = new PostgresRuntime({
      runtimeDir: runtimeDir!,
      dataDir: join(temp, "postgres"),
      port,
      logsDir: join(temp, "logs"),
    });
    let owner: Awaited<ReturnType<typeof startConfiguredDatabase>> | null = null;
    let successor: Awaited<ReturnType<typeof startConfiguredDatabase>> | null = null;
    try {
      await runtime.start();
      const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
      const config = await loadConfig(project, { engine: "postgres" }, {
        MINIBASE_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
        MINIBASE_DATABASE_MANAGED: "false",
      });
      config.database.poolMin = 1;
      config.database.poolMax = 1;
      owner = await startConfiguredDatabase(config);
      const connectionCounts = await owner.engine.query<{
        application_name: string;
        count: number;
      }>(
        `select application_name, count(*)::int as count
         from pg_stat_activity
         where datname = current_database()
           and application_name in ('minibase', 'minibase-ownership')
         group by application_name
         order by application_name`,
      );
      assertEquals(connectionCounts.rows, [
        { application_name: "minibase", count: 1 },
        { application_name: "minibase-ownership", count: 1 },
      ]);
      await assertRejects(
        () => startConfiguredDatabase(config),
        Error,
        "Another Minibase instance already owns this PostgreSQL database",
      );

      const ownershipSession = await owner.engine.query<{ pid: number }>(
        `select pid::int as pid
         from pg_stat_activity
         where datname = current_database()
           and application_name = 'minibase-ownership'`,
      );
      assertEquals(ownershipSession.rows.length, 1);
      const terminated = await owner.engine.query<{ terminated: boolean }>(
        "select pg_terminate_backend($1::int) as terminated",
        [ownershipSession.rows[0]!.pid],
      );
      assertEquals(terminated.rows, [{ terminated: true }]);
      await waitFor(async () => {
        try {
          await owner!.engine.query("select 1");
          return false;
        } catch (error) {
          return error instanceof Error && error.message.includes("instance ownership was lost");
        }
      });
      await assertRejects(
        () => owner!.engine.query("select 1"),
        Error,
        "PostgreSQL instance ownership was lost",
      );
      await assertRejects(
        () => owner!.engine.exec("select 1"),
        Error,
        "PostgreSQL instance ownership was lost",
      );
      await assertRejects(
        () => owner!.engine.transaction((session) => session.query("select 1")),
        Error,
        "PostgreSQL instance ownership was lost",
      );
      assertEquals(await owner.engine.health(), false);

      successor = await startConfiguredDatabase(config);
      assertEquals(await successor.engine.health(), true);
    } finally {
      await successor?.close().catch(() => undefined);
      await owner?.close().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      await Deno.remove(temp, { recursive: true });
    }
  },
});

async function findPostgresRuntime(): Promise<string | null> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      if ((await Deno.stat(join(candidate, "bin", "postgres.exe"))).isFile) return candidate;
    } catch {
      // Try the next configured runtime.
    }
  }
  return null;
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for PostgreSQL state change");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
