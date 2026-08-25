import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { exportLogicalBackup } from "../src/backup/export.ts";
import { loadLogicalBackup, restoreLogicalBackup } from "../src/backup/restore.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";

Deno.test("logical backup restores Auth, RLS, sequences, seed history and local objects", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-backup-restore-test-" });
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
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
    const backupDir = join(root, "logical-backup");
    let userId = "";
    try {
      await applyMigrations(source.engine, sourceProject);
      await applySeed(source.engine, sourceProject);
      const auth = new AuthService(
        source.engine,
        await loadOrCreateAuthSecrets(sourceProject.secretsFile),
      );
      const signup = await auth.signUp({
        email: "backup@example.com",
        password: "correct horse battery staple",
        data: { display_name: "Backup User" },
      });
      userId = signup.user.id;
      await source.engine.query(
        "insert into public.notes(owner_id, body) values ($1, 'backup note')",
        [userId],
      );
      await source.engine.query(
        "insert into storage.buckets(id, name) values ('backup-files', 'backup-files')",
      );
      await source.engine.query(
        `insert into storage.objects(id, bucket_id, name, owner, metadata)
         values ($1, 'backup-files', 'user/file.txt', $2, '{"size":7}'::jsonb)`,
        [crypto.randomUUID(), userId],
      );
      await source.engine.exec(
        `create table public.restore_stream_probe (
          id integer primary key,
          payload text not null
        )`,
      );
      await source.engine.exec(
        `insert into public.restore_stream_probe(id, payload)
         select value, repeat('x', 8192) from generate_series(1, 1024) as value`,
      );
      const objectPath = join(sourceProject.storageDir, "backup-files", "user", "file.txt");
      await Deno.mkdir(join(sourceProject.storageDir, "backup-files", "user"), {
        recursive: true,
      });
      await Deno.writeTextFile(objectPath, "restore");
      await exportLogicalBackup(source.engine, {
        projectId: sourceConfig.projectId,
        outputDir: backupDir,
        includeStorage: true,
        storagePath: sourceProject.storageDir,
      });
    } finally {
      await source.close();
    }

    const targetProject = await discoverProject(targetRoot);
    const targetConfig = await loadConfig(targetProject);
    await prepareProject(targetProject, "pglite");
    const target = await startConfiguredDatabase(targetConfig);
    try {
      await applyMigrations(target.engine, targetProject);
      await target.engine.exec(
        `create table public.restore_stream_probe (
          id integer primary key,
          payload text not null
        )`,
      );
      const restoreWholeFileReads = forbidWholeJsonlReads();
      const restored = await restoreLogicalBackup(target.engine, {
        inputDir: backupDir,
        storagePath: targetProject.storageDir,
      }).finally(restoreWholeFileReads);
      assertEquals(restored.sourceEngine, "pglite");
      assertEquals(restored.targetEngine, "pglite");
      assert(restored.rowsRestored > 0);
      assertEquals(restored.objectsRestored, 1);
      assert(restored.estimatedRestoreBytes > 7);
      assertEquals(await applySeed(target.engine, targetProject), false);
      const streamProbe = await target.engine.query<{ rows: number; bytes: number }>(
        `select count(*)::int as rows, sum(octet_length(payload))::int as bytes
         from public.restore_stream_probe`,
      );
      assertEquals(streamProbe.rows[0], { rows: 1024, bytes: 1024 * 8192 });

      const auth = new AuthService(
        target.engine,
        await loadOrCreateAuthSecrets(targetProject.secretsFile),
      );
      const login = await auth.signInWithPassword(
        "backup@example.com",
        "correct horse battery staple",
      );
      assertEquals(login.user.id, userId);
      const own = await target.engine.withRequestContext(
        { role: "authenticated", claims: { role: "authenticated", sub: userId } },
        (session) => session.query<{ body: string }>("select body from public.notes order by id"),
      );
      assert(own.rows.some((row) => row.body === "backup note"));
      assertEquals(
        await Deno.readTextFile(
          join(targetProject.storageDir, "backup-files", "user", "file.txt"),
        ),
        "restore",
      );
      const next = await target.engine.query<{ id: number }>(
        "insert into public.notes(owner_id, body) values ($1, 'after restore') returning id::int",
        [userId],
      );
      assertEquals(next.rows[0]?.id, 4);

      await assertRejects(
        () => restoreLogicalBackup(target.engine, { inputDir: backupDir }),
        Error,
        "not empty",
      );
    } finally {
      await target.close();
    }

    const manifest = await loadLogicalBackup(backupDir);
    const notes = manifest.tables.find((table) =>
      table.schema === "public" && table.name === "notes"
    )!;
    await Deno.writeTextFile(join(backupDir, ...notes.path.split("/")), "{}\n", {
      append: true,
    });
    await assertRejects(
      () => loadLogicalBackup(backupDir),
      Error,
      "checksum mismatch",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
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

function forbidWholeJsonlReads(): () => void {
  const originalReadFile = Deno.readFile;
  const originalReadTextFile = Deno.readTextFile;
  const rejectJsonl = (path: string | URL): void => {
    if (String(path).endsWith(".jsonl")) {
      throw new Error(`Whole-file JSONL read attempted: ${path}`);
    }
  };
  Object.defineProperty(Deno, "readFile", {
    configurable: true,
    value: ((path, options) => {
      rejectJsonl(path);
      return originalReadFile(path, options);
    }) satisfies typeof Deno.readFile,
  });
  Object.defineProperty(Deno, "readTextFile", {
    configurable: true,
    value: ((path, options) => {
      rejectJsonl(path);
      return originalReadTextFile(path, options);
    }) satisfies typeof Deno.readTextFile,
  });
  return () => {
    Object.defineProperty(Deno, "readFile", {
      configurable: true,
      value: originalReadFile,
    });
    Object.defineProperty(Deno, "readTextFile", {
      configurable: true,
      value: originalReadTextFile,
    });
  };
}
