import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import { assertSupabaseRestContract } from "./helpers/supabase_rest_contract.ts";

Deno.test("official supabase-js signs up and performs RLS CRUD against Minibase", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-supabase-js-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  const abortController = new AbortController();
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, { jwtSecret: "test-secret-with-at-least-32-characters" });
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
    });
    const listening = Promise.withResolvers<number>();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: abortController.signal,
        onListen: (address) => listening.resolve(address.port),
      },
      handler,
    );
    const baseUrl = `http://127.0.0.1:${await listening.promise}`;
    const client = createClient(baseUrl, await auth.createRoleToken("anon"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const signup = await client.auth.signUp({
      email: "sdk@example.com",
      password: "correct horse battery staple",
      options: { data: { display_name: "SDK User" } },
    });
    assertEquals(signup.error, null);
    assert(signup.data.user !== null);
    assert(signup.data.session !== null);

    await assertSupabaseRestContract(
      client,
      signup.data.user.id,
      "SDK User",
      "embedded",
    );

    const updated = await client.auth.updateUser({
      email: "sdk-updated@example.com",
      password: "updated horse battery staple",
    });
    assertEquals(updated.error, null);
    assert(updated.data.user !== null);
    assertEquals(updated.data.user.email, "sdk-updated@example.com");
    const signedInAgain = await client.auth.signInWithPassword({
      email: "sdk-updated@example.com",
      password: "updated horse battery staple",
    });
    assertEquals(signedInAgain.error, null);
    assertEquals(signedInAgain.data.user?.id, signup.data.user.id);

    abortController.abort();
    await server.finished;
  } finally {
    abortController.abort();
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
