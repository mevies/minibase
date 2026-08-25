import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";

const ALLOWED_ORIGIN = "https://client.example";

Deno.test("remote Function requests enforce IP, function and authenticated identity limits", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-rate-limit-test-" });
  const port = availablePort();
  const project = await createProject(root);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      root,
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

    assertEquals((await invoke(runtime.apiUrl, "by-ip", "198.51.100.1")).status, 200);
    assertEquals((await invoke(runtime.apiUrl, "by-ip", "198.51.100.1")).status, 200);
    await assertRateLimited(
      await invoke(runtime.apiUrl, "by-ip", "198.51.100.1"),
      "ip",
    );
    assertEquals((await invoke(runtime.apiUrl, "by-ip", "198.51.100.2")).status, 200);

    assertEquals((await invoke(runtime.apiUrl, "aggregate", "203.0.113.1")).status, 200);
    assertEquals((await invoke(runtime.apiUrl, "aggregate", "203.0.113.2")).status, 200);
    await assertRateLimited(
      await invoke(runtime.apiUrl, "aggregate", "203.0.113.3"),
      "function",
    );

    const firstToken = await signup(runtime.apiUrl, "rate-limit-first@example.com");
    assertEquals(
      (await invoke(runtime.apiUrl, "by-identity", "192.0.2.1", firstToken)).status,
      200,
    );
    assertEquals(
      (await invoke(runtime.apiUrl, "by-identity", "192.0.2.2", firstToken)).status,
      200,
    );
    await assertRateLimited(
      await invoke(runtime.apiUrl, "by-identity", "192.0.2.3", firstToken),
      "identity",
    );
    const secondToken = await signup(runtime.apiUrl, "rate-limit-second@example.com");
    assertEquals(
      (await invoke(runtime.apiUrl, "by-identity", "192.0.2.3", secondToken)).status,
      200,
    );

    const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
      method: "POST",
      headers: { "x-minibase-control-token": runtime.controlToken },
    });
    assertEquals(stopped.status, 202);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
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

async function createProject(root: string) {
  const functionsDir = join(root, "supabase", "functions");
  await Deno.mkdir(join(root, "supabase", "migrations"), { recursive: true });
  for (const name of ["by-ip", "aggregate", "by-identity"]) {
    const directory = join(functionsDir, name);
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(
      join(directory, "index.ts"),
      `Deno.serve(() => Response.json({ function: ${JSON.stringify(name)} }));\n`,
    );
  }
  await Deno.writeTextFile(
    join(root, "supabase", "config.toml"),
    'project_id = "rate-limit"\n',
  );
  await Deno.writeTextFile(
    join(root, "minibase.toml"),
    `format_version = 1
[server]
trusted_proxies = ["127.0.0.1"]
[server.cors]
allowed_origins = ["${ALLOWED_ORIGIN}"]
[functions.rate_limit]
window_ms = 60000
max_keys = 1000
[functions.by-ip]
verify_jwt = false
[functions.by-ip.rate_limit]
per_ip = 2
[functions.aggregate]
verify_jwt = false
[functions.aggregate.rate_limit]
per_function = 2
[functions.by-identity]
verify_jwt = true
[functions.by-identity.rate_limit]
per_identity = 2
`,
  );
  return await discoverProject(root);
}

async function invoke(
  baseUrl: string,
  name: string,
  clientIp: string,
  token?: string,
): Promise<Response> {
  return await fetch(`${baseUrl}/functions/v1/${name}`, {
    headers: {
      origin: ALLOWED_ORIGIN,
      "x-forwarded-for": clientIp,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

async function assertRateLimited(response: Response, scope: string): Promise<void> {
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assert(response.headers.has("x-request-id"));
  assert(Number(response.headers.get("retry-after")) >= 1);
  assertEquals(response.headers.get("x-ratelimit-limit"), "2");
  assertEquals(response.headers.get("x-ratelimit-remaining"), "0");
  assert(Number(response.headers.get("x-ratelimit-reset")) > 0);
  assertEquals(await response.json(), {
    code: "function_rate_limit_exceeded",
    message: `Function ${scope} rate limit exceeded`,
    scope,
  });
}

async function signup(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery staple" }),
  });
  if (!response.ok) {
    throw new Error(`Signup failed with ${response.status}: ${await response.text()}`);
  }
  const session = await response.json() as { access_token?: string };
  assert(session.access_token !== undefined);
  return session.access_token;
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
  throw new Error("Timed out waiting for Function rate-limit server");
}
