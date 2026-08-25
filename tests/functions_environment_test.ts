import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { loadFunctionEnvironment } from "../src/functions/environment.ts";
import { type FunctionApiKeyMode, FunctionManager } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("Function environments isolate host variables and inject compatible secrets", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-environment-test-" });
  let manager: FunctionManager | null = null;
  try {
    const functionsDir = join(root, "supabase", "functions");
    const forbiddenPath = join(root, ".minibase", "secrets.json");
    await Deno.mkdir(join(root, ".minibase"), { recursive: true });
    await Deno.writeTextFile(forbiddenPath, '{"private":"must-not-be-readable"}\n');
    for (const name of ["environment", "restricted"]) {
      const directory = join(functionsDir, name);
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(join(directory, "index.ts"), FUNCTION_SOURCE);
    }
    const hostEnvironment = Deno.env.toObject();
    const hostOnlyName = "MINIBASE_TEST_HOST_LEAK_SENTINEL";
    hostEnvironment[hostOnlyName] = "must-not-leak";
    await Deno.writeTextFile(
      join(root, ".env"),
      `ROOT_SECRET="root-secret-value\\nsecond-line"
PRECEDENCE=root
SUPABASE_URL=http://must-not-override.invalid
SUPABASE_PUBLISHABLE_KEY=must-not-override
SUPABASE_JWKS={"keys":[{"d":"must-not-override"}]}
SUPABASE_JWKS_URL=https://must-not-override.invalid/.well-known/jwks.json
MINIBASE_FUNCTION_PORT=1
PROBE_HOST_KEY=${hostOnlyName}
PROBE_FORBIDDEN_PATH=${forbiddenPath}
`,
    );
    await Deno.writeTextFile(
      join(functionsDir, ".env"),
      "FUNCTION_SECRET='function-secret-value'\nPRECEDENCE=functions\n",
    );
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      `format_version = 1
[server]
public_url = "http://127.0.0.1:54321"
[functions.restricted]
inject_service_role_key = false
`,
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    const loaded = await loadFunctionEnvironment(project, hostEnvironment);
    assertEquals(loaded.files, [join(root, ".env"), join(functionsDir, ".env")]);
    assertEquals(loaded.ignoredReserved, [
      "MINIBASE_FUNCTION_PORT",
      "SUPABASE_JWKS",
      "SUPABASE_JWKS_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_URL",
    ]);
    assertEquals(loaded.values.ROOT_SECRET, "root-secret-value\nsecond-line");
    assertEquals(loaded.values.PRECEDENCE, "functions");
    assertEquals(loaded.values[hostOnlyName], undefined);

    const logs: string[] = [];
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey: "anon-environment-test",
        serviceRoleKey: "service-environment-test",
        jwks: '{"keys":[{"kty":"EC","kid":"public-test"}]}',
      },
      environment: loaded.values,
      secretValues: loaded.secretValues,
      log: (_stream, line) => logs.push(line),
    });
    await manager.prepare();

    const normal = await invoke(manager, "environment");
    assertEquals(normal, {
      supabaseUrl: config.server.publicUrl,
      anonKey: "anon-environment-test",
      publishableKey: "anon-environment-test",
      publishableKeys: { default: "anon-environment-test" },
      serviceRoleKey: "service-environment-test",
      secretKey: "service-environment-test",
      secretKeys: { default: "service-environment-test" },
      jwks: { keys: [{ kty: "EC", kid: "public-test" }] },
      jwksUrl: null,
      apiKeyHeader: null,
      rootSecret: "root-secret-value\nsecond-line",
      functionSecret: "function-secret-value",
      precedence: "functions",
      hostLeak: null,
      forbiddenReadError: "NotCapable",
    });
    const restricted = await invoke(manager, "restricted", "secret");
    assertEquals(restricted.serviceRoleKey, null);
    assertEquals(restricted.secretKey, null);
    assertEquals(restricted.secretKeys, null);
    assertEquals(restricted.apiKeyHeader, "anon-environment-test");

    const failure = await manager.invoke(
      "environment",
      new Request("http://localhost/functions/v1/environment?log=1"),
    );
    assertEquals(failure.status, 500);
    await failure.body?.cancel();
    await waitFor(() => logs.some((line) => line.includes("[REDACTED]")));
    const combined = logs.join("\n");
    assertEquals(combined.includes("root-secret-value"), false);
    assertEquals(combined.includes("function-secret-value"), false);
  } finally {
    await manager?.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function invoke(
  manager: FunctionManager,
  name: string,
  apiKeyMode?: FunctionApiKeyMode,
): Promise<Record<string, unknown>> {
  const response = await manager.invoke(
    name,
    new Request(`http://localhost/functions/v1/${name}`),
    apiKeyMode,
  );
  assertEquals(response.status, 200);
  return await response.json();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for redacted Function environment logs");
}

const FUNCTION_SOURCE = `
Deno.serve(async (request) => {
  const rootSecret = Deno.env.get("ROOT_SECRET") ?? null;
  const functionSecret = Deno.env.get("FUNCTION_SECRET") ?? null;
  if (new URL(request.url).searchParams.has("log")) {
    console.log("root:" + rootSecret);
    console.error("function:" + functionSecret);
    throw new Error("environment:" + rootSecret + ":" + functionSecret);
  }
  const hostKey = Deno.env.get("PROBE_HOST_KEY") ?? "";
  let forbiddenReadError = null;
  try {
    await Deno.readTextFile(Deno.env.get("PROBE_FORBIDDEN_PATH") ?? "");
  } catch (error) {
    forbiddenReadError = error instanceof Error ? error.name : "unknown";
  }
  return Response.json({
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? null,
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? null,
    publishableKey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? null,
    publishableKeys: JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "null"),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null,
    secretKey: Deno.env.get("SUPABASE_SECRET_KEY") ?? null,
    secretKeys: JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "null"),
    jwks: JSON.parse(Deno.env.get("SUPABASE_JWKS") ?? "null"),
    jwksUrl: Deno.env.get("SUPABASE_JWKS_URL") ?? null,
    apiKeyHeader: request.headers.get("apikey"),
    rootSecret,
    functionSecret,
    precedence: Deno.env.get("PRECEDENCE") ?? null,
    hostLeak: Deno.env.get(hostKey) ?? null,
    forbiddenReadError,
  });
});
`;
