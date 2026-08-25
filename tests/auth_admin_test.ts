import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";

Deno.test("anonymous auth upgrade, logout and service-role administration", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-admin-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
  const abortController = new AbortController();
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, {
      jwtSecret: "test-secret-with-at-least-32-characters",
    });
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
    const anonKey = await auth.createRoleToken("anon");
    const serviceKey = await auth.createRoleToken("service_role");
    const client = createClient(baseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const anonymous = await client.auth.signInAnonymously({
      options: { data: { display_name: "Temporary User" } },
    });
    assertEquals(anonymous.error, null);
    assertEquals(anonymous.data.user?.is_anonymous, true);
    assert(anonymous.data.session !== null);
    const anonymousId = anonymous.data.user!.id;
    const oldAccessToken = anonymous.data.session!.access_token;

    const upgraded = await client.auth.updateUser({
      email: "upgraded@example.com",
      password: "correct horse battery staple",
      data: { display_name: "Upgraded User" },
    });
    assertEquals(upgraded.error, null);
    assert(upgraded.data.user !== null);
    assertEquals(upgraded.data.user.email, "upgraded@example.com");
    assertEquals(upgraded.data.user.is_anonymous, false);

    const login = await client.auth.signInWithPassword({
      email: "upgraded@example.com",
      password: "correct horse battery staple",
    });
    assertEquals(login.error, null);
    assert(login.data.session !== null);
    const loginAccessToken = login.data.session!.access_token;
    assertEquals((await client.auth.signOut()).error, null);

    const revoked = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { authorization: `Bearer ${loginAccessToken}`, apikey: anonKey },
    });
    assertEquals(revoked.status, 401);

    const admin = createClient(baseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${serviceKey}` } },
    });
    const listed = await admin.auth.admin.listUsers();
    assertEquals(listed.error, null);
    assert(listed.data.users.some((user) => user.id === anonymousId));

    const fetched = await admin.auth.admin.getUserById(anonymousId);
    assertEquals(fetched.error, null);
    assertEquals(fetched.data.user?.email, "upgraded@example.com");

    const disabled = await admin.auth.admin.updateUserById(anonymousId, {
      ban_duration: "1h",
    });
    assertEquals(disabled.error, null);

    const deleted = await admin.auth.admin.deleteUser(anonymousId);
    assertEquals(deleted.error, null);

    const audit = await engine.query<{ action: string }>(
      "select action from auth.audit_log order by id",
    );
    assertEquals(audit.rows, [
      { action: "user.credentials_updated" },
      { action: "user.updated" },
      { action: "user.deleted" },
    ]);

    const oldAnonymousSession = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { authorization: `Bearer ${oldAccessToken}`, apikey: anonKey },
    });
    assertEquals(oldAnonymousSession.status, 401);

    abortController.abort();
    await server.finished;
  } finally {
    abortController.abort();
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
