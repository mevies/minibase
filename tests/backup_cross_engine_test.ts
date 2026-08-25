import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { exportLogicalBackup } from "../src/backup/export.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import { createAppHandler } from "../src/server/app.ts";
import { LocalObjectStore } from "../src/storage/local.ts";

const postgresRuntime = await findPostgresRuntime();

Deno.test({
  name: "PGlite backup restores into PostgreSQL with Auth, RLS, Storage and Functions",
  ignore: postgresRuntime === null,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "minibase-backup-cross-engine-test-" });
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const backupDir = join(root, "backup");
    let manager: FunctionManager | null = null;
    try {
      await Deno.mkdir(sourceRoot);
      await Deno.mkdir(targetRoot);
      const fixture = join(Deno.cwd(), "fixtures", "supabase-basic");
      await copyTree(fixture, sourceRoot);
      await copyTree(fixture, targetRoot);

      const sourceProject = await discoverProject(sourceRoot);
      const sourceConfig = await loadConfig(sourceProject);
      await prepareProject(sourceProject, "pglite");
      const source = await startConfiguredDatabase(sourceConfig);
      let userId = "";
      let sourceNote: { id: number; created_epoch: number } | undefined;
      try {
        await applyMigrations(source.engine, sourceProject);
        await applySeed(source.engine, sourceProject);
        const auth = new AuthService(
          source.engine,
          await loadOrCreateAuthSecrets(sourceProject.secretsFile),
        );
        const signup = await auth.signUp({
          email: "cross-engine@example.com",
          password: "correct horse battery staple",
          data: { display_name: "Cross Engine" },
        });
        userId = signup.user.id;
        const insertedNote = await source.engine.query<{ id: number; created_epoch: number }>(
          `insert into public.notes(owner_id, body) values ($1, 'cross-engine note')
           returning id::int, extract(epoch from created_at)::double precision as created_epoch`,
          [userId],
        );
        sourceNote = insertedNote.rows[0]!;
        await source.engine.query(
          "insert into storage.buckets(id, name) values ('avatars', 'avatars')",
        );
        await source.engine.query(
          `insert into storage.objects(id, bucket_id, name, owner, metadata)
           values ($1, 'avatars', 'user/file.txt', $2, '{"size":12,"mimetype":"text/plain"}'::jsonb)`,
          [crypto.randomUUID(), userId],
        );
        const sourceObject = join(sourceProject.storageDir, "avatars", "user", "file.txt");
        await Deno.mkdir(join(sourceProject.storageDir, "avatars", "user"), {
          recursive: true,
        });
        await Deno.writeTextFile(sourceObject, "cross-engine");
        await exportLogicalBackup(source.engine, {
          projectId: sourceConfig.projectId,
          outputDir: backupDir,
          includeStorage: true,
          storagePath: sourceProject.storageDir,
        });
      } finally {
        await source.close();
      }
      assert(sourceNote !== undefined);

      const targetProject = await discoverProject(targetRoot);
      const databasePort = availablePort();
      const restoredByCli = await runCliProcess(
        [
          "backup",
          "restore",
          "--project",
          targetRoot,
          "--engine",
          "postgres",
          "--input",
          backupDir,
          "--json",
        ],
        targetRoot,
        databasePort,
        postgresRuntime!,
      );
      assertEquals(restoredByCli.code, 0, restoredByCli.stderr);
      assertEquals(restoredByCli.stderr, "");
      const cliResult = JSON.parse(restoredByCli.stdout) as {
        sourceEngine: string;
        targetEngine: string;
        safetyBackupDir: string | null;
      };
      assertEquals(cliResult.sourceEngine, "pglite");
      assertEquals(cliResult.targetEngine, "postgres");
      assertEquals(cliResult.safetyBackupDir, null);

      const targetConfig = await loadConfig(
        targetProject,
        { engine: "postgres" },
        {
          ...Deno.env.toObject(),
          MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime!,
          MINIBASE_POSTGRES_PORT: String(databasePort),
        },
      );
      const target = await startConfiguredDatabase(targetConfig);
      try {
        assertEquals(await applyMigrations(target.engine, targetProject), []);
        assertEquals(await applySeed(target.engine, targetProject), false);

        const auth = new AuthService(
          target.engine,
          await loadOrCreateAuthSecrets(targetProject.secretsFile),
        );
        const login = await auth.signInWithPassword(
          "cross-engine@example.com",
          "correct horse battery staple",
        );
        assertEquals(login.user.id, userId);
        assertEquals(login.user.user_metadata, { display_name: "Cross Engine" });
        const profile = await target.engine.query<{ display_name: string }>(
          "select display_name from public.profiles where id = $1",
          [userId],
        );
        assertEquals(profile.rows, [{ display_name: "Cross Engine" }]);
        assertEquals(
          await Deno.readTextFile(
            join(targetProject.storageDir, "avatars", "user", "file.txt"),
          ),
          "cross-engine",
        );
        const storageMetadata = await target.engine.query<{
          bucket_id: string;
          name: string;
          owner: string;
        }>("select bucket_id, name, owner from storage.objects");
        assertEquals(storageMetadata.rows, [{
          bucket_id: "avatars",
          name: "user/file.txt",
          owner: userId,
        }]);
        const visibleStorageMetadata = await target.engine.withRequestContext(
          { role: "authenticated", claims: { role: "authenticated", sub: userId } },
          (session) =>
            session.query<{ name: string }>(
              "select name from storage.objects where bucket_id = 'avatars'",
            ),
        );
        assertEquals(visibleStorageMetadata.rows, [{ name: "user/file.txt" }]);
        const own = await target.engine.withRequestContext(
          { role: "authenticated", claims: { role: "authenticated", sub: userId } },
          (session) =>
            session.query<{ id: number; body: string; created_epoch: number }>(
              `select id::int, body,
                 extract(epoch from created_at)::double precision as created_epoch
               from public.notes order by id`,
            ),
        );
        const restoredNote = own.rows.find((row) => row.body === "cross-engine note");
        assertEquals(restoredNote, { ...sourceNote, body: "cross-engine note" });
        const nextNote = await target.engine.query<{ id: number }>(
          "insert into public.notes(owner_id, body) values ($1, 'next sequence') returning id::int",
          [userId],
        );
        assertEquals(nextNote.rows[0]?.id, 4);

        const anonKey = await auth.createRoleToken("anon");
        manager = new FunctionManager({
          config: targetConfig,
          secrets: {
            anonKey,
            serviceRoleKey: await auth.createRoleToken("service_role"),
          },
        });
        const handler = createAppHandler({
          config: targetConfig,
          engine: target.engine,
          authService: auth,
          functionManager: manager,
          objectStore: new LocalObjectStore(targetProject.storageDir),
          resolveRequestContext: (request) => auth.resolveRequestContext(request),
        });
        const storage = await handler(
          new Request("http://localhost/storage/v1/object/avatars/user/file.txt", {
            headers: { authorization: `Bearer ${login.access_token}` },
          }),
        );
        assertEquals(storage.status, 200);
        assertEquals(await storage.text(), "cross-engine");

        const functionResponse = await handler(
          new Request("http://localhost/functions/v1/echo", {
            method: "POST",
            headers: {
              authorization: `Bearer ${login.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ restored: true }),
          }),
        );
        assertEquals(functionResponse.status, 200);
        assertEquals((await functionResponse.json()).body, { restored: true });
      } finally {
        await manager?.close();
        await target.close();
      }
    } finally {
      await manager?.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function findPostgresRuntime(): Promise<string | null> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (await fileExists(join(candidate, "bin", "postgres.exe"))) return candidate;
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function runCliProcess(
  args: string[],
  project: string,
  databasePort: number,
  runtimeDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd: project,
    env: {
      MINIBASE_POSTGRES_RUNTIME_DIR: runtimeDir,
      MINIBASE_POSTGRES_PORT: String(databasePort),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

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
