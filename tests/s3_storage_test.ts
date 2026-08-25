import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";

Deno.test("the same supabase-js Storage API works through the S3-compatible backend", async () => {
  const objects = new Map<string, Uint8Array>();
  let embeddedCopyErrorTarget: string | null = null;
  let interruptNextInitialPut = false;
  let echoCredentialsOnNextGet = false;
  let streamProbeActive = false;
  let streamedBytes = 0;
  let streamedChunks = 0;
  const streamFirstChunk = Promise.withResolvers<void>();
  const s3Abort = new AbortController();
  const s3Listening = Promise.withResolvers<number>();
  const s3Server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: s3Abort.signal,
      onListen: (address) => s3Listening.resolve(address.port),
    },
    async (request) => {
      const authorization = request.headers.get("authorization") ?? "";
      assertStringIncludes(authorization, "AWS4-HMAC-SHA256 Credential=test-access/");
      assertEquals(request.headers.get("x-amz-content-sha256"), "UNSIGNED-PAYLOAD");
      assertEquals(request.headers.get("x-amz-security-token"), "test-session-never-logged");
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/root-bucket\//u, ""));
      if (request.method === "PUT") {
        const copySource = request.headers.get("x-amz-copy-source");
        if (copySource !== null) {
          const source = decodeURIComponent(copySource.replace(/^\/root-bucket\//u, ""));
          const value = objects.get(source);
          if (value === undefined) return new Response("missing source", { status: 404 });
          if (key === embeddedCopyErrorTarget) {
            embeddedCopyErrorTarget = null;
            return new Response(
              `<?xml version="1.0" encoding="UTF-8"?>
               <Error><Code>InternalError</Code><Message>copy &amp; commit interrupted</Message></Error>`,
              { status: 200, headers: { "content-type": "application/xml" } },
            );
          }
          objects.set(key, value);
        } else {
          if (streamProbeActive && key.endsWith("avatars/profile/large-stream.bin")) {
            const reader = request.body!.getReader();
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              streamedBytes += next.value.byteLength;
              streamedChunks++;
              if (streamedChunks === 1) streamFirstChunk.resolve();
            }
            objects.set(key, new Uint8Array());
            return new Response(null, { status: 200 });
          }
          if (interruptNextInitialPut) {
            interruptNextInitialPut = false;
            const reader = request.body!.getReader();
            const first = await reader.read();
            if (!first.done) objects.set(key, ownedBytes(first.value));
            await reader.cancel("injected S3 PUT interruption");
            return new Response("injected upstream interruption", { status: 503 });
          }
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
        }
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        if (url.searchParams.get("list-type") === "2") {
          return new Response(
            "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>",
            { headers: { "content-type": "application/xml" } },
          );
        }
        if (echoCredentialsOnNextGet) {
          echoCredentialsOnNextGet = false;
          return new Response(
            "test-access test-secret-never-logged test-session-never-logged",
            { status: 503 },
          );
        }
        const value = objects.get(key);
        return value === undefined
          ? new Response("missing", { status: 404 })
          : new Response(ownedBytes(value), {
            headers: {
              "content-length": String(value.byteLength),
              "content-type": "application/octet-stream",
            },
          });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );

  const temp = await Deno.makeTempDir({ prefix: "minibase-s3-storage-test-" });
  const appAbort = new AbortController();
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const endpoint = `http://127.0.0.1:${await s3Listening.promise}`;
  const config = await loadConfig(project, { storageDriver: "s3" }, {
    MINIBASE_S3_ENDPOINT: endpoint,
    MINIBASE_S3_REGION: "auto",
    MINIBASE_S3_BUCKET: "root-bucket",
    MINIBASE_S3_ACCESS_KEY_ID: "test-access",
    MINIBASE_S3_SECRET_ACCESS_KEY: "test-secret-never-logged",
    MINIBASE_S3_SESSION_TOKEN: "test-session-never-logged",
  });
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const store = new S3ObjectStore(config.storage.s3!);
    assertEquals(await store.health(), true);
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      objectStore: store,
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
    });
    const listening = Promise.withResolvers<number>();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: appAbort.signal,
        onListen: (address) => listening.resolve(address.port),
      },
      handler,
    );
    const baseUrl = `http://127.0.0.1:${await listening.promise}`;
    const serviceRoleToken = await auth.createRoleToken("service_role");
    const serviceClient = createClient(baseUrl, serviceRoleToken, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const serializedMetadata = JSON.stringify(config.metadata);
    for (
      const credential of [
        "test-access",
        "test-secret-never-logged",
        "test-session-never-logged",
      ]
    ) {
      assertEquals(serializedMetadata.includes(credential), false);
    }
    assertEquals((await serviceClient.storage.createBucket("avatars")).error, null);
    const client = createClient(baseUrl, await auth.createRoleToken("anon"), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assertEquals(
      (await client.auth.signUp({
        email: "s3@example.com",
        password: "correct horse battery staple",
      })).error,
      null,
    );

    assertEquals(
      (await client.storage.from("avatars").upload(
        "profile/s3.txt",
        new Blob(["streamed through s3"], { type: "text/plain" }),
      )).error,
      null,
    );
    const downloaded = await client.storage.from("avatars").download("profile/s3.txt");
    assertEquals(downloaded.error, null);
    assertEquals(await downloaded.data?.text(), "streamed through s3");
    assert(objects.has("avatars/profile/s3.txt"));
    assert(![...objects.keys()].some((key) => key.startsWith(".minibase-tmp/")));
    assertEquals((await client.storage.from("avatars").remove(["profile/s3.txt"])).error, null);
    assertEquals(objects.has("avatars/profile/s3.txt"), false);

    const sourceRelease = Promise.withResolvers<void>();
    const chunkBytes = 256 * 1_024;
    const chunkCount = 64;
    let producedChunks = 0;
    streamProbeActive = true;
    let streamWriteSettled = false;
    const streamWritePromise = store.write(
      "avatars",
      "profile/large-stream.bin",
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (producedChunks === 1) await sourceRelease.promise;
          if (producedChunks === chunkCount) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkBytes));
          producedChunks++;
        },
      }),
    ).finally(() => {
      streamWriteSettled = true;
    });
    await withTimeout(streamFirstChunk.promise, 5_000, "S3 streaming upload did not start");
    assertEquals(streamWriteSettled, false);
    sourceRelease.resolve();
    const streamWrite = await streamWritePromise;
    assertEquals(streamWrite.size, chunkBytes * chunkCount);
    assertEquals(streamedBytes, chunkBytes * chunkCount);
    assert(streamedChunks > 1);
    await streamWrite.rollback();
    streamProbeActive = false;
    assert(![...objects.keys()].some((key) => key.startsWith(".minibase-tmp/")));

    interruptNextInitialPut = true;
    const interrupted = await client.storage.from("avatars").upload(
      "profile/interrupted.txt",
      new Blob(["body interrupted during the initial S3 PUT"], { type: "text/plain" }),
    );
    assertEquals(interrupted.data, null);
    assertEquals(interrupted.error?.status, 502);
    assertEquals(interrupted.error?.message, "S3 rejected the object before it could be staged");
    assert(![...objects.keys()].some((key) => key.startsWith(".minibase-tmp/")));
    assertEquals(
      (await engine.query<{ count: number }>(
        "select count(*)::int as count from storage.objects where name = 'profile/interrupted.txt'",
      )).rows,
      [{ count: 0 }],
    );

    const compensatingWrite = await store.write(
      "avatars",
      "profile/compensated.txt",
      new Blob(["compensated"]).stream(),
    );
    await compensatingWrite.commit();
    assert(objects.has("avatars/profile/compensated.txt"));
    await compensatingWrite.rollback();
    assertEquals(objects.has("avatars/profile/compensated.txt"), false);

    const originalWrite = await store.write(
      "avatars",
      "profile/replace.txt",
      new Blob(["old s3 body"]).stream(),
    );
    await originalWrite.commit();
    await originalWrite.finalize();
    const replacementWrite = await store.write(
      "avatars",
      "profile/replace.txt",
      new Blob(["new s3 body"]).stream(),
    );
    await replacementWrite.commit();
    await replacementWrite.rollback();
    const restored = await store.read("avatars", "profile/replace.txt");
    assertEquals(await new Response(restored.body).text(), "old s3 body");
    assert(![...objects.keys()].some((key) => key.startsWith(".minibase-tmp/")));

    const protectedWrite = await store.write(
      "avatars",
      "profile/xml-error.txt",
      new Blob(["protected old body"]).stream(),
    );
    await protectedWrite.commit();
    await protectedWrite.finalize();
    const failedCopy = await store.write(
      "avatars",
      "profile/xml-error.txt",
      new Blob(["must not replace old body"]).stream(),
    );
    embeddedCopyErrorTarget = "avatars/profile/xml-error.txt";
    await assertRejects(
      () => failedCopy.commit(),
      Error,
      "S3 backend returned an embedded CopyObject error",
    );
    await failedCopy.rollback();
    const protectedObject = await store.read("avatars", "profile/xml-error.txt");
    assertEquals(await new Response(protectedObject.body).text(), "protected old body");
    assert(![...objects.keys()].some((key) => key.startsWith(".minibase-tmp/")));

    assertEquals(
      (await client.storage.from("avatars").upload(
        "profile/backend-error.txt",
        new Blob(["backend error probe"]),
      )).error,
      null,
    );
    echoCredentialsOnNextGet = true;
    const backendFailure = await fetch(
      `${baseUrl}/storage/v1/object/avatars/profile/backend-error.txt`,
      { headers: { authorization: `Bearer ${serviceRoleToken}` } },
    );
    assertEquals(backendFailure.status, 502);
    const backendFailureBody = await backendFailure.text();
    assertStringIncludes(backendFailureBody, "S3 backend rejected GET with HTTP 503");
    for (
      const credential of [
        "test-access",
        "test-secret-never-logged",
        "test-session-never-logged",
      ]
    ) {
      assertEquals(backendFailureBody.includes(credential), false);
    }

    appAbort.abort();
    await server.finished;
  } finally {
    appAbort.abort();
    s3Abort.abort();
    await s3Server.finished;
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
