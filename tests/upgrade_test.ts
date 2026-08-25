import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { resetProject } from "../src/cli/lifecycle.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject, readProjectState } from "../src/project/state.ts";
import { upgradeProject } from "../src/project/upgrade.ts";
import type { ObjectStore } from "../src/storage/contract.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";
import { PROJECT_FORMAT_VERSION } from "../src/version.ts";
import {
  inspectWindowsSecretAcl,
  unauthorizedWindowsAclSids,
  windowsSecretAclIsPrivate,
} from "../src/security/windows_acl.ts";
import { s3SnapshotEnvironment, startS3SnapshotFixture } from "./helpers/s3_snapshot_fixture.ts";

Deno.test("upgrade backs up and upgrades real PGlite data without changing user files", async () => {
  const root = await createFixture("minibase-upgrade-pglite-test-");
  const migration = join(root, "supabase", "migrations", "20260803000100_create_profiles.sql");
  const migrationBefore = await Deno.readTextFile(migration);
  try {
    const project = await discoverProject(root);
    const config = await loadConfig(project);
    await prepareProject(project, "pglite");
    const database = await startConfiguredDatabase(config);
    try {
      await applyMigrations(database.engine, project);
      await applySeed(database.engine, project);
      await database.engine.exec(
        "insert into public.notes(owner_id, body) values ('11111111-1111-4111-8111-111111111111', 'upgrade preserved')",
      );
    } finally {
      await database.close();
    }
    await Deno.mkdir(join(project.storageDir, "upgrade"), { recursive: true });
    await Deno.writeTextFile(join(project.storageDir, "upgrade", "object.txt"), "preserved");
    await loadOrCreateAuthSecrets(project.secretsFile);
    await writeLegacyState(project.stateFile, "pglite");

    await assertRejects(
      () => prepareProject(project, "pglite"),
      Error,
      "run `minibase upgrade`",
    );
    const result = await upgradeProject(config);
    assertEquals(result.upgraded, true);
    assertEquals(result.fromFormatVersion, 1);
    assertEquals(result.toFormatVersion, PROJECT_FORMAT_VERSION);
    assertEquals(result.databaseMajor, 18);
    assert(result.backupDir !== null);

    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.backupDir, "manifest.json")),
    ) as {
      reason: string;
      fromFormatVersion: number;
      toFormatVersion: number;
      databaseMajor: number;
      storageDriver: string;
      effects: { database: string; storage: string; secrets: string };
      entries: Array<{ kind: string; files: Array<{ sha256: string }> }>;
      objects: unknown[];
    };
    assertEquals(manifest.reason, "upgrade");
    assertEquals(manifest.fromFormatVersion, 1);
    assertEquals(manifest.toFormatVersion, PROJECT_FORMAT_VERSION);
    assertEquals(manifest.databaseMajor, 18);
    assertEquals(manifest.storageDriver, "local");
    assertEquals(manifest.effects, {
      database: "read-only",
      storage: "read-only",
      secrets: "read-only",
    });
    assertEquals(
      manifest.entries.map((entry) => entry.kind),
      ["database", "storage", "secrets", "state"],
    );
    assertEquals(manifest.objects, []);
    assert(
      manifest.entries.every((entry) =>
        entry.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))
      ),
    );
    if (Deno.build.os === "windows") {
      assert(windowsSecretAclIsPrivate(await inspectWindowsSecretAcl(result.backupDir)));
      const backupSecret = join(result.backupDir, "entries", "02-secrets.json");
      assertEquals(
        unauthorizedWindowsAclSids(await inspectWindowsSecretAcl(backupSecret)),
        [],
      );
    }

    const state = await readProjectState(project);
    assertEquals(state?.formatVersion, PROJECT_FORMAT_VERSION);
    if (state?.formatVersion === PROJECT_FORMAT_VERSION) {
      assertEquals(state.database.postgresMajor, 18);
      assertEquals(state.components.pglite, "0.5.4");
      assertEquals(state.components.postgresRuntime, "18.4");
    }
    const reopened = await startConfiguredDatabase(config);
    try {
      const note = await reopened.engine.query<{ body: string }>(
        "select body from public.notes where body = 'upgrade preserved'",
      );
      assertEquals(note.rows, [{ body: "upgrade preserved" }]);
    } finally {
      await reopened.close();
    }
    assertEquals(
      await Deno.readTextFile(join(project.storageDir, "upgrade", "object.txt")),
      "preserved",
    );
    assertEquals(await Deno.readTextFile(migration), migrationBefore);

    const current = await upgradeProject(config);
    assertEquals(current.upgraded, false);
    assertEquals(current.backupDir, null);
    assertEquals(current.databaseMajor, 18);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed upgrade restores state, database, Storage and secrets from its backup", async () => {
  const root = await createFixture("minibase-upgrade-rollback-test-");
  try {
    const project = await discoverProject(root);
    const config = await loadConfig(project);
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.mkdir(project.storageDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await Deno.writeTextFile(join(project.pgliteDataDir, "data.bin"), "database-before");
    await Deno.writeTextFile(join(project.storageDir, "object.bin"), "storage-before");
    await Deno.writeTextFile(project.secretsFile, "secrets-before");
    await writeLegacyState(project.stateFile, "pglite");
    const stateBefore = await Deno.readTextFile(project.stateFile);

    const error = await assertRejects(
      () =>
        upgradeProject(config, {
          afterStateWrite: async () => {
            await Deno.writeTextFile(join(project.pgliteDataDir, "data.bin"), "database-after");
            await Deno.writeTextFile(join(project.storageDir, "object.bin"), "storage-after");
            await Deno.writeTextFile(project.secretsFile, "secrets-after");
            throw new Error("injected upgrade failure");
          },
        }),
      Error,
      "was rolled back",
    );
    assertStringIncludes(error.message, "injected upgrade failure");
    assertEquals(await Deno.readTextFile(project.stateFile), stateBefore);
    assertEquals(
      await Deno.readTextFile(join(project.pgliteDataDir, "data.bin")),
      "database-before",
    );
    assertEquals(await Deno.readTextFile(join(project.storageDir, "object.bin")), "storage-before");
    assertEquals(await Deno.readTextFile(project.secretsFile), "secrets-before");
    assertEquals((await readProjectState(project))?.formatVersion, 1);
    const backups = [];
    for await (const entry of Deno.readDir(project.backupsDir)) backups.push(entry.name);
    assertEquals(backups.length, 1);
    assert(backups[0]!.startsWith("upgrade-"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("upgrade rejects unsupported database majors before creating a backup", async () => {
  const root = await createFixture("minibase-upgrade-preflight-test-");
  try {
    const project = await discoverProject(root);
    const config = await loadConfig(project);
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "17\n");
    await writeLegacyState(project.stateFile, "pglite");
    await assertRejects(
      () => resetProject(config, true),
      Error,
      "run `minibase upgrade` first",
    );
    assertEquals(await Deno.readTextFile(join(project.pgliteDataDir, "PG_VERSION")), "17\n");
    await assertRejects(
      () => upgradeProject(config),
      Error,
      "expected PostgreSQL 18",
    );
    assertEquals(await pathExists(project.backupsDir), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata-only upgrade supports S3 without reading or writing remote objects", async () => {
  const root = await createFixture("minibase-upgrade-s3-read-only-test-");
  try {
    const project = await discoverProject(root);
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.mkdir(project.storageDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await Deno.writeTextFile(join(project.pgliteDataDir, "data.bin"), "database-preserved");
    await Deno.writeTextFile(join(project.storageDir, "unused-local-object.bin"), "not-s3");
    await loadOrCreateAuthSecrets(project.secretsFile);
    await writeLegacyState(project.stateFile, "pglite");
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(Deno.cwd(), "src", "main.ts"),
        "upgrade",
        "--project",
        root,
        "--json",
      ],
      cwd: root,
      env: {
        ...Deno.env.toObject(),
        MINIBASE_STORAGE_DRIVER: "s3",
        MINIBASE_S3_ENDPOINT: "http://127.0.0.1:1",
        MINIBASE_S3_REGION: "us-east-1",
        MINIBASE_S3_BUCKET: "unreachable-upgrade-bucket",
        MINIBASE_S3_ACCESS_KEY_ID: "upgrade-access",
        MINIBASE_S3_SECRET_ACCESS_KEY: "upgrade-secret",
        MINIBASE_S3_PATH_STYLE: "true",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assertEquals(stderr, "");
    const result = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      upgraded: boolean;
      backupDir: string;
    };
    assertEquals(result.upgraded, true);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.backupDir, "manifest.json")),
    ) as {
      storageDriver: string;
      effects: { database: string; storage: string; secrets: string };
      entries: Array<{ kind: string }>;
      objects: unknown[];
    };
    assertEquals(manifest.storageDriver, "s3");
    assertEquals(manifest.effects, {
      database: "read-only",
      storage: "read-only",
      secrets: "read-only",
    });
    assertEquals(
      manifest.entries.map((entry) => entry.kind),
      ["database", "secrets", "state"],
    );
    assertEquals(manifest.objects, []);
    assertEquals(
      await Deno.readTextFile(join(project.pgliteDataDir, "data.bin")),
      "database-preserved",
    );
    assertEquals(
      await Deno.readTextFile(join(project.storageDir, "unused-local-object.bin")),
      "not-s3",
    );
    assertEquals((await readProjectState(project))?.formatVersion, PROJECT_FORMAT_VERSION);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Storage-mutating S3 upgrade snapshots and preserves successful remote changes", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-upgrade-s3-write-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    fixture.put("avatars/alice.txt", "before-upgrade", "text/plain");

    const result = await upgradeProject(config, {
      effects: { storage: "write" },
      afterStateWrite: async ({ storage }) => {
        await restoreRemoteObject(storage, "avatars/alice.txt", "after-upgrade", "text/plain");
        await restoreRemoteObject(storage, "documents/new.txt", "created-by-upgrade", "text/plain");
      },
    });

    assertEquals(result.upgraded, true);
    assert(result.backupDir !== null);
    assertEquals(fixture.snapshot(), [
      ["avatars/alice.txt", "after-upgrade", "text/plain"],
      ["documents/new.txt", "created-by-upgrade", "text/plain"],
    ]);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(result.backupDir, "manifest.json")),
    ) as {
      storageDriver: string;
      effects: { storage: string };
      entries: Array<{ kind: string }>;
      objects: Array<{ backendKey: string; sha256: string; path: string }>;
    };
    assertEquals(manifest.storageDriver, "s3");
    assertEquals(manifest.effects.storage, "write");
    assertEquals(manifest.entries.map((entry) => entry.kind), ["database", "state"]);
    assertEquals(manifest.objects.map((object) => object.backendKey), ["avatars/alice.txt"]);
    assert(/^[0-9a-f]{64}$/u.test(manifest.objects[0]!.sha256));
    assertEquals(
      await Deno.readTextFile(join(result.backupDir, "objects", manifest.objects[0]!.path)),
      "before-upgrade",
    );
    assertEquals((await readProjectState(project))?.formatVersion, PROJECT_FORMAT_VERSION);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed Storage-mutating S3 upgrade restores the complete remote snapshot", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-upgrade-s3-write-rollback-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");
    fixture.put("documents/report.bin", "report-before", "application/octet-stream");
    fixture.put(".minibase-tmp/interrupted/object.bin", "temporary-before");
    const before = fixture.snapshot();

    const error = await assertRejects(
      () =>
        upgradeProject(config, {
          effects: { storage: "write" },
          afterStateWrite: async ({ storage }) => {
            await removeRemoteObject(storage, "avatars/alice.txt");
            await restoreRemoteObject(storage, "documents/report.bin", "report-after");
            await restoreRemoteObject(storage, "new/object.txt", "new-after");
            throw new Error("injected remote upgrade failure");
          },
        }),
      Error,
      "was rolled back",
    );
    assertStringIncludes(error.message, "injected remote upgrade failure");
    assertEquals(fixture.snapshot(), before);
    assertEquals((await readProjectState(project))?.formatVersion, 1);
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("upgrade-")).length, 1);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Storage-mutating S3 upgrade preserves its backup when remote rollback is incomplete", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-upgrade-s3-incomplete-rollback-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");

    const error = await assertRejects(
      () =>
        upgradeProject(config, {
          effects: { storage: "write" },
          afterStateWrite: async ({ storage }) => {
            await restoreRemoteObject(storage, "documents/new.txt", "new-after");
            fixture.failDelete(1);
            throw new Error("injected failure before incomplete rollback");
          },
        }),
      Error,
      "automatic rollback was incomplete",
    );
    assertStringIncludes(error.message, "S3 backend rejected DELETE");
    assertEquals((await readProjectState(project))?.formatVersion, 1);
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("upgrade-")).length, 1);
    const backupDir = join(project.backupsDir, backups[0]!);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(backupDir, "manifest.json")),
    ) as { objects: Array<{ backendKey: string; path: string; sha256: string }> };
    assertEquals(manifest.objects.map((object) => object.backendKey), ["avatars/alice.txt"]);
    assertEquals(
      await Deno.readTextFile(join(backupDir, "objects", manifest.objects[0]!.path)),
      "alice-before",
    );
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Storage-mutating S3 upgrade aborts before mutation when its snapshot changed", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-upgrade-s3-inventory-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    fixture.put("avatars/alice.txt", "alice-before", "text/plain");
    fixture.putBeforeList(2, "documents/concurrent.txt", "concurrent-before-write", "text/plain");
    let mutationCalled = false;

    const error = await assertRejects(
      () =>
        upgradeProject(config, {
          effects: { storage: "write" },
          afterStateWrite: () => {
            mutationCalled = true;
          },
        }),
      Error,
      "was rolled back",
    );
    assertStringIncludes(error.message, "Remote Storage changed");
    assertEquals(mutationCalled, false);
    assertEquals(fixture.snapshot(), [
      ["avatars/alice.txt", "alice-before", "text/plain"],
      ["documents/concurrent.txt", "concurrent-before-write", "text/plain"],
    ]);
    assertEquals((await readProjectState(project))?.formatVersion, 1);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Storage-mutating S3 upgrade refuses a root bucket owned by another writer", async () => {
  const fixture = startS3SnapshotFixture();
  const root = await createFixture("minibase-upgrade-s3-ownership-test-");
  try {
    const endpoint = `http://127.0.0.1:${await fixture.port}`;
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, s3SnapshotEnvironment(endpoint));
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    const owner = new S3ObjectStore(config.storage.s3!, { ownershipRequired: true });
    await owner.acquireOwnership("foreign-upgrade-owner");
    try {
      await assertRejects(
        () => upgradeProject(config, { effects: { storage: "write" } }),
        Error,
        "already owned by another Minibase writer",
      );
      assertEquals((await readProjectState(project))?.formatVersion, 1);
      assertEquals(await pathExists(project.backupsDir), false);
    } finally {
      await owner.releaseOwnership();
    }
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("upgrade CLI emits one JSON result and leaves an auditable backup", async () => {
  const root = await createFixture("minibase-upgrade-cli-test-");
  try {
    const project = await discoverProject(root);
    await Deno.mkdir(project.pgliteDataDir, { recursive: true });
    await Deno.mkdir(project.storageDir, { recursive: true });
    await Deno.writeTextFile(join(project.pgliteDataDir, "PG_VERSION"), "18\n");
    await writeLegacyState(project.stateFile, "pglite");
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(Deno.cwd(), "src", "main.ts"),
        "upgrade",
        "--project",
        root,
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout).trim();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assertEquals(stderr, "");
    assertEquals(stdout.split(/\r?\n/u).length, 1);
    const result = JSON.parse(stdout) as {
      upgraded: boolean;
      databaseMajor: number;
      backupDir: string;
    };
    assertEquals(result.upgraded, true);
    assertEquals(result.databaseMajor, 18);
    assertEquals((await Deno.stat(join(result.backupDir, "manifest.json"))).isFile, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function writeLegacyState(path: string, engine: "pglite" | "postgres"): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      {
        formatVersion: 1,
        engine,
        minibaseVersion: "0.0.0-legacy",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function restoreRemoteObject(
  store: ObjectStore | null,
  backendKey: string,
  value: string,
  contentType?: string,
): Promise<void> {
  assert(store?.restoreListed !== undefined);
  const object = listedObject(backendKey, value.length);
  await store.restoreListed(
    object,
    new Blob([value]).stream(),
    contentType,
  );
}

async function removeRemoteObject(store: ObjectStore | null, backendKey: string): Promise<void> {
  assert(store?.removeListed !== undefined);
  await store.removeListed(listedObject(backendKey, 0));
}

function listedObject(backendKey: string, size: number) {
  const separator = backendKey.indexOf("/");
  assert(separator > 0 && separator < backendKey.length - 1);
  return {
    bucket: backendKey.slice(0, separator),
    name: backendKey.slice(separator + 1),
    backendKey,
    size,
  };
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
