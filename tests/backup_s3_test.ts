import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { exportLogicalBackup } from "../src/backup/export.ts";
import { restoreLogicalBackup } from "../src/backup/restore.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import type {
  ListedObject,
  ObjectStore,
  PendingObjectWrite,
  StoredObject,
} from "../src/storage/contract.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";

Deno.test("logical backups stream object bodies across S3 and local backends", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-backup-s3-test-" });
  const s3 = startS3Fixture();
  try {
    const endpoint = `http://127.0.0.1:${await s3.port}`;
    const sourceStore = createS3Store(endpoint, "source-root");
    const s3Backup = join(root, "s3-backup");

    const source = await startFixtureProject(join(root, "source"));
    try {
      await applySeed(source.database.engine, source.project);
      const auth = new AuthService(
        source.database.engine,
        await loadOrCreateAuthSecrets(source.project.secretsFile),
      );
      const user = await auth.signUp({
        email: "s3-backup@example.com",
        password: "correct horse battery staple",
      });
      await source.database.engine.query(
        "insert into storage.buckets(id, name) values ('backup-files', 'backup-files')",
      );
      await source.database.engine.query(
        `insert into storage.objects(id, bucket_id, name, owner, metadata) values
           ($1, 'backup-files', 'alpha.txt', $3, '{"size":10}'::jsonb),
           ($2, 'backup-files', 'nested/beta.bin', $3, '{"size":4}'::jsonb)`,
        [crypto.randomUUID(), crypto.randomUUID(), user.user.id],
      );
      await writeObject(
        sourceStore,
        "backup-files",
        "alpha.txt",
        new TextEncoder().encode("alpha-body"),
      );
      await writeObject(
        sourceStore,
        "backup-files",
        "nested/beta.bin",
        new Uint8Array([0, 1, 2, 3]),
      );
    } finally {
      await source.database.close();
    }

    const exported = await runBackupCli(
      [
        "backup",
        "export",
        "--project",
        source.project.root,
        "--output",
        s3Backup,
        "--include-storage",
        "--json",
      ],
      source.project.root,
      s3Environment(endpoint, "source-root"),
    );
    assertEquals(exported.code, 0, exported.stderr);
    assertEquals(exported.stderr, "");
    const manifest = JSON.parse(exported.stdout) as {
      objects: Array<{ bucket: string; name: string; size: number }>;
    };
    assertEquals(
      manifest.objects.map(({ bucket, name, size }) => ({ bucket, name, size })),
      [
        { bucket: "backup-files", name: "alpha.txt", size: 10 },
        { bucket: "backup-files", name: "nested/beta.bin", size: 4 },
      ],
    );

    const directStore = createS3Store(endpoint, "direct-target-root");
    const directRoot = join(root, "direct-target");
    await prepareFixtureDirectory(directRoot);
    const restored = await runBackupCli(
      [
        "backup",
        "restore",
        "--project",
        directRoot,
        "--input",
        s3Backup,
        "--json",
      ],
      directRoot,
      s3Environment(endpoint, "direct-target-root"),
    );
    assertEquals(restored.code, 0, restored.stderr);
    assertEquals(restored.stderr, "");
    assertEquals((JSON.parse(restored.stdout) as { objectsRestored: number }).objectsRestored, 2);
    assertEquals(await readText(directStore, "backup-files", "alpha.txt"), "alpha-body");
    assertEquals(
      await readBytes(directStore, "backup-files", "nested/beta.bin"),
      new Uint8Array([0, 1, 2, 3]),
    );
    const checked = await runBackupCli(
      ["storage", "check", "--project", directRoot, "--json"],
      directRoot,
      s3Environment(endpoint, "direct-target-root"),
    );
    assertEquals(checked.code, 0, checked.stderr);
    assertEquals((JSON.parse(checked.stdout) as { ok: boolean }).ok, true);

    const local = await startFixtureProject(join(root, "local-target"));
    const localStore = new LocalObjectStore(local.project.storageDir);
    const localBackup = join(root, "local-backup");
    try {
      await restoreLogicalBackup(local.database.engine, {
        inputDir: s3Backup,
        objectStore: localStore,
      });
      assertEquals(await readText(localStore, "backup-files", "alpha.txt"), "alpha-body");
      await exportLogicalBackup(local.database.engine, {
        projectId: local.config.projectId,
        outputDir: localBackup,
        includeStorage: true,
        storagePath: local.project.storageDir,
        objectStore: localStore,
      });
    } finally {
      await local.database.close();
    }

    const roundTripStore = createS3Store(endpoint, "round-trip-target-root");
    const roundTrip = await startFixtureProject(join(root, "round-trip-target"));
    try {
      await restoreLogicalBackup(roundTrip.database.engine, {
        inputDir: localBackup,
        objectStore: roundTripStore,
      });
      assertEquals(await readText(roundTripStore, "backup-files", "alpha.txt"), "alpha-body");
      assertEquals(
        await readBytes(roundTripStore, "backup-files", "nested/beta.bin"),
        new Uint8Array([0, 1, 2, 3]),
      );
    } finally {
      await roundTrip.database.close();
    }

    const failedDelegate = createS3Store(endpoint, "failed-target-root");
    const failedStore = new FailingCommitStore(failedDelegate, "nested/beta.bin");
    const failed = await startFixtureProject(join(root, "failed-target"));
    try {
      await assertRejects(
        () =>
          restoreLogicalBackup(failed.database.engine, {
            inputDir: s3Backup,
            objectStore: failedStore,
          }),
        Error,
        "Storage object commit failed; database restore was rolled back",
      );
      assertEquals(
        (await failed.database.engine.query<{ count: number }>(
          "select count(*)::int as count from storage.objects",
        )).rows,
        [{ count: 0 }],
      );
      assertEquals(await failedDelegate.list(), []);

      await writeObject(
        failedDelegate,
        "backup-files",
        "alpha.txt",
        new TextEncoder().encode("preexisting-body"),
      );
      await assertRejects(
        () =>
          restoreLogicalBackup(failed.database.engine, {
            inputDir: s3Backup,
            objectStore: failedDelegate,
          }),
        Error,
        "Storage restore target already exists: backup-files/alpha.txt",
      );
      assertEquals(
        await readText(failedDelegate, "backup-files", "alpha.txt"),
        "preexisting-body",
      );
      assertEquals(
        (await failed.database.engine.query<{ count: number }>(
          "select count(*)::int as count from storage.objects",
        )).rows,
        [{ count: 0 }],
      );
    } finally {
      await failed.database.close();
    }
  } finally {
    await s3.close();
    await Deno.remove(root, { recursive: true });
  }
});

