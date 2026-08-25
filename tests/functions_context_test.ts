import { join } from "@std/path";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import { assertSupabaseServerContextContract } from "./helpers/supabase_server_context.ts";

Deno.test("real @supabase/server Context uses Minibase Auth, RLS, Storage and Functions", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-functions-context-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await assertSupabaseServerContextContract({
      config,
      engine,
      objectStore: new LocalObjectStore(config.storage.path),
      authSecrets: await loadOrCreateAuthSecrets(join(temp, "auth-secrets.json")),
      prefix: "embedded",
    });
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
