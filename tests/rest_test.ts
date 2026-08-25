import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations, applySeed } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";

const aliceId = "11111111-1111-4111-8111-111111111111";

Deno.test("REST select and insert use PostgreSQL RLS context", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-rest-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await applySeed(engine, project);
    const handler = createAppHandler({
      config,
      engine,
      resolveRequestContext: () => ({
        role: "authenticated",
        claims: { sub: aliceId, role: "authenticated" },
      }),
    });

    const list = await handler(
      new Request("http://localhost/rest/v1/notes?select=id,body&order=id.asc"),
    );
    assertEquals(list.status, 200);
    assertEquals(await list.json(), [{ id: 1, body: "Alice note" }]);

    const insert = await handler(
      new Request("http://localhost/rest/v1/notes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "prefer": "return=representation",
        },
        body: JSON.stringify({ owner_id: aliceId, body: "Second Alice note" }),
      }),
    );
    assertEquals(insert.status, 201);
    const inserted = await insert.json();
    assertEquals(inserted[0]?.body, "Second Alice note");

    const filtered = await handler(
      new Request("http://localhost/rest/v1/notes?select=body&body=eq.Second%20Alice%20note"),
    );
    assertEquals(filtered.status, 200);
    assertEquals(await filtered.json(), [{ body: "Second Alice note" }]);

    const malformed = await handler(
      new Request("http://localhost/rest/v1/notes?select=id&bad%22column=eq.1"),
    );
    assertEquals(malformed.status, 400);
    assertEquals((await malformed.json()).code, "PGRST100");

    const missingRelation = await handler(
      new Request("http://localhost/rest/v1/notes?select=id,owner:missing(display_name)"),
    );
    assertEquals(missingRelation.status, 400);
    assertEquals((await missingRelation.json()).code, "PGRST200");
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
