import { assert, assertEquals } from "@std/assert";
import type { AuthService } from "../src/auth/service.ts";
import type { MinibaseConfig } from "../src/config/types.ts";
import { createFunctionsHandler } from "../src/functions/handler.ts";
import type { FunctionManager } from "../src/functions/manager.ts";
import {
  functionRateLimitClientIp,
  FunctionRateLimiter,
  functionRateLimitIdentity,
} from "../src/functions/rate_limit.ts";

Deno.test("Function rate limiter isolates function, IP and identity budgets", () => {
  let now = 1_000;
  const limiter = new FunctionRateLimiter(
    {
      rateLimit: {
        windowMs: 1_000,
        perIp: 0,
        perFunction: 2,
        perIdentity: 0,
        maxKeys: 100,
      },
      definitions: {
        ip: {
          verifyJwt: false,
          injectServiceRoleKey: false,
          rateLimit: { perIp: 1, perFunction: 0 },
        },
        identity: {
          verifyJwt: true,
          injectServiceRoleKey: false,
          rateLimit: { perIdentity: 1, perFunction: 0 },
        },
      },
    },
    () => now,
  );

  assert(limiter.checkIngress("aggregate", "192.0.2.1").allowed);
  assert(limiter.checkIngress("aggregate", "192.0.2.2").allowed);
  const aggregate = limiter.checkIngress("aggregate", "192.0.2.3");
  assert(!aggregate.allowed);
  assertEquals(aggregate.scope, "function");
  assertEquals(aggregate.retryAfterMs, 1_000);

  assert(limiter.checkIngress("ip", "198.51.100.1").allowed);
  const repeatedIp = limiter.checkIngress("ip", "198.51.100.1");
  assert(!repeatedIp.allowed);
  assertEquals(repeatedIp.scope, "ip");
  assert(limiter.checkIngress("ip", "198.51.100.2").allowed);

  assert(limiter.requiresIdentity("identity"));
  assert(limiter.checkIdentity("identity", "authenticated:subject:first").allowed);
  const repeatedIdentity = limiter.checkIdentity(
    "identity",
    "authenticated:subject:first",
  );
  assert(!repeatedIdentity.allowed);
  assertEquals(repeatedIdentity.scope, "identity");
  assert(limiter.checkIdentity("identity", "authenticated:subject:second").allowed);

  now += 1_000;
  assert(limiter.checkIngress("aggregate", "192.0.2.3").allowed);
  assert(limiter.checkIngress("ip", "198.51.100.1").allowed);
  assert(limiter.checkIdentity("identity", "authenticated:subject:first").allowed);
});

Deno.test("Function rate limiter bounds keys and normalizes request dimensions", () => {
  const limiter = new FunctionRateLimiter({
    rateLimit: {
      windowMs: 60_000,
      perIp: 1,
      perFunction: 0,
      perIdentity: 0,
      maxKeys: 100,
    },
    definitions: {},
  });
  for (let index = 0; index < 150; index++) {
    assert(limiter.checkIngress("bounded", `2001:db8::${index.toString(16)}`).allowed);
  }
  assertEquals(limiter.bucketCountForTest(), 100);

  assertEquals(
    functionRateLimitClientIp(
      new Request("http://localhost/functions/v1/test", {
        headers: { "x-forwarded-for": "2001:DB8::1" },
      }),
    ),
    "2001:db8::1",
  );
  assertEquals(
    functionRateLimitClientIp(
      new Request("http://localhost/functions/v1/test", {
        headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.2" },
      }),
    ),
    "unknown",
  );
  assertEquals(
    functionRateLimitIdentity({
      role: "authenticated",
      claims: { role: "authenticated", sub: "user-id" },
    }),
    "authenticated:subject:user-id",
  );
  assertEquals(
    functionRateLimitIdentity({ role: "anon", claims: { role: "anon" } }),
    "role:anon",
  );
});

Deno.test("public Functions group invalid optional JWTs as anonymous identities", async () => {
  let invocations = 0;
  const manager = {
    invoke: () => {
      invocations++;
      return Promise.resolve(Response.json({ ok: true }));
    },
  } as unknown as FunctionManager;
  const auth = {
    resolveRequestContext: () => Promise.reject(new Error("Invalid JWT signature")),
  } as unknown as AuthService;
  const config = {
    functions: {
      rateLimit: {
        windowMs: 60_000,
        perIp: 0,
        perFunction: 0,
        perIdentity: 1,
        maxKeys: 100,
      },
      definitions: {
        public: {
          verifyJwt: false,
          injectServiceRoleKey: false,
        },
      },
    },
  } as unknown as MinibaseConfig;
  const handler = createFunctionsHandler(manager, auth, config);

  const first = await handler(
    new Request("http://localhost/functions/v1/public", {
      headers: { authorization: "Bearer forged-first" },
    }),
  );
  assertEquals(first?.status, 200);
  const second = await handler(
    new Request("http://localhost/functions/v1/public", {
      headers: { authorization: "Bearer forged-second" },
    }),
  );
  assertEquals(second?.status, 429);
  assertEquals((await second?.json()).scope, "identity");
  assertEquals(invocations, 1);
});
