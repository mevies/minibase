import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import type { DatabaseEngine } from "../src/database/contract.ts";
import type { FunctionManager } from "../src/functions/manager.ts";
import type { AuthService } from "../src/auth/service.ts";
import { createFunctionOpenApiDocument } from "../src/functions/docs.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";

Deno.test("function docs expose OpenAPI JSON and an offline request console", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-function-docs-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const publicDir = join(root, "supabase", "functions", "public-api");
    await Deno.mkdir(publicDir, { recursive: true });
    await Deno.writeTextFile(
      join(publicDir, "index.ts"),
      `Deno.serve((request) => {
  if (request.method === "GET") return Response.json({ ok: true });
  return Response.json({ secret: "must-not-appear" });
});
`,
    );
    await Deno.mkdir(join(root, "supabase", "functions", "_shared"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "supabase", "functions", "_shared", "index.ts"),
      "export const shared = true;\n",
    );
    await Deno.mkdir(join(root, "supabase", "functions", "not valid"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "supabase", "functions", "not valid", "index.ts"),
      "export default () => Response.json({ invalid: true });\n",
    );
    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "docs-fixture"

[api]
port = 54321

[functions.echo]
verify_jwt = true

[functions.public-api]
verify_jwt = false

[functions.docs]
verify_jwt = true

[functions.missing]
verify_jwt = false
entrypoint = "./functions/missing/index.ts"
`,
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, { storagePath: join(root, "storage") }, {});
    const engine = {} as DatabaseEngine;
    const manager = {
      invoke: () => Promise.resolve(Response.json({ code: "wrong-route" }, { status: 418 })),
    } as unknown as FunctionManager;
    const auth = {
      resolveRequestContext: () => Promise.reject(new Error("wrong-route")),
    } as unknown as AuthService;
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      functionManager: manager,
    });

    const html = await handler(new Request("http://localhost/functions/v1/docs")).then(
      async (r) => {
        assertEquals(r.status, 200);
        assertEquals(r.headers.get("content-type"), "text/html; charset=utf-8");
        return await r.text();
      },
    );
    assertStringIncludes(html, "/functions/v1/docs/openapi.json");
    assertStringIncludes(html, "Try it");
    assertStringIncludes(html, 'response.statusText + "\\n\\n"');

    const response = await handler(new Request("http://localhost/functions/v1/docs/openapi.json"));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
    const document = await response.json();
    assertEquals(document.openapi, "3.0.3");
    assert(document.paths["/functions/v1/echo"].post.security[0].bearerAuth);
    assertEquals(document.paths["/functions/v1/public-api"].get.security, []);
    assertEquals(document.paths["/functions/v1/public-api"].post, undefined);
    assertStringIncludes(document.paths["/functions/v1/public-api"].get.description, "public-api");
    assertEquals(JSON.stringify(document).includes("must-not-appear"), false);

    const direct = await createFunctionOpenApiDocument(
      config,
      new Request("http://127.0.0.1:54321/functions/v1/docs/openapi.json"),
    );
    assertEquals(Object.keys(direct.paths), [
      "/functions/v1/echo",
      "/functions/v1/fetch-openai",
      "/functions/v1/public-api",
    ]);
    assertEquals(direct.paths["/functions/v1/docs"], undefined);
    assertEquals(direct.paths["/functions/v1/missing"], undefined);
    assertEquals(direct.paths["/functions/v1/_shared"], undefined);
    const methodNotAllowed = await handler(
      new Request("http://localhost/functions/v1/docs", { method: "POST" }),
    );
    assertEquals(methodNotAllowed.status, 405);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}
