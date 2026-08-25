import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthRateLimiter } from "../src/auth/rate_limit.ts";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import { assertAuthSecurityContract } from "./helpers/auth_security.ts";

Deno.test("Auth password, reauthentication, audit and protected-field contract on PGlite", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-security-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await assertAuthSecurityContract(engine, "pglite");
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth endpoint limits isolate routes, client IPs and authenticated identities", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-rate-limit-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {});
  config.auth.rateLimit = {
    windowMs: 60_000,
    signupPerIp: 1,
    passwordPerIp: 2,
    refreshPerIp: 1,
    updatePerIp: 0,
    updatePerIdentity: 1,
    maxKeys: 100,
  };
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(
      engine,
      { jwtSecret: "auth-rate-limit-secret-with-at-least-32-characters" },
      config.auth,
    );
    const alice = await auth.signUp({
      email: "rate-alice@example.test",
      password: "correct horse battery staple",
    });
    const bob = await auth.signUp({
      email: "rate-bob@example.test",
      password: "correct horse battery staple",
    });
    const charlie = await auth.signUp({
      email: "rate-charlie@example.test",
      password: "correct horse battery staple",
    });
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await passwordLogin(handler, "192.0.2.10");
      assertEquals(response.status, 401);
      assertEquals((await response.json()).msg, "Invalid login credentials");
    }
    const passwordLimited = await passwordLogin(handler, "192.0.2.10");
    await assertRateLimited(passwordLimited, "password", "ip", 2);
    assertEquals((await passwordLogin(handler, "192.0.2.11")).status, 401);

    const refresh = await handler(
      jsonRequest("http://localhost/auth/v1/token?grant_type=refresh_token", "192.0.2.20", {
        refresh_token: alice.refresh_token,
      }),
    );
    assertEquals(refresh.status, 200);
    const refreshed = await refresh.json();
    const refreshLimited = await handler(
      jsonRequest("http://localhost/auth/v1/token?grant_type=refresh_token", "192.0.2.20", {
        refresh_token: refreshed.refresh_token,
      }),
    );
    await assertRateLimited(refreshLimited, "refresh", "ip", 1);

    const firstUpdate = await handler(userUpdateRequest(alice.access_token, "192.0.2.30", 1));
    assertEquals(firstUpdate.status, 200, await firstUpdate.clone().text());
    const identityLimited = await handler(
      userUpdateRequest(alice.access_token, "192.0.2.31", 2),
    );
    await assertRateLimited(identityLimited, "user_update", "identity", 1);
    assertEquals(
      (await handler(userUpdateRequest(bob.access_token, "192.0.2.31", 1))).status,
      200,
    );

    const firstSignup = await handler(
      jsonRequest("http://localhost/auth/v1/signup", "192.0.2.40", {
        email: "limited-one@example.test",
        password: "correct horse battery staple",
      }),
    );
    assertEquals(firstSignup.status, 200);
    const signupLimited = await handler(
      jsonRequest("http://localhost/auth/v1/signup", "192.0.2.40", {
        email: "limited-two@example.test",
        password: "correct horse battery staple",
      }),
    );
    await assertRateLimited(signupLimited, "signup", "ip", 1);

    const weakPassword = await handler(
      jsonRequest("http://localhost/auth/v1/signup", "192.0.2.41", {
        email: "weak@example.test",
        password: "too short",
      }),
    );
    assertEquals(weakPassword.status, 422);
    assertEquals((await weakPassword.json()).error_code, "weak_password");

    await engine.query(
      "update auth.sessions set created_at = $1 where user_id = $2",
      ["2000-01-01T00:00:00.000Z", charlie.user.id],
    );
    const staleUpdate = await handler(
      new Request("http://localhost/auth/v1/user", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${charlie.access_token}`,
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.32",
        },
        body: JSON.stringify({ email: "stale-update@example.test" }),
      }),
    );
    assertEquals(staleUpdate.status, 403);
    assertEquals((await staleUpdate.json()).error_code, "reauthentication_required");
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth rate limiter keeps a bounded least-recently-used key set", () => {
  const limiter = new AuthRateLimiter({
    windowMs: 60_000,
    signupPerIp: 1,
    passwordPerIp: 0,
    refreshPerIp: 0,
    updatePerIp: 0,
    updatePerIdentity: 0,
    maxKeys: 100,
  });
  for (let index = 0; index < 250; index++) {
    assert(limiter.checkIp("signup", `192.0.2.${index}`).allowed);
  }
  assertEquals(limiter.bucketCountForTest(), 100);
});

function passwordLogin(handler: (request: Request) => Promise<Response>, ip: string) {
  return handler(
    jsonRequest("http://localhost/auth/v1/token?grant_type=password", ip, {
      email: "rate-alice@example.test",
      password: "incorrect password value",
    }),
  );
}

function jsonRequest(url: string, ip: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function userUpdateRequest(accessToken: string, ip: string, sequence: number): Request {
  return new Request("http://localhost/auth/v1/user", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ data: { sequence } }),
  });
}

async function assertRateLimited(
  response: Response,
  route: string,
  scope: string,
  limit: number,
): Promise<void> {
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("x-ratelimit-limit"), String(limit));
  assert(Number(response.headers.get("retry-after")) >= 1);
  const body = await response.json();
  assertEquals(body.error_code, "auth_rate_limit_exceeded");
  assertEquals(body.route, route);
  assertEquals(body.scope, scope);
  assertEquals(JSON.stringify(body).includes("@example.test"), false);
}
