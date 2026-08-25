import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";

const remoteClient = fromFileUrl(
  new URL("./fixtures/functions_remote_client.ts", import.meta.url),
);

Deno.test("remote process calls public and authenticated Edge Functions with proxy and CORS headers", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-remote-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
  const port = availablePort();
  const publicUrl = `https://minibase.example.test:${port}`;
  const allowedOrigin = "https://client.example";
  const deniedOrigin = "https://denied.example";
  const functionDir = join(root, "supabase", "functions", "remote");
  await Deno.mkdir(functionDir, { recursive: true });
  await Deno.writeTextFile(
    join(functionDir, "index.ts"),
    `Deno.serve(async (request) => Response.json({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      remoteHeader: request.headers.get("x-remote-client"),
      forwarded: request.headers.get("forwarded"),
      forwardedFor: request.headers.get("x-forwarded-for"),
      forwardedHost: request.headers.get("x-forwarded-host"),
      forwardedPort: request.headers.get("x-forwarded-port"),
      forwardedProto: request.headers.get("x-forwarded-proto"),
      body: await request.json(),
      supabaseUrl: Deno.env.get("SUPABASE_URL"),
      anonKeyPresent: (Deno.env.get("SUPABASE_ANON_KEY")?.length ?? 0) > 0,
      serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null,
      customSecret: Deno.env.get("REMOTE_FUNCTION_SECRET"),
    }));\n`,
  );
  const protectedDir = join(root, "supabase", "functions", "protected");
  await Deno.mkdir(protectedDir, { recursive: true });
  await Deno.writeTextFile(
    join(protectedDir, "index.ts"),
    `Deno.serve(async (request) => Response.json({
      bearer: request.headers.get("authorization")?.startsWith("Bearer ") ?? false,
      contentType: request.headers.get("content-type"),
      customHeader: request.headers.get("x-remote-client"),
      body: await request.json(),
    }));\n`,
  );
  await Deno.writeTextFile(
    join(root, ".env"),
    "REMOTE_FUNCTION_SECRET=remote-function-secret-value\n",
  );
  await Deno.writeTextFile(
    join(root, "minibase.toml"),
    `format_version = 1
[server]
public_url = "${publicUrl}"
trusted_proxies = ["127.0.0.1"]
[server.cors]
allowed_origins = ["${allowedOrigin}"]
[functions.remote]
verify_jwt = false
inject_service_role_key = false
[functions.protected]
verify_jwt = true
`,
  );
  const project = await discoverProject(root);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      root,
      "--host",
      "0.0.0.0",
      "--port",
      String(port),
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  try {
    await waitForRuntime(project.runtimeFile);
    const runtime = await readRuntimeState(project);
    assert(runtime);
    assertEquals(runtime.apiUrl, publicUrl);

    const client = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        remoteClient,
        `http://127.0.0.1:${port}`,
        allowedOrigin,
        deniedOrigin,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(client.code, 0, new TextDecoder().decode(client.stderr));
    const result = JSON.parse(new TextDecoder().decode(client.stdout)) as RemoteResult;
    assertEquals(result.preflight.status, 204);
    assertEquals(result.preflight.origin, allowedOrigin);
    assertStringIncludes(result.preflight.methods ?? "", "PATCH");
    assertEquals(result.preflight.headers, "content-type, x-remote-client");
    assertStringIncludes(result.preflight.vary ?? "", "Origin");
    assertEquals(result.allowed.status, 200, JSON.stringify(result.allowed.body));
    assertEquals(result.allowed.origin, allowedOrigin);
    assert(result.allowed.requestId);
    assertEquals(result.allowed.body, {
      method: "PATCH",
      path: "/functions/v1/remote/child?source=separate-process",
      remoteHeader: "independent-deno-process",
      forwarded: 'for=198.51.100.41;proto=https;host="edge.example.test:8443"',
      forwardedFor: "198.51.100.41",
      forwardedHost: "edge.example.test:8443",
      forwardedPort: "8443",
      forwardedProto: "https",
      body: { compatible: true },
      supabaseUrl: publicUrl,
      anonKeyPresent: true,
      serviceRoleKey: null,
      customSecret: "remote-function-secret-value",
    });
    assertEquals(result.deniedPreflight, { status: 403, origin: null });
    assertEquals(result.denied, {
      status: 200,
      origin: null,
      body: {
        method: "PATCH",
        path: "/functions/v1/remote/child?source=separate-process",
        remoteHeader: null,
        forwarded: 'for=203.0.113.20;proto=http;host="safe.example:8080"',
        forwardedFor: "203.0.113.20",
        forwardedHost: "safe.example:8080",
        forwardedPort: "8080",
        forwardedProto: "http",
        body: { compatible: true },
        supabaseUrl: publicUrl,
        anonKeyPresent: true,
        serviceRoleKey: null,
        customSecret: "remote-function-secret-value",
      },
    });
    assertEquals(result.malformed, {
      status: 400,
      body: {
        code: "invalid_proxy_headers",
        message: "Forwarded protocol must be http or https",
      },
    });
    assertEquals(result.protectedWithoutToken, {
      status: 401,
      body: { code: 401, message: "Missing authorization header" },
    });
    assertEquals(result.protectedWithToken, {
      status: 200,
      body: {
        bearer: true,
        contentType: "application/json",
        customHeader: "authenticated-remote-client",
        body: { protected: true },
      },
    });

    const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
      method: "POST",
      headers: { "x-minibase-control-token": runtime.controlToken },
    });
    assertEquals(stopped.status, 202);
    const output = await child.output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assertStringIncludes(
      stderr,
      '"event":"public_listen_warning"',
    );
    assertEquals(stderr.includes("remote-function-secret-value"), false);

    const logs = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(Deno.cwd(), "src", "main.ts"),
        "functions",
        "logs",
        "--project",
        root,
        "--function",
        "remote",
        "--tail",
        "2",
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(logs.code, 0, new TextDecoder().decode(logs.stderr));
    const logReport = JSON.parse(new TextDecoder().decode(logs.stdout)) as {
      path: string;
      entries: Array<Record<string, unknown>>;
    };
    assertEquals(logReport.path, join(project.logsDir, "functions.jsonl"));
    assertEquals(logReport.entries.length, 2);
    assert(logReport.entries.every((entry) => entry.function === "remote"));
    assert(logReport.entries.every((entry) => entry.status === 200));
    assert(logReport.entries.every((entry) => typeof entry.requestId === "string"));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal shutdown path already reaped the process.
    }
    await child.status.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

interface RemoteResult {
  preflight: {
    status: number;
    origin: string | null;
    methods: string | null;
    headers: string | null;
    vary: string | null;
  };
  allowed: {
    status: number;
    origin: string | null;
    requestId: string | null;
    body: Record<string, unknown>;
  };
  deniedPreflight: { status: number; origin: string | null };
  denied: { status: number; origin: string | null; body: Record<string, unknown> };
  malformed: { status: number; body: Record<string, unknown> };
  protectedWithoutToken: { status: number; body: Record<string, unknown> };
  protectedWithToken: { status: number; body: Record<string, unknown> };
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for remote Functions server");
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
    } else {
      throw new Error(`Fixture contains unsupported entry: ${basename(sourcePath)}`);
    }
  }
}
