import { createHash } from "node:crypto";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { exportLogicalBackup } from "../src/backup/export.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";

Deno.test("logical backup exports migrations, typed table rows and optional local objects", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-backup-export-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    const project = await discoverProject(temp);
    const config = await loadConfig(project);
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    const backupDir = join(project.backupsDir, "logical-test");
    try {
      await applyMigrations(database.engine, project);
      assertEquals(await applySeed(database.engine, project), true);
      await database.engine.query(
        "insert into storage.buckets(id, name) values ('avatars', 'avatars')",
      );
      await database.engine.query(
        `insert into storage.objects(id, bucket_id, name, owner, metadata)
         values ($1, 'avatars', 'alice/avatar.txt', $2, '{"size":6}'::jsonb)`,
        [crypto.randomUUID(), "11111111-1111-4111-8111-111111111111"],
      );
      const objectPath = join(project.storageDir, "avatars", "alice", "avatar.txt");
      await Deno.mkdir(join(project.storageDir, "avatars", "alice"), { recursive: true });
      await Deno.writeTextFile(objectPath, "avatar");
      await Deno.writeTextFile(project.secretsFile, '{"jwtSecret":"must-not-leak"}\n');

      const manifest = await exportLogicalBackup(database.engine, {
        projectId: config.projectId,
        outputDir: backupDir,
        includeStorage: true,
        storagePath: project.storageDir,
      });
      assertEquals(manifest.formatVersion, 1);
      assertEquals(manifest.source.engine, "pglite");
      assertEquals(manifest.migrations.map((migration) => migration.version), [
        "20260803000100",
        "20260803000200",
        "20260803000300",
      ]);
      assertEquals(manifest.seedHashes.length, 1);
      assertEquals(manifest.secretsIncluded, false);
      assert(manifest.capacity.tableDataBytes > 0);
      assertEquals(manifest.capacity.objectBytes, 6);
      assert(manifest.capacity.estimatedRestoreBytes > manifest.capacity.objectBytes);
      assert(manifest.tables.some((table) => table.schema === "auth" && table.name === "users"));
      assert(
        manifest.tables.some((table) => table.schema === "public" && table.name === "notes"),
      );
      assert(
        manifest.tables.some((table) => table.schema === "storage" && table.name === "objects"),
      );
      assertEquals(
        manifest.tables.some((table) => table.schema === "supabase_migrations"),
        false,
      );
      const notes = manifest.tables.find((table) =>
        table.schema === "public" && table.name === "notes"
      )!;
      assertEquals(notes.rowCount, 2);
      assert(notes.bytes > 0);
      assertEquals(await sha256File(join(backupDir, ...notes.path.split("/"))), notes.sha256);
      const noteRows = (await Deno.readTextFile(join(backupDir, ...notes.path.split("/"))))
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assertEquals(noteRows.map((row) => row.body).sort(), ["Alice note", "Bob note"]);

      assertEquals(manifest.objects, [{
        bucket: "avatars",
        name: "alice/avatar.txt",
        size: 6,
        path: "objects/000000.bin",
        sha256: await sha256File(join(backupDir, "objects", "000000.bin")),
      }]);
      assertEquals(await Deno.readTextFile(join(backupDir, "objects", "000000.bin")), "avatar");
      const allBackupText = await readTextTree(backupDir);
      assertEquals(allBackupText.includes("must-not-leak"), false);

      await assertRejects(
        () =>
          exportLogicalBackup(database.engine, {
            projectId: config.projectId,
            outputDir: backupDir,
          }),
        Error,
        "already exists",
      );
    } finally {
      await database.close();
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await Deno.readFile(path)).digest("hex");
}

async function readTextTree(path: string): Promise<string> {
  let result = "";
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) result += await readTextTree(child);
    else if (entry.isFile && !entry.name.endsWith(".bin")) result += await Deno.readTextFile(child);
  }
  return result;
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
