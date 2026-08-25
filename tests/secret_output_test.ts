import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { signJwt } from "../src/auth/jwt.ts";

Deno.test("CLI, server and backend failures do not log database, Auth or S3 credentials", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-secret-output-test-" });
  const databaseRoot = await Deno.makeTempDir({
    prefix: "minibase-database-secret-output-test-",
  });
  const authSecret = "auth-signing-secret-never-appear-in-output-7Xq4mN2v";
  const s3AccessKey = "s3-access-never-appear-in-output";
  const s3SecretKey = "s3-secret-never-appear-in-output-8dF5hJ1k";
  const s3SessionToken = "s3-session-never-appear-in-output-9cR6tY3a";
  const databasePassword = "database-password-never-appear-in-output";
  const authEmail = "auth-log-secret-never-appear@example.test";
  const authPassword = "auth-password-never-appear-in-output";
  const databaseUrl = `postgres://minibase:${databasePassword}@127.0.0.1:1/minibase`;
  const backendBody = [authSecret, s3AccessKey, s3SecretKey, s3SessionToken].join(" ");
  let ownershipBody: Uint8Array | null = null;
  let ownershipEtag: string | null = null;
  let ownershipRevision = 0;
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
      const url = new URL(request.url);
      const key = decodeURIComponent(
        url.pathname.replace(/^\/secret-output-test\/?/u, ""),
      );
      if (key !== ".minibase/ownership-v1.json") {
        return new Response(backendBody, { status: 503 });
      }
      if (request.method === "GET") {
        return ownershipBody === null || ownershipEtag === null
          ? new Response("missing", { status: 404 })
          : new Response(ownershipBody.slice(), {
            headers: { etag: ownershipEtag },
          });
      }
      if (request.method === "PUT") {
        const ifNoneMatch = request.headers.get("if-none-match");
        const ifMatch = request.headers.get("if-match");
        if (ifNoneMatch === "*" && ownershipBody !== null) {
          return new Response("precondition failed", { status: 412 });
        }
        if (ifMatch !== null && ifMatch !== ownershipEtag) {
          return new Response("precondition failed", { status: 412 });
        }
        ownershipBody = new Uint8Array(await request.arrayBuffer());
        ownershipEtag = `"ownership-${++ownershipRevision}"`;
        return new Response(null, { status: 200, headers: { etag: ownershipEtag } });
      }
      return new Response("unsupported", { status: 405 });
    },
  );
  let server: Deno.ChildProcess | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), databaseRoot);
    const externalSecretFile = join(root, "external-secrets.env");
    await Deno.writeTextFile(
      externalSecretFile,
      [
        `MINIBASE_AUTH_JWT_SECRET=${authSecret}`,
        `MINIBASE_S3_ACCESS_KEY_ID=${s3AccessKey}`,
        `MINIBASE_S3_SECRET_ACCESS_KEY=${s3SecretKey}`,
        `MINIBASE_S3_SESSION_TOKEN=${s3SessionToken}`,
      ].join("\n") + "\n",
    );

    const apiPort = availablePort();
    const s3Environment = {
      MINIBASE_STORAGE_DRIVER: "s3",
      MINIBASE_SECRETS_FILE: externalSecretFile,
      MINIBASE_S3_ENDPOINT: `http://127.0.0.1:${await s3Listening.promise}`,
      MINIBASE_S3_REGION: "test-region-1",
      MINIBASE_S3_BUCKET: "secret-output-test",
    };
    server = startCliServer(root, apiPort, s3Environment);
    const stdout = new Response(server.stdout).text();
    const stderr = new Response(server.stderr).text();
    const apiUrl = await waitForApi(join(root, ".minibase", "runtime.json"));
    const notReady = await fetch(new URL("/health/ready", apiUrl));
    assertEquals(notReady.status, 503);
    const readiness = await notReady.json();
    assertEquals(readiness.checks.storage, { ready: false, driver: "s3" });
    const status = await runCliProcess(
      ["status", "--project", root, "--json"],
      root,
      s3Environment,
    );
    assertEquals(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      runtime?: { live?: unknown; ready?: unknown };
    };
    assertEquals(statusBody.runtime?.live, true);
    assertEquals(statusBody.runtime?.ready, false);
    const blockedBackup = await runCliProcess(
      ["backup", "export", "--project", root, "--json"],
      root,
      s3Environment,
    );
    assertEquals(blockedBackup.code, 1);
    assert(blockedBackup.stderr.includes("Stop Minibase before exporting"));
    const now = Math.floor(Date.now() / 1_000);
    const serviceRoleToken = await signJwt(
      { role: "service_role", iat: now, exp: now + 60 },
      authSecret,
    );
    const client = createClient(apiUrl, serviceRoleToken, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const anonToken = await signJwt(
      { role: "anon", iat: now, exp: now + 60 },
      authSecret,
    );
    const authClient = createClient(apiUrl, anonToken, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assertEquals(
      (await authClient.auth.signUp({ email: authEmail, password: authPassword })).error,
      null,
    );
    assertEquals((await client.storage.createBucket("logs")).error, null);
    const upload = await client.storage.from("logs").upload(
      "backend-error.txt",
      new Blob(["body"]),
    );
    assert(upload.error !== null);
    for (const secret of [authSecret, s3AccessKey, s3SecretKey, s3SessionToken, backendBody]) {
      assertEquals(upload.error.message.includes(secret), false, secret);
    }
    assertEquals(await fileExists(join(root, ".minibase", "secrets.json")), false);
    const externalKeyCommands = await Promise.all([
      ["auth", "keys", "list", "--project", root, "--json"],
      ["auth", "keys", "rotate", "--project", root, "--json"],
      ["auth", "keys", "activate", "--kid", "external", "--project", root, "--json"],
      [
        "auth",
        "keys",
        "remove",
        "--kid",
        "external",
        "--project",
        root,
        "--force",
        "--json",
      ],
    ].map((args) => runCliProcess(args, root, s3Environment)));
    for (const command of externalKeyCommands) {
      assertEquals(command.code, 1);
      assert(command.stderr.includes("externally managed"));
      assertEquals(command.stderr.includes(authSecret), false);
    }

    const runtimeContents = await Deno.readTextFile(join(root, ".minibase", "runtime.json"));
    const stopped = await runCliProcess(
      ["stop", "--project", root, "--json"],
      root,
      s3Environment,
    );
    assertEquals(stopped.code, 0, stopped.stderr);
    assertEquals((await server.status).success, true);
    server = null;
    const runtimeLog = await Deno.readTextFile(
      join(root, ".minibase", "logs", "minibase.jsonl"),
    );
    const runtimeRecords = runtimeLog.trim().split(/\r?\n/u).map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );
    for (const module of ["auth", "storage"]) {
      const request = runtimeRecords.find((record) =>
        record.module === module && record.event === "http_request"
      );
      assert(request !== undefined);
      assertEquals(typeof request.requestId, "string");
      assertEquals(typeof request.durationMs, "number");
    }
    const serverOutput =
      `${await stdout}\n${await stderr}\n${runtimeContents}\n${status.stdout}\n${status.stderr}\n${blockedBackup.stdout}\n${blockedBackup.stderr}\n${
        externalKeyCommands.map((command) => `${command.stdout}\n${command.stderr}`).join("\n")
      }\n${stopped.stdout}\n${stopped.stderr}\n${await readTextTree(
        join(root, ".minibase", "logs"),
      )}`;
    for (
      const secret of [
        authSecret,
        authEmail,
        authPassword,
        s3AccessKey,
        s3SecretKey,
        s3SessionToken,
        backendBody,
      ]
    ) {
      assertEquals(serverOutput.includes(secret), false, secret);
    }

    const databaseSecretFile = join(databaseRoot, "external-secrets.env");
    await Deno.writeTextFile(
      databaseSecretFile,
      `MINIBASE_DATABASE_URL=${databaseUrl}\n`,
    );
    const databaseFailure = await runCliProcess(
      ["start", "--project", databaseRoot, "--engine", "postgres", "--json"],
      databaseRoot,
      {
        MINIBASE_DATABASE_MANAGED: "false",
        MINIBASE_SECRETS_FILE: databaseSecretFile,
      },
    );
    assertEquals(databaseFailure.code, 1);
    const databaseOutput = `${databaseFailure.stdout}\n${databaseFailure.stderr}`;
    assertEquals(databaseOutput.includes(databasePassword), false);
    assertEquals(databaseOutput.includes(databaseUrl), false);
  } finally {
    if (server !== null) {
      try {
        server.kill("SIGTERM");
      } catch {
        // The server may already have stopped.
      }
      await server.status.catch(() => undefined);
    }
    s3Abort.abort();
    await s3Server.finished;
    await Deno.remove(root, { recursive: true });
    await Deno.remove(databaseRoot, { recursive: true });
  }
});

function startCliServer(
  project: string,
  port: number,
  environment: Record<string, string>,
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      project,
      "--port",
      String(port),
      "--json",
    ],
    cwd: project,
    env: environment,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function runCliProcess(
  args: string[],
  cwd: string,
  environment: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd,
    env: environment,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function waitForApi(runtimePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const runtime = JSON.parse(await Deno.readTextFile(runtimePath)) as { apiUrl?: unknown };
      if (typeof runtime.apiUrl === "string") {
        const response = await fetch(new URL("/health/live", runtime.apiUrl));
        if (response.ok) return runtime.apiUrl;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && !(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Minibase API");
}

async function readTextTree(path: string): Promise<string> {
  const values: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) values.push(await readTextTree(child));
      else if (entry.isFile) values.push(await Deno.readTextFile(child));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return values.join("\n");
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
