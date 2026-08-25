import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import type { DatabaseEngine } from "../src/database/contract.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createStorageHandler } from "../src/storage/handler.ts";
import type { ObjectStore, PendingObjectWrite, StoredObject } from "../src/storage/contract.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import { assertSupabaseStorageContract } from "./helpers/supabase_storage_contract.ts";

Deno.test("official supabase-js uploads, lists, downloads and removes a local object", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    await assertSupabaseStorageContract({
      config,
      engine,
      auth,
      objectStore: new LocalObjectStore(config.storage.path),
      email: "storage-pglite@example.com",
    });
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("a failed database commit removes the already committed local object", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-rollback-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  const store = new LocalObjectStore(join(temp, "storage"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await engine.query(
      "insert into storage.buckets(id, name) values ('avatars', 'avatars')",
    );
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const commitFailingEngine = new Proxy(engine, {
      get(target, property) {
        if (property === "withRequestContext") {
          return (
            requestContext: Parameters<DatabaseEngine["withRequestContext"]>[0],
            callback: Parameters<DatabaseEngine["withRequestContext"]>[1],
          ) =>
            target.withRequestContext(requestContext, async (session) => {
              await callback(session);
              throw new Error("forced database commit failure");
            });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseEngine;
    const handler = createStorageHandler(commitFailingEngine, auth, store);
    const response = await handler(
      new Request("http://localhost/storage/v1/object/avatars/failed.txt", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await auth.createRoleToken("service_role")}`,
          "content-type": "text/plain",
        },
        body: "must be rolled back",
      }),
    );
    assertEquals(response?.status, 400);
    assertEquals((await response!.json()).message, "forced database commit failure");
    assertEquals(
      (await engine.query<{ count: number }>(
        "select count(*)::int as count from storage.objects where name = 'failed.txt'",
      )).rows,
      [{ count: 0 }],
    );
    await Deno.stat(store.path("avatars", "failed.txt"))
      .then(() => {
        throw new Error("rolled back object still exists");
      })
      .catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    assertEquals(await store.list(), []);

    const original = await store.write(
      "avatars",
      "existing.txt",
      new Blob(["old body"]).stream(),
    );
    await original.commit();
    await original.finalize();
    await engine.query(
      `insert into storage.objects(id, bucket_id, name, metadata)
       values ($1, 'avatars', 'existing.txt', '{"size":8,"mimetype":"text/plain"}'::jsonb)`,
      [crypto.randomUUID()],
    );
    const failedOverwrite = await handler(
      new Request("http://localhost/storage/v1/object/avatars/existing.txt", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await auth.createRoleToken("service_role")}`,
          "content-type": "text/plain",
        },
        body: "replacement body",
      }),
    );
    assertEquals(failedOverwrite?.status, 400);
    const restored = await store.read("avatars", "existing.txt");
    assertEquals(await new Response(restored.body).text(), "old body");
    assertEquals(
      (await engine.query<{ size: number }>(
        `select (metadata ->> 'size')::int as size
         from storage.objects where bucket_id = 'avatars' and name = 'existing.txt'`,
      )).rows,
      [{ size: 8 }],
    );
    assertEquals(
      (await store.list()).map((object) => object.name),
      ["existing.txt"],
    );
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("same-object writes wait for a failed predecessor to finish rollback", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-concurrency-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  const local = new LocalObjectStore(join(temp, "storage"));
  const store = new RollbackGatedObjectStore(local);
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await engine.query("insert into storage.buckets(id, name) values ('avatars', 'avatars')");
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const token = await auth.createRoleToken("service_role");
    let failFirstTransaction = true;
    const failOnceEngine = new Proxy(engine, {
      get(target, property) {
        if (property === "withRequestContext") {
          return (
            requestContext: Parameters<DatabaseEngine["withRequestContext"]>[0],
            callback: Parameters<DatabaseEngine["withRequestContext"]>[1],
          ) =>
            target.withRequestContext(requestContext, async (session) => {
              const result = await callback(session);
              if (failFirstTransaction) {
                failFirstTransaction = false;
                throw new Error("forced first database commit failure");
              }
              return result;
            });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseEngine;
    const handler = createStorageHandler(failOnceEngine, auth, store);
    const upload = (body: string, name = "concurrent.txt") =>
      handler(
        new Request(`http://localhost/storage/v1/object/avatars/${name}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body,
        }),
      );

    const first = upload("first-body");
    await withTimeout(store.rollbackStarted.promise, 5_000, "first rollback did not start");
    assertEquals((await upload("parallel-body", "parallel.txt"))?.status, 200);
    let removalSettled = false;
    const removal = handler(
      new Request("http://localhost/storage/v1/object/avatars", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: ["concurrent.txt"] }),
      }),
    ).finally(() => {
      removalSettled = true;
    });
    let secondSettled = false;
    const second = upload("second-body").finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(store.writes.filter((write) => write.name === "concurrent.txt").length, 1);
    assertEquals(removalSettled, false);
    assertEquals(secondSettled, false);

    store.releaseRollback.resolve();
    assertEquals((await first)?.status, 400);
    assertEquals((await removal)?.status, 200);
    assertEquals((await second)?.status, 200);
    const stored = await local.read("avatars", "concurrent.txt");
    assertEquals(await new Response(stored.body).text(), "second-body");
    assertEquals(
      (await engine.query<{ version: string; size: number }>(
        `select version, (metadata ->> 'size')::int as size
         from storage.objects where bucket_id = 'avatars' and name = 'concurrent.txt'`,
      )).rows,
      [{
        version: store.writes.filter((write) => write.name === "concurrent.txt")[1]?.writeId,
        size: 11,
      }],
    );
    assertEquals((await upload("third-body"))?.status, 200);
    assertEquals(store.writes.filter((write) => write.name === "concurrent.txt").length, 3);
    const final = await local.read("avatars", "concurrent.txt");
    assertEquals(await new Response(final.body).text(), "third-body");
    assertEquals((await local.list()).map((item) => item.name).sort(), [
      "concurrent.txt",
      "parallel.txt",
    ]);
  } finally {
    store.releaseRollback.resolve();
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("failed object writes and malicious paths leave no files or metadata", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-negative-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  const store = new LocalObjectStore(join(temp, "storage"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await engine.query(
      `insert into storage.buckets(id, name)
       values ('avatars', 'avatars'), ('bad/bucket', 'bad/bucket')`,
    );
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const token = await auth.createRoleToken("service_role");
    const failingStore: ObjectStore = {
      driver: "local",
      health: () => Promise.resolve(false),
      write: () => Promise.reject(new Error("forced object write failure")),
      read: (bucket, name) => store.read(bucket, name),
      remove: (bucket, name) => store.remove(bucket, name),
    };
    const failedWrite = await createStorageHandler(engine, auth, failingStore)(
      new Request("http://localhost/storage/v1/object/avatars/write-failed.txt", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
        body: "must not reach metadata",
      }),
    );
    assertEquals(failedWrite?.status, 400);
    assertEquals((await failedWrite!.json()).message, "forced object write failure");

    const handler = createStorageHandler(engine, auth, store);
    const invalidMetadataBody = new FormData();
    invalidMetadataBody.append("cacheControl", "3600");
    invalidMetadataBody.append("metadata", "[]");
    invalidMetadataBody.append("", new Blob(["invalid metadata"], { type: "text/plain" }));
    const invalidMetadata = await handler(
      new Request("http://localhost/storage/v1/object/avatars/invalid-metadata.txt", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: invalidMetadataBody,
      }),
    );
    assertEquals(invalidMetadata?.status, 400);
    assertEquals((await invalidMetadata!.json()).error, "InvalidMetadata");

    for (
      const path of [
        "avatars/..%5Cescape.txt",
        "avatars/%2F..%2Fescape.txt",
        "bad%2Fbucket/file.txt",
        "avatars/bad%ZZname.txt",
      ]
    ) {
      const response = await handler(
        new Request(`http://localhost/storage/v1/object/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body: "hostile",
        }),
      );
      assertEquals(response?.status, 400, path);
    }
    assertEquals(
      (await engine.query<{ count: number }>(
        "select count(*)::int as count from storage.objects",
      )).rows,
      [{ count: 0 }],
    );
    assertEquals(await store.list(), []);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("local capacity failures return 507 and remove partial temporary files", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-capacity-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await engine.query(
      "insert into storage.buckets(id, name) values ('avatars', 'avatars')",
    );
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const token = await auth.createRoleToken("service_role");
    for (const stage of ["open", "write"] as const) {
      const store = new CapacityFailingLocalStore(join(temp, `storage-${stage}`), stage);
      const response = await createStorageHandler(engine, auth, store)(
        new Request(`http://localhost/storage/v1/object/avatars/out-of-space-${stage}.txt`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "text/plain",
          },
          body: "partial body must be removed",
        }),
      );
      assertEquals(response?.status, 507);
      assertEquals(await response!.json(), {
        statusCode: "507",
        error: "StorageCapacityExceeded",
        message: "Local storage capacity is exhausted",
      });
      assertEquals(await store.list(), []);
    }
    assertEquals(
      (await engine.query<{ count: number }>(
        "select count(*)::int as count from storage.objects",
      )).rows,
      [{ count: 0 }],
    );
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

class CapacityFailingLocalStore extends LocalObjectStore {
  constructor(root: string, private readonly stage: "open" | "write") {
    super(root);
  }

  protected override async openTemporary(
    path: string,
  ): Promise<{ writable: WritableStream<Uint8Array>; close(): void }> {
    if (this.stage === "open") throw capacityError();
    await Deno.writeFile(path, new Uint8Array());
    return {
      writable: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          await Deno.writeFile(path, chunk.slice(0, 1), { append: true });
          throw capacityError();
        },
      }),
      close() {},
    };
  }
}

class RollbackGatedObjectStore implements ObjectStore {
  readonly driver = "local" as const;
  readonly rollbackStarted = Promise.withResolvers<void>();
  readonly releaseRollback = Promise.withResolvers<void>();
  readonly writes: Array<{ name: string; writeId: string }> = [];

  constructor(private readonly local: LocalObjectStore) {}

  health(): Promise<boolean> {
    return this.local.health();
  }

  async write(
    bucket: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PendingObjectWrite> {
    const pending = await this.local.write(bucket, name, body);
    this.writes.push({ name, writeId: pending.writeId });
    if (this.writes.length !== 1) return pending;
    return {
      ...pending,
      rollback: async () => {
        this.rollbackStarted.resolve();
        await this.releaseRollback.promise;
        await pending.rollback();
      },
    };
  }

  read(bucket: string, name: string): Promise<StoredObject> {
    return this.local.read(bucket, name);
  }

  remove(bucket: string, name: string): Promise<void> {
    return this.local.remove(bucket, name);
  }

  list(): Promise<Array<{ bucket: string; name: string; size: number }>> {
    return this.local.list();
  }
}

function capacityError(): Error {
  return Object.assign(new Error("No space left on device (os error 28)"), { code: "ENOSPC" });
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
