import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resetProject } from "../src/cli/lifecycle.ts";
import { loadConfig } from "../src/config/load.ts";
import { startConfiguredDatabase } from "../src/database/factory.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";

const S3_BUCKET = "reset-postgres-root";
const postgresRuntime = await findPostgresRuntime();

Deno.test({
  name: "managed PostgreSQL S3 reset rebuilds successfully and rolls back a later failure",
  ignore: postgresRuntime === null,
  fn: async () => {
    const fixture = startS3Fixture();
    const root = await createFixture("minibase-reset-s3-postgres-test-");
    try {
      const endpoint = `http://127.0.0.1:${await fixture.port}`;
      const project = await discoverProject(root);
      const config = await loadConfig(project, {
        engine: "postgres",
        port: availablePort(),
      }, {
        ...s3Environment(endpoint),
        MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime!,
      });
      await prepareProject(project, "postgres");
      let database = await startConfiguredDatabase(config);
      try {
        await applyMigrations(database.engine, project);
        await applySeed(database.engine, project);
        await database.engine.exec(
          "insert into public.notes(owner_id, body) values " +
            "('11111111-1111-4111-8111-111111111111', 'removed by server S3 reset')",
        );
      } finally {
        await database.close();
      }
      fixture.put("avatars/server.txt", "server-before", "text/plain");
      fixture.put(".minibase-tmp/interrupted/server.bin", "temporary-before");

      const reset = await resetProject(config, true);
      assertEquals(reset.migrations, [
        "20260803000100",
        "20260803000200",
        "20260803000300",
      ]);
      assertEquals(reset.seedApplied, true);
      assertEquals(fixture.snapshot(), []);

      database = await startConfiguredDatabase(config);
      try {
        assertEquals(
          (await database.engine.query<{ count: number }>(
            "select count(*)::int as count from public.notes " +
              "where body = 'removed by server S3 reset'",
          )).rows,
          [{ count: 0 }],
        );
        await database.engine.exec(
          "insert into public.notes(owner_id, body) values " +
            "('11111111-1111-4111-8111-111111111111', 'restored after server failure')",
        );
      } finally {
        await database.close();
      }
      fixture.put("documents/server.txt", "server-rollback", "text/plain");
      fixture.put(".minibase-tmp/interrupted/rollback.bin", "temporary-rollback");
      const beforeFailure = fixture.snapshot();
      await Deno.writeTextFile(
        join(project.migrationsDir, "20260805999999_break_server_reset.sql"),
        "this is not valid sql;\n",
      );

      const error = await assertRejects(
        () => resetProject(config, true),
        Error,
        "Reset failed and was rolled back",
      );
      assertStringIncludes(error.message, "20260805999999_break_server_reset.sql:1:1 failed");
      assertEquals(fixture.snapshot(), beforeFailure);
      database = await startConfiguredDatabase(config);
      try {
        assertEquals(
          (await database.engine.query<{ body: string }>(
            "select body from public.notes where body = 'restored after server failure'",
          )).rows,
          [{ body: "restored after server failure" }],
        );
      } finally {
        await database.close();
      }
    } finally {
      await fixture.close();
      await Deno.remove(root, { recursive: true });
    }
  },
});

function s3Environment(endpoint: string): Record<string, string> {
  return {
    MINIBASE_STORAGE_DRIVER: "s3",
    MINIBASE_S3_ENDPOINT: endpoint,
    MINIBASE_S3_REGION: "us-east-1",
    MINIBASE_S3_BUCKET: S3_BUCKET,
    MINIBASE_S3_ACCESS_KEY_ID: "reset-postgres-access",
    MINIBASE_S3_SECRET_ACCESS_KEY: "reset-postgres-secret",
    MINIBASE_S3_PATH_STYLE: "true",
  };
}

function startS3Fixture(): {
  port: Promise<number>;
  put(key: string, value: string, contentType?: string): void;
  snapshot(): Array<[string, string, string | undefined]>;
  close(): Promise<void>;
} {
  const objects = new Map<
    string,
    { bytes: Uint8Array; etag: string; contentType?: string }
  >();
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
        "AWS4-HMAC-SHA256 Credential=reset-postgres-access/",
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
          .sort(([left], [right]) => left.localeCompare(right, "en"))
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
        const etag = setObject(
          fullKey,
          new Uint8Array(await request.arrayBuffer()),
          request.headers.get("content-type") ?? undefined,
        );
        return new Response(null, { status: 200, headers: { etag } });
      }
      if (request.method === "GET") {
        const value = objects.get(fullKey);
        return value === undefined
          ? new Response("missing", { status: 404 })
          : new Response(value.bytes.slice(), {
            headers: {
              "content-length": String(value.bytes.byteLength),
              etag: value.etag,
              ...(value.contentType === undefined ? {} : { "content-type": value.contentType }),
            },
          });
      }
      if (request.method === "DELETE") {
        objects.delete(fullKey);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );
  function setObject(key: string, bytes: Uint8Array, contentType?: string): string {
    const etag = `"revision-${++revision}"`;
    objects.set(key, {
      bytes,
      etag,
      ...(contentType === undefined ? {} : { contentType }),
    });
    return etag;
  }
  return {
    port: listening.promise,
    put: (key, value, contentType) => {
      setObject(`${S3_BUCKET}/${key}`, new TextEncoder().encode(value), contentType);
    },
    snapshot: () =>
      [...objects.entries()]
        .filter(([key]) =>
          key.startsWith(`${S3_BUCKET}/`) &&
          key !== `${S3_BUCKET}/.minibase/ownership-v1.json`
        )
        .map(([key, value]): [string, string, string | undefined] => [
          key.slice(S3_BUCKET.length + 1),
          new TextDecoder().decode(value.bytes),
          value.contentType,
        ])
        .sort(([left], [right]) => left.localeCompare(right, "en")),
    close: async () => {
      abort.abort();
      await server.finished;
    },
  };
}

async function findPostgresRuntime(): Promise<string | null> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      const executable = join(
        candidate,
        "bin",
        Deno.build.os === "windows" ? "postgres.exe" : "postgres",
      );
      if ((await Deno.stat(executable)).isFile) return candidate;
    } catch {
      // Try the next known runtime location.
    }
  }
  return null;
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
