import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject, readProjectState } from "../src/project/state.ts";
import { upgradeProject } from "../src/project/upgrade.ts";
import type { ObjectStore } from "../src/storage/contract.ts";
import { PROJECT_FORMAT_VERSION } from "../src/version.ts";
import { s3SnapshotEnvironment, startS3SnapshotFixture } from "./helpers/s3_snapshot_fixture.ts";

const postgresRuntime = await findPostgresRuntime();

Deno.test({
  name: "managed PostgreSQL data-format upgrade preserves the real 18.4 cluster",
  ignore: postgresRuntime === null,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "minibase-upgrade-postgres-test-" });
    try {
      await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
      const project = await discoverProject(root);
      const config = await loadConfig(project, {
        engine: "postgres",
        port: availablePort(),
      }, {
        MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime!,
      });
      await prepareProject(project, "postgres");
      const database = await startConfiguredDatabase(config);
      try {
        await applyMigrations(database.engine, project);
        await applySeed(database.engine, project);
        await database.engine.exec(
          "insert into public.notes(owner_id, body) values ('11111111-1111-4111-8111-111111111111', 'server upgrade preserved')",
        );
      } finally {
        await database.close();
      }
      await Deno.writeTextFile(
        project.stateFile,
        JSON.stringify(
          {
            formatVersion: 1,
            engine: "postgres",
            minibaseVersion: "0.0.0-legacy",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          null,
          2,
        ) + "\n",
      );

      const upgraded = await upgradeProject(config);
      assertEquals(upgraded.upgraded, true);
      assertEquals(upgraded.databaseMajor, 18);
      assert(upgraded.backupDir !== null);
      assertEquals((await readProjectState(project))?.formatVersion, PROJECT_FORMAT_VERSION);

      const reopened = await startConfiguredDatabase(config);
      try {
        const result = await reopened.engine.query<{ body: string }>(
          "select body from public.notes where body = 'server upgrade preserved'",
        );
        assertEquals(result.rows, [{ body: "server upgrade preserved" }]);
      } finally {
        await reopened.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "external PostgreSQL permits only the read-only project-state upgrade",
  ignore: postgresRuntime === null,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "minibase-upgrade-external-postgres-test-" });
    try {
      await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
      const project = await discoverProject(root);
      const port = availablePort();
      const managedConfig = await loadConfig(project, { engine: "postgres" }, {
        MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime!,
        MINIBASE_POSTGRES_PORT: String(port),
      });
      await prepareProject(project, "postgres");
      const database = await startConfiguredDatabase(managedConfig);
      try {
        await applyMigrations(database.engine, project);
        await applySeed(database.engine, project);
        await database.engine.exec(
          "insert into public.notes(owner_id, body) values ('11111111-1111-4111-8111-111111111111', 'external upgrade preserved')",
        );
        await Deno.writeTextFile(
          project.stateFile,
          JSON.stringify(
            {
              formatVersion: 1,
              engine: "postgres",
              minibaseVersion: "0.0.0-legacy",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
            null,
            2,
          ) + "\n",
        );
        const externalConfig = await loadConfig(project, { engine: "postgres" }, {
          MINIBASE_DATABASE_URL:
            `postgres://postgres@127.0.0.1:${managedConfig.database.port}/postgres`,
          MINIBASE_DATABASE_MANAGED: "false",
        });

        await assertRejects(
          () =>
            upgradeProject(externalConfig, {
              afterStateWrite: () => {
                throw new Error("external metadata upgrade failure");
              },
            }),
          Error,
          "was rolled back",
        );
        assertEquals((await readProjectState(project))?.formatVersion, 1);
        assertEquals(
          (await database.engine.query<{ body: string }>(
            "select body from public.notes where body = 'external upgrade preserved'",
          )).rows,
          [{ body: "external upgrade preserved" }],
        );

        const cli = await runExternalUpgradeCli(
          root,
          `postgres://postgres@127.0.0.1:${managedConfig.database.port}/postgres`,
        );
        assertEquals(cli.code, 0);
        assertEquals(cli.stderr, "");
        assertEquals(cli.stdout.split(/\r?\n/u).length, 1);
        const upgraded = JSON.parse(cli.stdout) as {
          upgraded: boolean;
          databaseMajor: number;
          backupDir: string | null;
        };
        assertEquals(upgraded.upgraded, true);
        assertEquals(upgraded.databaseMajor, 18);
        assert(upgraded.backupDir !== null);
        assertEquals((await readProjectState(project))?.formatVersion, PROJECT_FORMAT_VERSION);
        const manifest = JSON.parse(
          await Deno.readTextFile(join(upgraded.backupDir, "manifest.json")),
        ) as {
          effects: { database: string; storage: string; secrets: string };
          entries: Array<{ kind: string }>;
        };
        assertEquals(manifest.effects, {
          database: "read-only",
          storage: "read-only",
          secrets: "read-only",
        });
        assertEquals(manifest.entries.some((entry) => entry.kind === "database"), false);
        assertEquals(
          (await database.engine.query<{ body: string }>(
            "select body from public.notes where body = 'external upgrade preserved'",
          )).rows,
          [{ body: "external upgrade preserved" }],
        );
      } finally {
        await database.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "managed PostgreSQL Storage-mutating upgrade restores its S3 snapshot on failure",
  ignore: postgresRuntime === null,
  fn: async () => {
    const fixture = startS3SnapshotFixture();
    const root = await Deno.makeTempDir({ prefix: "minibase-upgrade-postgres-s3-test-" });
    try {
      await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
      const endpoint = `http://127.0.0.1:${await fixture.port}`;
      const project = await discoverProject(root);
      const config = await loadConfig(project, { engine: "postgres" }, {
        ...s3SnapshotEnvironment(endpoint),
        MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime!,
        MINIBASE_POSTGRES_PORT: String(availablePort()),
      });
      await prepareProject(project, "postgres");
      const database = await startConfiguredDatabase(config);
      try {
        await applyMigrations(database.engine, project);
        await applySeed(database.engine, project);
        await database.engine.exec(
          "insert into public.notes(owner_id, body) values ('11111111-1111-4111-8111-111111111111', 'server S3 upgrade preserved')",
        );
      } finally {
        await database.close();
      }
      await writeLegacyState(project.stateFile, "postgres");
      fixture.put("avatars/server.txt", "server-before", "text/plain");
      const before = fixture.snapshot();

      const error = await assertRejects(
        () =>
          upgradeProject(config, {
            effects: { storage: "write" },
            afterStateWrite: async ({ storage }) => {
              await restoreRemoteObject(storage, "avatars/server.txt", "server-after");
              await restoreRemoteObject(storage, "documents/new.txt", "new-after");
              throw new Error("injected managed PostgreSQL S3 upgrade failure");
            },
          }),
        Error,
        "was rolled back",
      );
      assertStringIncludes(error.message, "injected managed PostgreSQL S3 upgrade failure");
      assertEquals(fixture.snapshot(), before);
      assertEquals((await readProjectState(project))?.formatVersion, 1);

      const reopened = await startConfiguredDatabase(config);
      try {
        assertEquals(
          (await reopened.engine.query<{ body: string }>(
            "select body from public.notes where body = 'server S3 upgrade preserved'",
          )).rows,
          [{ body: "server S3 upgrade preserved" }],
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await fixture.close();
      await Deno.remove(root, { recursive: true });
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

async function runExternalUpgradeCli(
  project: string,
  databaseUrl: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "upgrade",
      "--project",
      project,
      "--engine",
      "postgres",
      "--json",
    ],
    env: {
      MINIBASE_DATABASE_URL: databaseUrl,
      MINIBASE_DATABASE_MANAGED: "false",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
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

async function writeLegacyState(path: string, engine: "pglite" | "postgres"): Promise<void> {
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

async function restoreRemoteObject(
  store: ObjectStore | null,
  backendKey: string,
  value: string,
): Promise<void> {
  assert(store?.restoreListed !== undefined);
  const separator = backendKey.indexOf("/");
  assert(separator > 0 && separator < backendKey.length - 1);
  await store.restoreListed(
    {
      bucket: backendKey.slice(0, separator),
      name: backendKey.slice(separator + 1),
      backendKey,
      size: value.length,
    },
    new Blob([value]).stream(),
    "text/plain",
  );
}