class FailingCommitStore implements ObjectStore {
  readonly driver = "s3" as const;

  constructor(
    private readonly delegate: ObjectStore,
    private readonly failingName: string,
  ) {}

  health(): Promise<boolean> {
    return this.delegate.health();
  }

  async write(
    bucket: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PendingObjectWrite> {
    const pending = await this.delegate.write(bucket, name, body);
    return {
      ...pending,
      commit: name === this.failingName
        ? () => Promise.reject(new Error("injected second object commit failure"))
        : () => pending.commit(),
    };
  }

  read(bucket: string, name: string): Promise<StoredObject> {
    return this.delegate.read(bucket, name);
  }

  remove(bucket: string, name: string): Promise<void> {
    return this.delegate.remove(bucket, name);
  }

  list(): Promise<ListedObject[]> {
    return this.delegate.list!();
  }
}

async function startFixtureProject(root: string) {
  await prepareFixtureDirectory(root);
  const project = await discoverProject(root);
  const config = await loadConfig(project);
  await prepareProject(project, "pglite");
  const database = await startConfiguredDatabase(config);
  await applyMigrations(database.engine, project);
  return { project, config, database };
}

async function prepareFixtureDirectory(root: string): Promise<void> {
  await Deno.mkdir(root, { recursive: true });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
}

function createS3Store(endpoint: string, bucket: string): S3ObjectStore {
  return new S3ObjectStore({
    endpoint,
    region: "us-east-1",
    bucket,
    accessKeyId: "backup-access",
    secretAccessKey: "backup-secret",
    pathStyle: true,
  });
}

function s3Environment(endpoint: string, bucket: string): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    MINIBASE_STORAGE_DRIVER: "s3",
    MINIBASE_S3_ENDPOINT: endpoint,
    MINIBASE_S3_REGION: "us-east-1",
    MINIBASE_S3_BUCKET: bucket,
    MINIBASE_S3_ACCESS_KEY_ID: "backup-access",
    MINIBASE_S3_SECRET_ACCESS_KEY: "backup-secret",
    MINIBASE_S3_PATH_STYLE: "true",
  };
}

