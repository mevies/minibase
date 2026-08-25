import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { stopProject } from "../src/cli/lifecycle.ts";
import { parseCliArguments } from "../src/cli/args.ts";
import { loadConfig } from "../src/config/load.ts";
import { signJwt } from "../src/auth/jwt.ts";
import { activeAuthSigningKey, loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";
import { startServer } from "../src/server/start.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";

Deno.test("S3 conditional ownership fences separate project databases sharing one root bucket", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-s3-ownership-test-" });
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), firstRoot);
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), secondRoot);
  const s3 = startConditionalS3Fixture();
  const endpoint = `http://127.0.0.1:${await s3.port}`;
  const firstProject = await discoverProject(firstRoot);
  const secondProject = await discoverProject(secondRoot);
  const firstPort = availablePort();
  const secondPort = availablePort();
  const environment = s3Environment(endpoint);
  const firstConfig = await loadConfig(
    firstProject,
    { storageDriver: "s3", port: firstPort, publicUrl: `http://127.0.0.1:${firstPort}` },
    environment,
  );
  const secondConfig = await loadConfig(
    secondProject,
    { storageDriver: "s3", port: secondPort, publicUrl: `http://127.0.0.1:${secondPort}` },
    environment,
  );
  let firstRun: Promise<unknown> | null = null;
  let secondRun: Promise<unknown> | null = null;
  try {
    assertEquals(parseCliArguments(["storage", "unlock", "--force"]).command, "storage:unlock");

    firstRun = startServer(firstConfig);
    await waitForRuntime(firstProject.runtimeFile);
    assertEquals((await fetch(`${firstConfig.server.publicUrl}/health/ready`)).status, 200);

    await assertRejects(
      () => startServer(secondConfig),
      Error,
      "S3 bucket is already owned by another Minibase writer",
    );
    assertEquals(await readRuntimeState(secondProject), null);

    const serviceClient = createClient(
      firstConfig.server.publicUrl,
      await serviceRoleToken(firstProject.secretsFile),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    assertEquals((await serviceClient.storage.createBucket("ownership-probe")).error, null);
    assertEquals(
      (await serviceClient.storage.from("ownership-probe").upload(
        "before-loss.txt",
        new Blob(["owned"]),
      )).error,
      null,
    );

    const refusedUnlock = await runStorageUnlock(secondRoot, environment, false);
    assertEquals(refusedUnlock.code, 1);
    assertStringIncludes(refusedUnlock.stderr, "verify every Minibase instance is stopped");
    const forcedUnlock = await runStorageUnlock(secondRoot, environment, true);
    assertEquals(forcedUnlock.code, 0, forcedUnlock.stderr);
    assertEquals(JSON.parse(forcedUnlock.stdout), {
      released: true,
      previousState: "active",
    });

    const staleWrite = await serviceClient.storage.from("ownership-probe").upload(
      "after-loss.txt",
      new Blob(["must fail"]),
    );
    assertEquals(staleWrite.data, null);
    assertEquals(staleWrite.error?.status, 503);
    assertStringIncludes(
      staleWrite.error?.message ?? "",
      "S3 bucket ownership was replaced",
    );
    const staleRemove = await serviceClient.storage.from("ownership-probe").remove([
      "before-loss.txt",
    ]);
    assertEquals(staleRemove.data, null);
    assertEquals(staleRemove.error?.status, 503);
    assertStringIncludes(staleRemove.error?.message ?? "", "ownership was replaced");
    assertEquals((await fetch(`${firstConfig.server.publicUrl}/health/ready`)).status, 503);

    secondRun = startServer(secondConfig);
    await waitForRuntime(secondProject.runtimeFile);
    assertEquals((await fetch(`${secondConfig.server.publicUrl}/health/ready`)).status, 200);

    assertEquals((await stopProject(firstConfig, false)).stopped, true);
    await firstRun;
    firstRun = null;
    assertEquals((await fetch(`${secondConfig.server.publicUrl}/health/ready`)).status, 200);

    assertEquals((await stopProject(secondConfig, false)).stopped, true);
    await secondRun;
    secondRun = null;

    const next = new S3ObjectStore(s3Config(endpoint), { ownershipRequired: true });
    await next.acquireOwnership("next-clean-owner");
    await next.releaseOwnership();
    assert(s3.conditionalRequests >= 6);
  } finally {
    await stopIfRunning(firstConfig);
    await stopIfRunning(secondConfig);
    await firstRun?.catch(() => undefined);
    await secondRun?.catch(() => undefined);
    await s3.close();
    await Deno.remove(root, { recursive: true });
  }
});

