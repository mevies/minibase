import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { createFunctionsHandler } from "../src/functions/handler.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };

Deno.test("Deno.serve function is loaded unchanged and reused", async () => {
  const functionInput = compatibility.inputs.functions.find((input) => input.name === "echo");
  assert(functionInput);
  const temp = await Deno.makeTempDir({ prefix: "minibase-functions-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  let manager: FunctionManager | null = null;
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const anonKey = await auth.createRoleToken("anon");
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey,
        serviceRoleKey: await auth.createRoleToken("service_role"),
      },
    });
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      functionManager: manager,
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
    });

    for (const value of ["first", "second"]) {
      const response = await handler(
        new Request(`http://localhost${functionInput.route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${anonKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value }),
        }),
      );
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.body, { value });
      assertEquals(body.supabaseUrl, config.server.publicUrl);
    }
  } finally {
    await manager?.close();
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Supabase CLI Function config loads a default fetch export unchanged", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-cli-template-test-" });
  const databaseTemp = await Deno.makeTempDir({ prefix: "minibase-functions-cli-database-" });
  let manager: FunctionManager | null = null;
  let engine: PGliteEngine | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const functionDir = join(root, "supabase", "functions", "cli-generated");
    await Deno.mkdir(functionDir, { recursive: true });
    await Deno.copyFile(
      join(
        Deno.cwd(),
        "fixtures",
        "supabase-cli-2.110.0-function",
        "supabase",
        "functions",
        "compatibility-probe",
        "index.ts",
      ),
      join(functionDir, "main.ts"),
    );
    await Deno.writeTextFile(
      join(functionDir, "deno.json"),
      JSON.stringify(
        {
          imports: {
            "@supabase/functions-js/edge-runtime.d.ts": "./edge-runtime.ts",
            "@supabase/server": "./supabase-server.ts",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await Deno.writeTextFile(join(functionDir, "edge-runtime.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(functionDir, "supabase-server.ts"),
      `export function withSupabase(
  _config: unknown,
  handler: (request: Request, context: Record<string, unknown>) => Promise<Response>,
) {
  return async (request: Request) => {
    const apiKey = request.headers.get("apikey");
    const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const secret = Deno.env.get("SUPABASE_SECRET_KEY");
    const authMode = apiKey === publishable ? "publishable" : apiKey === secret ? "secret" : null;
    if (authMode === null) return Response.json({ message: "Invalid API key" }, { status: 401 });
    return await handler(request, {
      authMode,
      supabaseUrl: Deno.env.get("SUPABASE_URL"),
      publishableKeys: JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "null"),
      secretKeys: JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "null"),
    });
  };
}
`,
    );
    const classicDir = join(root, "supabase", "functions", "classic-map");
    await Deno.mkdir(classicDir, { recursive: true });
    await Deno.writeTextFile(
      join(classicDir, "deno.json"),
      '{"compilerOptions":{"strict":true}}\n',
    );
    await Deno.writeTextFile(
      join(classicDir, "import_map.json"),
      '{"imports":{"classic-message":"./message.ts"}}\n',
    );
    await Deno.writeTextFile(
      join(classicDir, "message.ts"),
      'export const message = "classic import map";\n',
    );
    await Deno.writeTextFile(
      join(classicDir, "main.ts"),
      `import { message } from "classic-message";
export default () => Response.json({ message });
`,
    );
    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "minibase-compat-basic"
[api]
port = 54321
[functions.cli-generated]
verify_jwt = true
import_map = "./functions/cli-generated/deno.json"
entrypoint = "./functions/cli-generated/main.ts"
[functions.classic-map]
verify_jwt = false
import_map = "./functions/classic-map/import_map.json"
entrypoint = "./functions/classic-map/main.ts"
`,
    );

    const project = await discoverProject(root);
    const config = await loadConfig(project, { storagePath: join(databaseTemp, "storage") }, {});
    engine = new PGliteEngine(join(databaseTemp, "pglite"));
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, {
      jwtSecret: "cli-template-test-secret-with-at-least-32-characters",
    });
    const anonKey = await auth.createRoleToken("anon");
    const serviceRoleKey = await auth.createRoleToken("service_role");
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey,
        serviceRoleKey,
      },
    });
    const cached = await manager.prepare();
    assertEquals(
      cached.find((entry) => entry.name === "cli-generated")?.entryPath,
      join(
        functionDir,
        "main.ts",
      ),
    );
    assertEquals(
      cached.find((entry) => entry.name === "classic-map")?.entryPath,
      join(classicDir, "main.ts"),
    );
    const classic = await manager.invoke(
      "classic-map",
      new Request("http://localhost/functions/v1/classic-map"),
    );
    assertEquals(classic.status, 200, await classic.clone().text());
    assertEquals(await classic.json(), { message: "classic import map" });
    const handler = createFunctionsHandler(manager, auth, config);
    const response = await handler(
      new Request("http://localhost/functions/v1/cli-generated", {
        method: "POST",
        headers: {
          apikey: "minibase-local-client-id",
          authorization: `Bearer ${anonKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Functions" }),
      }),
    );
    assert(response !== null);
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(await response.json(), { message: "Hello Functions!" });

    await Deno.writeTextFile(
      join(functionDir, "supabase-server-v2.ts"),
      `export function withSupabase(
  _config: unknown,
  handler: (request: Request, context: Record<string, unknown>) => Promise<Response>,
) {
  return async (request: Request) => {
    const apiKey = request.headers.get("apikey");
    const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const secret = Deno.env.get("SUPABASE_SECRET_KEY");
    if (apiKey !== publishable && apiKey !== secret) {
      return Response.json({ message: "Invalid API key" }, { status: 401 });
    }
    const response = await handler(request, { supabaseUrl: Deno.env.get("SUPABASE_URL") });
    const headers = new Headers(response.headers);
    headers.set("x-contract-generation", "2");
    return new Response(response.body, { status: response.status, headers });
  };
}
`,
    );
    await Deno.writeTextFile(
      join(functionDir, "deno.json"),
      JSON.stringify(
        {
          imports: {
            "@supabase/functions-js/edge-runtime.d.ts": "./edge-runtime.ts",
            "@supabase/server": "./supabase-server-v2.ts",
          },
        },
        null,
        2,
      ) + "\n",
    );
    const reloaded = await handler(
      new Request("http://localhost/functions/v1/cli-generated", {
        method: "POST",
        headers: {
          apikey: "minibase-local-service-client-id",
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Reloaded" }),
      }),
    );
    assert(reloaded !== null);
    assertEquals(reloaded.status, 200, await reloaded.clone().text());
    assertEquals(reloaded.headers.get("x-contract-generation"), "2");
    assertEquals(await reloaded.json(), { message: "Hello Reloaded!" });
  } finally {
    await manager?.close();
    await engine?.close();
    await Deno.remove(root, { recursive: true });
    await Deno.remove(databaseTemp, { recursive: true });
  }
});

Deno.test("Edge Function fetches and streams an OpenAI-compatible response", async () => {
  const functionInput = compatibility.inputs.functions.find(
    (input) => input.name === "fetch-openai",
  );
  assert(functionInput);
  const temp = await Deno.makeTempDir({ prefix: "minibase-functions-fetch-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  const mockAbort = new AbortController();
  let manager: FunctionManager | null = null;
  const listening = Promise.withResolvers<number>();
  const mock = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: mockAbort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    (request) => {
      assertEquals(request.headers.get("authorization"), "Bearer test-openai-key");
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"delta":"hello"}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  );

  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const anonKey = await auth.createRoleToken("anon");
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey,
        serviceRoleKey: await auth.createRoleToken("service_role"),
      },
      environment: {
        OPENAI_BASE_URL: `http://127.0.0.1:${await listening.promise}`,
        OPENAI_API_KEY: "test-openai-key",
      },
    });
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      functionManager: manager,
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
    });
    const response = await handler(
      new Request(`http://localhost${functionInput.route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${anonKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test", stream: true }),
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");
    const body = await response.text();
    assertStringIncludes(body, '"delta":"hello"');
    assertStringIncludes(body, "[DONE]");
  } finally {
    await manager?.close();
    mockAbort.abort();
    await mock.finished;
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

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
