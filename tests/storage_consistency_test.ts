import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { checkStorageConsistency } from "../src/storage/consistency.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";

Deno.test("Storage consistency check reports and explicitly repairs every inconsistency class", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-consistency-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"));
  const store = new LocalObjectStore(join(temp, "storage"));
  try {
    await engine.start();
    const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
    await applyMigrations(engine, project);
    await engine.query(
      "insert into storage.buckets(id, name) values ('checks', 'checks')",
    );
    await engine.query(
      `insert into storage.objects(id, bucket_id, name, metadata)
       values
         ($1, 'checks', 'wrong-size.txt', '{"size":99}'::jsonb),
         ($2, 'checks', 'missing.txt', '{"size":7}'::jsonb)`,
      [crypto.randomUUID(), crypto.randomUUID()],
    );
    await committedWrite(store, "checks", "wrong-size.txt", "abc");
    await committedWrite(store, "checks", "orphan.txt", "orphan");
    await committedWrite(store, "checks", "stale.minibase-upload-dead", "temporary");

    const report = await checkStorageConsistency(engine, store);
    assertEquals(report.ok, false);
    assertEquals(report.missingFiles.map((item) => item.name), ["missing.txt"]);
    assertEquals(report.orphanFiles.map((item) => item.name), ["orphan.txt"]);
    assertEquals(report.temporaryFiles.map((item) => item.name), [
      "stale.minibase-upload-dead",
    ]);
    assertEquals(report.sizeMismatches[0]?.actualSize, 3);

    await checkStorageConsistency(engine, store, { repair: true, force: true });
    assertEquals((await checkStorageConsistency(engine, store)).ok, true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("S3 consistency listing paginates and repairs exact backend keys", async () => {
  const objects = new Map<string, Uint8Array>([
    ["checks/healthy.txt", new TextEncoder().encode("healthy")],
    ["checks/orphan&name.txt", new TextEncoder().encode("orphan")],
    ["checks/wrong-size.txt", new TextEncoder().encode("abc")],
    [
      ".minibase-tmp/stale-write/checks/stale.txt",
      new TextEncoder().encode("temporary"),
    ],
  ]);
  let listRequests = 0;
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        if (url.searchParams.get("encoding-type") !== "url") {
          return new Response("encoding required", { status: 400 });
        }
        listRequests++;
        const token = url.searchParams.get("continuation-token");
        const expectedQuery = token === null
          ? "?encoding-type=url&list-type=2"
          : `?continuation-token=${encodeURIComponent(token)}&encoding-type=url&list-type=2`;
        if (url.search !== expectedQuery) {
          return new Response("bad canonical query", { status: 400 });
        }
        const offset = token === null ? 0 : Number(/^offset:(\d+)\+next\/&$/u.exec(token)?.[1]);
        if (!Number.isInteger(offset)) return new Response("bad token", { status: 400 });
        const entries = [...objects.entries()].sort(([left], [right]) => left.localeCompare(right));
        const page = entries.slice(offset, offset + 2);
        const nextOffset = offset + page.length;
        const truncated = nextOffset < entries.length;
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <EncodingType>url</EncodingType>
  <IsTruncated>${truncated}</IsTruncated>
  ${
            page.map(([key, value]) =>
              `<Contents><Key>${
                escapeXml(encodeURIComponent(key))
              }</Key><Size>${value.byteLength}</Size></Contents>`
            ).join("\n  ")
          }
  ${
            truncated
              ? `<NextContinuationToken>${
                escapeXml(`offset:${nextOffset}+next/&`)
              }</NextContinuationToken>`
              : ""
          }
</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/root-bucket\//u, ""));
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );

  const temp = await Deno.makeTempDir({ prefix: "minibase-s3-consistency-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
    await applyMigrations(engine, project);
    await engine.query("insert into storage.buckets(id, name) values ('checks', 'checks')");
    await engine.query(
      `insert into storage.objects(id, bucket_id, name, metadata)
       values
         ($1, 'checks', 'healthy.txt', '{"size":7}'::jsonb),
         ($2, 'checks', 'wrong-size.txt', '{"size":99}'::jsonb),
         ($3, 'checks', 'missing.txt', '{"size":7}'::jsonb)`,
      [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    );
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${await listening.promise}`,
      region: "auto",
      bucket: "root-bucket",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      pathStyle: true,
    });

    const report = await checkStorageConsistency(engine, store);
    assertEquals(listRequests, 2);
    assertEquals(report.missingFiles.map((item) => item.name), ["missing.txt"]);
    assertEquals(report.orphanFiles.map((item) => item.name), ["orphan&name.txt"]);
    assertEquals(report.temporaryFiles, [{
      bucket: ".minibase-tmp",
      name: "stale-write/checks/stale.txt",
      size: 9,
    }]);
    assertEquals(report.sizeMismatches[0]?.actualSize, 3);

    await checkStorageConsistency(engine, store, { repair: true, force: true });
    assertEquals((await checkStorageConsistency(engine, store)).ok, true);
    assertEquals(objects.has("checks/orphan&name.txt"), false);
    assertEquals(objects.has(".minibase-tmp/stale-write/checks/stale.txt"), false);
  } finally {
    abort.abort();
    await server.finished;
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("S3 listing rejects repeated tokens and oversized responses", async () => {
  let mode: "repeated-token" | "oversized" = "repeated-token";
  let requests = 0;
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    () => {
      requests++;
      if (mode === "oversized") {
        return new Response(new Uint8Array(8 * 1_024 * 1_024 + 1));
      }
      return new Response(
        `<ListBucketResult>
           <EncodingType>url</EncodingType>
           <IsTruncated>true</IsTruncated>
           <NextContinuationToken>repeated-token</NextContinuationToken>
         </ListBucketResult>`,
      );
    },
  );
  try {
    const store = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${await listening.promise}`,
      region: "auto",
      bucket: "root-bucket",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret-never-exposed",
      pathStyle: true,
    });
    await assertRejects(
      () => store.list(),
      Error,
      "S3 backend returned an invalid ListObjectsV2 continuation token",
    );
    assertEquals(requests, 2);

    mode = "oversized";
    requests = 0;
    const oversized = await assertRejects(
      () => store.list(),
      Error,
      "S3 backend returned an invalid ListObjectsV2 response",
    );
    assertEquals(requests, 1);
    assertEquals(oversized.message.includes("test-secret-never-exposed"), false);
  } finally {
    abort.abort();
    await server.finished;
  }
});

async function committedWrite(
  store: LocalObjectStore,
  bucket: string,
  name: string,
  text: string,
): Promise<void> {
  const upload = await store.write(bucket, name, new Blob([text]).stream());
  await upload.commit();
  await upload.finalize();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
