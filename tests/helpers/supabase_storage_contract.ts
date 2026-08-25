import { assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import type { AuthService } from "../../src/auth/service.ts";
import type { MinibaseConfig } from "../../src/config/types.ts";
import type { DatabaseEngine } from "../../src/database/contract.ts";
import { createAppHandler } from "../../src/server/app.ts";
import type { ObjectStore } from "../../src/storage/contract.ts";

interface StorageContractOptions {
  config: MinibaseConfig;
  engine: DatabaseEngine;
  auth: AuthService;
  objectStore: ObjectStore;
  email: string;
}

export async function assertSupabaseStorageContract(
  options: StorageContractOptions,
): Promise<void> {
  const abortController = new AbortController();
  const handler = createAppHandler({
    config: options.config,
    engine: options.engine,
    authService: options.auth,
    objectStore: options.objectStore,
    resolveRequestContext: (request) => options.auth.resolveRequestContext(request),
  });
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    handler,
  );

  try {
    const baseUrl = `http://127.0.0.1:${await listening.promise}`;
    const serviceClient = createClient(
      baseUrl,
      await options.auth.createRoleToken("service_role"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const bucket = await serviceClient.storage.createBucket("avatars", { public: false });
    assertEquals(bucket.error, null);

    const client = createClient(baseUrl, await options.auth.createRoleToken("anon"), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const signup = await client.auth.signUp({
      email: options.email,
      password: "correct horse battery staple",
      options: { data: { display_name: "Storage User" } },
    });
    assertEquals(signup.error, null);

    const upload = await client.storage
      .from("avatars")
      .upload("profile/avatar.txt", new Blob(["hello storage"], { type: "text/plain" }), {
        cacheControl: "86400",
        metadata: { source: "shared-contract", nested: { retained: true } },
      });
    assertEquals(upload.error, null);

    const metadata = await options.engine.query<{
      metadata: Record<string, unknown>;
      user_metadata: Record<string, unknown>;
      metadata_type: string;
      user_metadata_type: string;
    }>(
      `select metadata, user_metadata, jsonb_typeof(metadata) as metadata_type,
              jsonb_typeof(user_metadata) as user_metadata_type
       from storage.objects where bucket_id = 'avatars' and name = 'profile/avatar.txt'`,
    );
    assertEquals(metadata.rows, [{
      metadata: { cacheControl: "max-age=86400", mimetype: "text/plain", size: 13 },
      user_metadata: { source: "shared-contract", nested: { retained: true } },
      metadata_type: "object",
      user_metadata_type: "object",
    }]);

    const list = await client.storage.from("avatars").list("profile");
    assertEquals(list.error, null);
    assertEquals(list.data?.[0]?.name, "profile/avatar.txt");
    assertEquals(list.data?.[0]?.metadata?.cacheControl, "max-age=86400");

    const download = await client.storage.from("avatars").download("profile/avatar.txt");
    assertEquals(download.error, null);
    assertEquals(await download.data?.text(), "hello storage");

    const rawUpload = await client.storage.from("avatars").upload(
      "profile/raw.bin",
      new Uint8Array([1, 2, 3]),
      {
        contentType: "application/octet-stream",
        cacheControl: "120",
        metadata: { transport: "raw" },
      },
    );
    assertEquals(rawUpload.error, null);
    const rawMetadata = await options.engine.query<{
      metadata: Record<string, unknown>;
      user_metadata: Record<string, unknown>;
    }>(
      `select metadata, user_metadata from storage.objects
       where bucket_id = 'avatars' and name = 'profile/raw.bin'`,
    );
    assertEquals(rawMetadata.rows, [{
      metadata: {
        cacheControl: "max-age=120",
        mimetype: "application/octet-stream",
        size: 3,
      },
      user_metadata: { transport: "raw" },
    }]);

    const signed = await client.storage.from("avatars").createSignedUrl("profile/avatar.txt", 60);
    assertEquals(signed.error, null);
    const signedDownload = await fetch(signed.data!.signedUrl);
    assertEquals(signedDownload.status, 200);
    assertEquals(signedDownload.headers.get("cache-control"), "max-age=86400");
    assertEquals(await signedDownload.text(), "hello storage");

    const privatePublicUrl = client.storage.from("avatars").getPublicUrl("profile/avatar.txt");
    const privatePublicDownload = await fetch(privatePublicUrl.data.publicUrl);
    assertEquals(privatePublicDownload.status, 404);

    const publicBucket = await serviceClient.storage.createBucket("public-assets", {
      public: true,
    });
    assertEquals(publicBucket.error, null);
    const publicUpload = await serviceClient.storage.from("public-assets").upload(
      "readme.txt",
      new Blob(["public storage"], { type: "text/plain" }),
    );
    assertEquals(publicUpload.error, null);
    const publicUrl = serviceClient.storage.from("public-assets").getPublicUrl("readme.txt");
    const publicDownload = await fetch(publicUrl.data.publicUrl);
    assertEquals(publicDownload.status, 200);
    assertEquals(await publicDownload.text(), "public storage");

    const limitedBucket = await serviceClient.storage.createBucket("upload-limits", {
      public: false,
      fileSizeLimit: 5,
      allowedMimeTypes: ["text/plain"],
    });
    assertEquals(limitedBucket.error, null);
    const allowed = await serviceClient.storage.from("upload-limits").upload(
      "allowed.txt",
      new Blob(["12345"], { type: "text/plain" }),
    );
    assertEquals(allowed.error, null);
    const tooLarge = await serviceClient.storage.from("upload-limits").upload(
      "too-large.txt",
      new Blob(["123456"], { type: "text/plain" }),
    );
    assertEquals(tooLarge.data, null);
    assertEquals(tooLarge.error?.status, 413);
    const wrongMime = await serviceClient.storage.from("upload-limits").upload(
      "wrong-mime.json",
      new Blob(["{}"], { type: "application/json" }),
    );
    assertEquals(wrongMime.data, null);
    assertEquals(wrongMime.error?.status, 415);
    const limitedMetadata = await options.engine.query<{ name: string }>(
      "select name from storage.objects where bucket_id = 'upload-limits' order by name",
    );
    assertEquals(limitedMetadata.rows, [{ name: "allowed.txt" }]);

    const remove = await client.storage.from("avatars").remove([
      "profile/avatar.txt",
      "profile/raw.bin",
    ]);
    assertEquals(remove.error, null);
    assertEquals(remove.data?.[0]?.name, "profile/avatar.txt");
  } finally {
    abortController.abort();
    await server.finished;
  }
}