interface StoredFixtureObject {
  body: Uint8Array;
  etag: string;
  contentType?: string;
}

function startConditionalS3Fixture(): {
  port: Promise<number>;
  readonly conditionalRequests: number;
  close(): Promise<void>;
} {
  const objects = new Map<string, StoredFixtureObject>();
  let revision = 0;
  let conditionalRequests = 0;
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
      const authorization = request.headers.get("authorization") ?? "";
      assertStringIncludes(authorization, "AWS4-HMAC-SHA256 Credential=ownership-access/");
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/root-bucket\/?/u, ""));
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const contents = [...objects.entries()].toSorted(([left], [right]) =>
          left.localeCompare(right, "en")
        ).map(([name, object]) =>
          `<Contents><Key>${
            escapeXml(encodeURIComponent(name))
          }</Key><Size>${object.body.byteLength}</Size></Contents>`
        ).join("");
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }

      if (request.method === "PUT") {
        const current = objects.get(key);
        const ifNoneMatch = request.headers.get("if-none-match");
        const ifMatch = request.headers.get("if-match");
        if (ifNoneMatch !== null || ifMatch !== null) {
          conditionalRequests++;
          assertStringIncludes(
            authorization,
            ifNoneMatch !== null ? "if-none-match" : "if-match",
          );
        }
        if (ifNoneMatch === "*" && current !== undefined) {
          return new Response("precondition failed", { status: 412 });
        }
        if (ifMatch !== null && current?.etag !== ifMatch) {
          return new Response("precondition failed", { status: 412 });
        }
        const copySource = request.headers.get("x-amz-copy-source");
        let body: Uint8Array;
        let contentType = request.headers.get("content-type") ?? undefined;
        if (copySource === null) {
          body = new Uint8Array(await request.arrayBuffer());
        } else {
          const sourceKey = decodeURIComponent(copySource.replace(/^\/root-bucket\//u, ""));
          const source = objects.get(sourceKey);
          if (source === undefined) return new Response("missing", { status: 404 });
          body = source.body.slice();
          contentType = source.contentType;
        }
        const etag = `"revision-${++revision}"`;
        objects.set(key, { body, etag, contentType });
        return new Response(null, { status: 200, headers: { etag } });
      }

      if (request.method === "GET") {
        const object = objects.get(key);
        return object === undefined
          ? new Response("missing", { status: 404 })
          : new Response(object.body.slice(), {
            headers: {
              etag: object.etag,
              "content-length": String(object.body.byteLength),
              ...(object.contentType === undefined ? {} : { "content-type": object.contentType }),
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
  return {
    port: listening.promise,
    get conditionalRequests() {
      return conditionalRequests;
    },
    close: async () => {
      abort.abort();
      await server.finished;
    },
  };
}

function s3Config(endpoint: string) {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "root-bucket",
    accessKeyId: "ownership-access",
    secretAccessKey: "ownership-secret",
    pathStyle: true,
  };
}

function s3Environment(endpoint: string): Record<string, string> {
  return {
    MINIBASE_STORAGE_DRIVER: "s3",
    MINIBASE_S3_ENDPOINT: endpoint,
    MINIBASE_S3_REGION: "us-east-1",
    MINIBASE_S3_BUCKET: "root-bucket",
    MINIBASE_S3_ACCESS_KEY_ID: "ownership-access",
    MINIBASE_S3_SECRET_ACCESS_KEY: "ownership-secret",
    MINIBASE_S3_PATH_STYLE: "true",
  };
}

async function serviceRoleToken(secretsFile: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return await signJwt(
    { role: "service_role", aud: "authenticated", iat: now, exp: now + 3_600 },
    activeAuthSigningKey(await loadOrCreateAuthSecrets(secretsFile)),
  );
}

async function runStorageUnlock(
  project: string,
  environment: Record<string, string>,
  force: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "storage",
      "unlock",
      "--project",
      project,
      "--json",
      ...(force ? ["--force"] : []),
    ],
    cwd: project,
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

async function waitForRuntime(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await Deno.readTextFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function stopIfRunning(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  try {
    const state = await readRuntimeState(config.project);
    if (state !== null) await stopProject(config, true);
  } catch {
    // Preserve the original test failure while best-effort cleanup continues.
  }
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile) await Deno.copyFile(sourcePath, destinationPath);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
