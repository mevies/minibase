import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("Function network policies enforce wildcards, stricter overrides and self access", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-network-policy-test-" });
  const proxyAbort = new AbortController();
  const proxyListening = Promise.withResolvers<number>();
  const proxyTargets: string[] = [];
  const proxy = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: proxyAbort.signal,
      onListen: (address) => proxyListening.resolve(address.port),
    },
    (request) => {
      proxyTargets.push(request.url);
      if (request.url === "http://redirect.example.test/to-private") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      return new Response("allowed-through-proxy");
    },
  );
  const selfAbort = new AbortController();
  const selfListening = Promise.withResolvers<number>();
  const self = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: selfAbort.signal,
      onListen: (address) => selfListening.resolve(address.port),
    },
    () => new Response("self-api"),
  );
  let manager: FunctionManager | null = null;
  try {
    const functionsDir = join(root, "supabase", "functions");
    for (const name of ["policy-probe", "strict", "no-self", "hardened"]) {
      const directory = join(functionsDir, name);
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(join(directory, "index.ts"), FUNCTION_SOURCE);
    }
    const proxyPort = await proxyListening.promise;
    const selfPort = await selfListening.promise;
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      `format_version = 1
[server]
port = ${selfPort}
public_url = "http://127.0.0.1:${selfPort}"
[functions.network]
outbound = "allowlist"
allowed_hosts = ["*.example.test", "localhost:${proxyPort}", "127.0.0.1:${proxyPort}", "169.254.169.254", "metadata.google.internal", "[::1]"]
allow_supabase_url = true
[functions.strict.network]
outbound = "deny"
[functions.no-self.network]
allow_supabase_url = false
[functions.hardened.network]
block_private_networks = true
`,
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    manager = new FunctionManager({
      config,
      secrets: { anonKey: "anon-policy-test", serviceRoleKey: "service-policy-test" },
      environment: {
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "127.0.0.1",
      },
      log: () => undefined,
    });
    await manager.prepare();

    assertEquals(
      await probe(manager, "policy-probe", "http://api.example.test/allowed"),
      { ok: true, status: 200, body: "allowed-through-proxy" },
    );
    assert(proxyTargets.includes("http://api.example.test/allowed"));

    const apex = await probe(manager, "policy-probe", "http://example.test/apex");
    assertEquals(apex.ok, false);
    assertEquals(apex.name, "FunctionNetworkPolicyError");
    assertStringIncludes(String(apex.message), "project allowlist policy");

    const strict = await probe(manager, "strict", "http://api.example.test/strict");
    assertEquals(strict.ok, false);
    assertEquals(strict.name, "FunctionNetworkPolicyError");
    assertStringIncludes(String(strict.message), "function deny policy");

    assertEquals(
      await probe(manager, "policy-probe", `http://127.0.0.1:${selfPort}/health/live`),
      { ok: true, status: 200, body: "self-api" },
    );
    const noSelf = await probe(
      manager,
      "no-self",
      `http://127.0.0.1:${selfPort}/health/live`,
    );
    assertEquals(noSelf.ok, false);
    assertEquals(noSelf.name, "FunctionNetworkPolicyError");
    assertStringIncludes(String(noSelf.message), "SUPABASE_URL access is disabled");

    for (
      const target of [
        `http://localhost:${proxyPort}/private`,
        `http://127.0.0.1:${proxyPort}/private`,
        "http://169.254.169.254/latest/meta-data",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://[::1]/private",
      ]
    ) {
      const blocked = await probe(manager, "hardened", target);
      assertEquals(blocked.ok, false);
      assertEquals(blocked.name, "FunctionNetworkPolicyError");
      assertStringIncludes(String(blocked.message), "private-network SSRF policy");
    }

    const redirect = await probe(
      manager,
      "hardened",
      "http://redirect.example.test/to-private",
    );
    assertEquals(redirect.ok, false);
    assertEquals(redirect.name, "FunctionNetworkPolicyError");
    assertStringIncludes(String(redirect.message), "private-network SSRF policy");
  } finally {
    await manager?.close();
    proxyAbort.abort();
    selfAbort.abort();
    await Promise.all([proxy.finished, self.finished]);
    await Deno.remove(root, { recursive: true });
  }
});

async function probe(
  manager: FunctionManager,
  functionName: string,
  target: string,
): Promise<Record<string, unknown>> {
  const url = new URL(`http://localhost/functions/v1/${functionName}`);
  url.searchParams.set("target", target);
  const response = await manager.invoke(functionName, new Request(url));
  assertEquals(response.status, 200);
  return await response.json();
}

const FUNCTION_SOURCE = `
Deno.serve(async (request) => {
  const target = new URL(request.url).searchParams.get("target");
  if (target === null) return Response.json({ ok: false, message: "target is missing" });
  try {
    const response = await fetch(target);
    return Response.json({ ok: true, status: response.status, body: await response.text() });
  } catch (error) {
    return Response.json({
      ok: false,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
`;
