import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { resetProject } from "../src/cli/lifecycle.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import { s3SnapshotEnvironment, startS3SnapshotFixture } from "./helpers/s3_snapshot_fixture.ts";

Deno.test("S3 reset snapshots every remote key before clearing and rebuilding the database", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-reset-s3-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const environment = s3SnapshotEnvironment(endpoint);
    const config = await loadConfig(project, {}, environment);
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    try {
      await applyMigrations(database.engine, project);
      await applySeed(database.engine, project);
      await database.engine.exec(
        "insert into public.notes(owner_id, body) values " +
          "('11111111-1111-4111-8111-111111111111', 'removed by S3 reset')",
      );
    } finally {
      await database.close();
    }
    fixture.put("avatars/alice.txt", "alice-avatar", "text/plain");
    fixture.put("documents/report.bin", "report-body", "application/octet-stream");
    fixture.put(".minibase-tmp/interrupted/previous/avatars/alice.txt", "stale-backup");
    const before = fixture.snapshot();

    const output = await runResetCli(root, environment);
    assertEquals(output.code, 0, output.stderr);
    assertEquals(output.stderr, "");
    const result = JSON.parse(output.stdout) as {
      backupDir: string;
      migrations: string[];
      seedApplied: boolean;
    };
    assertEquals(result.migrations, [
      "20260803000100",
      "20260803000200",
      "20260803000300",
    ]);
    assertEquals(result.seedApplied, true);
    assertEquals(fixture.snapshot(), []);

    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.backupDir, "manifest.json")),
    ) as {
      formatVersion: number;
      reason: string;
      storageDriver: string;
      entries: Array<{ kind: string; backupPath: string }>;
      objects: Array<{
        backendKey: string;
        size: number;
        sha256: string;
        path: string;
        contentType?: string;
      }>;
    };
    assertEquals(manifest.formatVersion, 1);
    assertEquals(manifest.reason, "reset");
    assertEquals(manifest.storageDriver, "s3");
    assertEquals(manifest.entries.map((entry) => entry.kind), ["database"]);
    assertEquals(manifest.objects.map((object) => object.backendKey), before.map(([key]) => key));
    for (const object of manifest.objects) {
      assert(/^[0-9a-f]{64}$/u.test(object.sha256));
      const expected = before.find(([key]) => key === object.backendKey);
      assert(expected !== undefined);
      const bytes = await Deno.readFile(join(result.backupDir, "objects", object.path));
      assertEquals(new TextDecoder().decode(bytes), expected[1]);
      assertEquals(object.size, bytes.byteLength);
      assertEquals(object.contentType, expected[2]);
    }

    const reopened = await startConfiguredDatabase(config);
    try {
      const oldRows = await reopened.engine.query<{ count: number }>(
        "select count(*)::int as count from public.notes where body = 'removed by S3 reset'",
      );
      assertEquals(oldRows.rows, [{ count: 0 }]);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an empty S3 reset reports the manifest-only backup it created", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-reset-empty-s3-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));

    const result = await resetProject(config, true);
    assert(result.backupDir !== null);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.backupDir, "manifest.json")),
    ) as { storageDriver: string; entries: unknown[]; objects: unknown[] };
    assertEquals(manifest.storageDriver, "s3");
    assertEquals(manifest.entries, []);
    assertEquals(manifest.objects, []);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a partial S3 clear failure restores remote keys and the original database", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-reset-s3-rollback-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    await database.close();
    const marker = join(project.pgliteDataDir, "reset-rollback-marker.txt");
    await Deno.writeTextFile(marker, "database-before");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");
    fixture.put("documents/report.txt", "report-before", "text/plain");
    fixture.put(".minibase-tmp/interrupted/object.bin", "temporary-before");
    const before = fixture.snapshot();
    fixture.failDelete(2);

    const error = await assertRejects(
      () => resetProject(config, true),
      Error,
      "was rolled back",
    );
    assertStringIncludes(error.message, "S3 backend rejected DELETE");
    assertEquals(await Deno.readTextFile(marker), "database-before");
    assertEquals(fixture.snapshot(), before);
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("reset-")).length, 0);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a failed S3 reset rebuild restores remote keys and the original database", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-reset-s3-rebuild-rollback-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    await database.close();
    const marker = join(project.pgliteDataDir, "reset-rebuild-rollback-marker.txt");
    await Deno.writeTextFile(marker, "database-before");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");
    fixture.put(".minibase-tmp/interrupted/object.bin", "temporary-before");
    const before = fixture.snapshot();
    await Deno.writeTextFile(
      join(project.migrationsDir, "20260805999999_break_reset.sql"),
      "this is not valid sql;\n",
    );

    const error = await assertRejects(
      () => resetProject(config, true),
      Error,
      "Reset failed and was rolled back",
    );
    assertStringIncludes(error.message, "20260805999999_break_reset.sql:1:1 failed");
    assertEquals(await Deno.readTextFile(marker), "database-before");
    assertEquals(fixture.snapshot(), before);
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("reset-")).length, 0);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("S3 reset aborts without mutation when the pre-clear inventory changed", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-reset-s3-inventory-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    await database.close();
    const marker = join(project.pgliteDataDir, "reset-inventory-marker.txt");
    await Deno.writeTextFile(marker, "database-before");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");
    fixture.putBeforeList(2, "documents/concurrent.txt", "concurrent-before-clear", "text/plain");

    await assertRejects(
      () => resetProject(config, true),
      Error,
      "Remote Storage changed while the reset snapshot was being applied",
    );
    assertEquals(await Deno.readTextFile(marker), "database-before");
    assertEquals(fixture.snapshot(), [
      ["avatars/alice.txt", "alice-before", "text/plain"],
      ["documents/concurrent.txt", "concurrent-before-clear", "text/plain"],
    ]);
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("reset-")).length, 0);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function runResetCli(
  root: string,
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "reset",
      "--project",
      root,
      "--force",
      "--json",
    ],
    cwd: root,
    env: { ...Deno.env.toObject(), ...environment },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function createFixture(prefix: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
  return root;
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

async function directoryNames(path: string): Promise<string[]> {
  try {
    const names = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}
