import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";

Deno.test("Auth signup, password login, user lookup and refresh rotation", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  const engine = new PGliteEngine(join(temp, "pglite"));
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

    const signup = await handler(
      new Request("http://localhost/auth/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "correct horse battery staple",
          data: { display_name: "New User" },
        }),
      }),
    );
    assertEquals(signup.status, 200);
    const firstSession = await signup.json();
    assertEquals(firstSession.user.email, "new@example.com");

    const profiles = await engine.query<{ display_name: string }>(
      "select display_name from public.profiles where id = $1",
      [firstSession.user.id],
    );
    assertEquals(profiles.rows, [{ display_name: "New User" }]);

    const login = await handler(
      new Request("http://localhost/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "correct horse battery staple",
        }),
      }),
    );
    assertEquals(login.status, 200);
    const loginSession = await login.json();

    const userResponse = await handler(
      new Request("http://localhost/auth/v1/user", {
        headers: { authorization: `Bearer ${loginSession.access_token}` },
      }),
    );
    assertEquals(userResponse.status, 200);
    assertEquals((await userResponse.json()).id, firstSession.user.id);

    const refresh = await handler(
      new Request("http://localhost/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: loginSession.refresh_token }),
      }),
    );
    assertEquals(refresh.status, 200);
    const refreshed = await refresh.json();
    assertNotEquals(refreshed.refresh_token, loginSession.refresh_token);

    const reused = await handler(
      new Request("http://localhost/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: loginSession.refresh_token }),
      }),
    );
    assertEquals(reused.status, 400);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