async function runBackupCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function writeObject(
  store: ObjectStore,
  bucket: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const pending = await store.write(bucket, name, new Blob([owned]).stream());
  await pending.commit();
  await pending.finalize();
}

async function readText(store: ObjectStore, bucket: string, name: string): Promise<string> {
  return await new Response((await store.read(bucket, name)).body).text();
}

async function readBytes(
  store: ObjectStore,
  bucket: string,
  name: string,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response((await store.read(bucket, name)).body).arrayBuffer());
}

function startS3Fixture(): {
  port: Promise<number>;
  close(): Promise<void>;
} {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let revision = 0;
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    async (request) => {
      assertStringIncludes(
        request.headers.get("authorization") ?? "",
        "AWS4-HMAC-SHA256 Credential=backup-access/",
      );
      const url = new URL(request.url);
      const target = decodeURIComponent(url.pathname.replace(/^\//u, ""));
      const separator = target.indexOf("/");
      const root = separator < 0 ? target : target.slice(0, separator);
      const key = separator < 0 ? "" : target.slice(separator + 1);
      const fullKey = `${root}/${key}`;

      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = `${root}/`;
        const contents = [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => {
            const relative = name.slice(prefix.length);
            return `<Contents><Key>${
              escapeXml(encodeURIComponent(relative))
            }</Key><Size>${value.bytes.byteLength}</Size></Contents>`;
          })
          .join("");
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }

      if (request.method === "PUT") {
        const current = objects.get(fullKey);
        if (request.headers.get("if-none-match") === "*" && current !== undefined) {
          return new Response("precondition failed", { status: 412 });
        }
        const ifMatch = request.headers.get("if-match");
        if (ifMatch !== null && current?.etag !== ifMatch) {
          return new Response("precondition failed", { status: 412 });
        }
        const copySource = request.headers.get("x-amz-copy-source");
        let bytes: Uint8Array;
        if (copySource === null) {
          bytes = new Uint8Array(await request.arrayBuffer());
        } else {
          const source = decodeURIComponent(copySource.replace(/^\//u, ""));
          const value = objects.get(source);
          if (value === undefined) return new Response("missing", { status: 404 });
          bytes = value.bytes.slice();
        }
        const etag = `"revision-${++revision}"`;
        objects.set(fullKey, { bytes, etag });
        return new Response(null, { status: 200, headers: { etag } });
      }

      if (request.method === "GET") {
        const value = objects.get(fullKey);
        return value === undefined
          ? new Response("missing", { status: 404 })
          : new Response(value.bytes.slice(), {
            headers: { "content-length": String(value.bytes.byteLength), etag: value.etag },
          });
      }

      if (request.method === "DELETE") {
        objects.delete(fullKey);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );
  return {
    port: listening.promise,
    close: async () => {
      abort.abort();
      await server.finished;
    },
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
