import { assert, assertEquals } from "@std/assert";
import { withSupabase } from "@supabase/server";
import { createClient } from "@supabase/supabase-js";
import type { AuthSecrets } from "../../src/auth/secrets.ts";
import { publicAuthJwks } from "../../src/auth/secrets.ts";
import { AuthService } from "../../src/auth/service.ts";
import type { MinibaseConfig } from "../../src/config/types.ts";
import type { DatabaseEngine } from "../../src/database/contract.ts";
import { createAppHandler } from "../../src/server/app.ts";
import type { ObjectStore } from "../../src/storage/contract.ts";

interface SupabaseServerContextContractOptions {
  config: MinibaseConfig;
  engine: DatabaseEngine;
  objectStore: ObjectStore;
  authSecrets: AuthSecrets;
  prefix: string;
}

interface ContextResponse {
  authMode: string;
  authKeyName: string | null;
  userClaims: { id?: string; email?: string; role?: string } | null;
  jwtSub: string | null;
  authUser: { id: string | null; email: string | null; error: string | null };
  userNotes: { bodies: string[]; error: string | null };
  adminNotes: { bodies: string[]; error: string | null };
  userObjects: { names: string[]; error: string | null };
  adminObjects: { names: string[]; error: string | null };
  invoke: {
    data: { authMode?: string; authKeyName?: string; body?: unknown } | null;
    error: string | null;
  };
}

interface ContextDatabase {
  public: {
    Tables: {
      notes: {
        Row: { body: string };
        Insert: { body: string; owner_id: string };
        Update: { body?: string; owner_id?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export async function assertSupabaseServerContextContract(
  options: SupabaseServerContextContractOptions,
): Promise<void> {
  const auth = new AuthService(options.engine, options.authSecrets);
  const anonKey = await auth.createRoleToken("anon");
  const serviceRoleKey = await auth.createRoleToken("service_role");
  const appHandler = createAppHandler({
    config: options.config,
    engine: options.engine,
    authService: auth,
    objectStore: options.objectStore,
    resolveRequestContext: (request) => auth.resolveRequestContext(request),
  });
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const abortController = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    (request) => routes.get(new URL(request.url).pathname)?.(request) ?? appHandler(request),
  );

  try {
    const baseUrl = `http://127.0.0.1:${await listening.promise}`;
    const contextPrefix = `${options.prefix}-context`;
    const environment = {
      url: baseUrl,
      publishableKeys: { default: anonKey },
      secretKeys: { default: serviceRoleKey },
      jwks: publicAuthJwks(options.authSecrets),
    };
    routes.set(
      "/functions/v1/context-target",
      withSupabase<ContextDatabase>(
        { auth: "secret", env: environment, cors: "disabled" },
        async (request, context) =>
          Response.json({
            authMode: context.authMode,
            authKeyName: context.authKeyName,
            body: await request.json(),
          }),
      ),
    );
    routes.set(
      "/functions/v1/context",
      withSupabase<ContextDatabase>(
        { auth: "user", env: environment, cors: "disabled" },
        async (_request, context) => {
          const [authUser, userNotes, adminNotes, userObjects, adminObjects, invoke] = await Promise
            .all([
              context.supabase.auth.getUser(),
              context.supabase.from("notes").select("body").like(
                "body",
                `${contextPrefix}-%`,
              ).order("body"),
              context.supabaseAdmin.from("notes").select("body").like(
                "body",
                `${contextPrefix}-%`,
              ).order("body"),
              context.supabase.storage.from("avatars").list(contextPrefix),
              context.supabaseAdmin.storage.from("avatars").list(contextPrefix),
              context.supabaseAdmin.functions.invoke("context-target", {
                body: { source: options.prefix, userId: context.userClaims?.id },
              }),
            ]);
          return Response.json({
            authMode: context.authMode,
            authKeyName: context.authKeyName ?? null,
            userClaims: context.userClaims,
            jwtSub: context.jwtClaims?.sub ?? null,
            authUser: {
              id: authUser.data.user?.id ?? null,
              email: authUser.data.user?.email ?? null,
              error: authUser.error?.message ?? null,
            },
            userNotes: {
              bodies: userNotes.data?.map((row) => row.body) ?? [],
              error: userNotes.error?.message ?? null,
            },
            adminNotes: {
              bodies: adminNotes.data?.map((row) => row.body) ?? [],
              error: adminNotes.error?.message ?? null,
            },
            userObjects: {
              names: userObjects.data?.map((object) => object.name).toSorted() ?? [],
              error: userObjects.error?.message ?? null,
            },
            adminObjects: {
              names: adminObjects.data?.map((object) => object.name).toSorted() ?? [],
              error: adminObjects.error?.message ?? null,
            },
            invoke: {
              data: invoke.data,
              error: invoke.error?.message ?? null,
            },
          });
        },
      ),
    );
    routes.set(
      "/functions/v1/context-none",
      withSupabase(
        { auth: "none", env: environment, cors: "disabled" },
        (_request, context) =>
          Promise.resolve(Response.json({
            authMode: context.authMode,
            userClaims: context.userClaims,
            jwtClaims: context.jwtClaims,
          })),
      ),
    );
    routes.set(
      "/functions/v1/context-named",
      withSupabase(
        { auth: "secret:automations", env: environment, cors: "disabled" },
        (_request, context) => Promise.resolve(Response.json({ authMode: context.authMode })),
      ),
    );
    routes.set(
      "/functions/v1/context-invalid-fallback",
      withSupabase(
        { auth: ["user", "none"], env: environment, cors: "disabled" },
        (_request, context) => Promise.resolve(Response.json({ authMode: context.authMode })),
      ),
    );

    const serviceClient = createClient(baseUrl, serviceRoleKey, serverClientOptions());
    const bucket = await serviceClient.storage.createBucket("avatars", { public: false });
    assertEquals(bucket.error, null);

    const alice = await signUpClient(baseUrl, anonKey, `${options.prefix}-alice@example.test`);
    const bob = await signUpClient(baseUrl, anonKey, `${options.prefix}-bob@example.test`);
    const aliceClient = authenticatedClient(baseUrl, anonKey, alice.accessToken);
    const bobClient = authenticatedClient(baseUrl, anonKey, bob.accessToken);
    const aliceBody = `${contextPrefix}-alice`;
    const bobBody = `${contextPrefix}-bob`;
    assertEquals(
      (await aliceClient.from("notes").insert({ owner_id: alice.id, body: aliceBody })).error,
      null,
    );
    assertEquals(
      (await bobClient.from("notes").insert({ owner_id: bob.id, body: bobBody })).error,
      null,
    );
    assertEquals(
      (await aliceClient.storage.from("avatars").upload(
        `${contextPrefix}/alice.txt`,
        new Blob(["alice"]),
      )).error,
      null,
    );
    assertEquals(
      (await bobClient.storage.from("avatars").upload(
        `${contextPrefix}/bob.txt`,
        new Blob(["bob"]),
      )).error,
      null,
    );

    const contextResponse = await fetch(`${baseUrl}/functions/v1/context`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${alice.accessToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assertEquals(contextResponse.status, 200, await contextResponse.clone().text());
    const context = await contextResponse.json() as ContextResponse;
    assertEquals(context.authMode, "user");
    assertEquals(context.authKeyName, null);
    assertEquals(context.userClaims?.id, alice.id);
    assertEquals(context.userClaims?.email, alice.email);
    assertEquals(context.userClaims?.role, "authenticated");
    assertEquals(context.jwtSub, alice.id);
    assertEquals(context.authUser, { id: alice.id, email: alice.email, error: null });
    assertEquals(context.userNotes, { bodies: [aliceBody], error: null });
    assertEquals(context.adminNotes, { bodies: [aliceBody, bobBody], error: null });
    assertEquals(context.userObjects, {
      names: [`${contextPrefix}/alice.txt`],
      error: null,
    });
    assertEquals(context.adminObjects, {
      names: [`${contextPrefix}/alice.txt`, `${contextPrefix}/bob.txt`],
      error: null,
    });
    assertEquals(context.invoke, {
      data: {
        authMode: "secret",
        authKeyName: "default",
        body: { source: options.prefix, userId: alice.id },
      },
      error: null,
    });

    const none = await fetch(`${baseUrl}/functions/v1/context-none`);
    assertEquals(none.status, 200);
    assertEquals(await none.json(), { authMode: "none", userClaims: null, jwtClaims: null });

    const named = await fetch(`${baseUrl}/functions/v1/context-named`, {
      headers: { apikey: serviceRoleKey },
    });
    assertEquals(named.status, 401);
    assertEquals((await named.json()).code, "INVALID_CREDENTIALS");

    const invalidFallback = await fetch(`${baseUrl}/functions/v1/context-invalid-fallback`, {
      headers: { authorization: "Bearer definitely.invalid.token" },
    });
    assertEquals(invalidFallback.status, 401);
    assertEquals((await invalidFallback.json()).code, "INVALID_CREDENTIALS");

    const hmacAuth = new AuthService(options.engine, {
      jwtSecret: "external-hs256-context-secret-with-at-least-32-characters",
    });
    const hmacSession = await hmacAuth.signUp({
      email: `${options.prefix}-hs256@example.test`,
      password: "correct horse battery staple",
    });
    routes.set(
      "/functions/v1/context-hs256-no-jwks",
      withSupabase(
        {
          auth: "user",
          env: { ...environment, jwks: { keys: [] } },
          cors: "disabled",
        },
        (_request, context) => Promise.resolve(Response.json({ authMode: context.authMode })),
      ),
    );
    const noJwks = await fetch(`${baseUrl}/functions/v1/context-hs256-no-jwks`, {
      headers: { authorization: `Bearer ${hmacSession.access_token}` },
    });
    assertEquals(noJwks.status, 401);
    assertEquals((await noJwks.json()).code, "INVALID_CREDENTIALS");
  } finally {
    abortController.abort();
    await server.finished;
  }
}

async function signUpClient(baseUrl: string, anonKey: string, email: string): Promise<{
  id: string;
  email: string;
  accessToken: string;
}> {
  const client = createClient(baseUrl, anonKey, serverClientOptions());
  const signup = await client.auth.signUp({
    email,
    password: "correct horse battery staple",
    options: { data: { display_name: email } },
  });
  assertEquals(signup.error, null);
  assert(signup.data.user !== null);
  assert(signup.data.session !== null);
  return {
    id: signup.data.user.id,
    email,
    accessToken: signup.data.session.access_token,
  };
}

function authenticatedClient(baseUrl: string, anonKey: string, accessToken: string) {
  return createClient(baseUrl, anonKey, {
    ...serverClientOptions(),
    global: { headers: { authorization: `Bearer ${accessToken}` } },
  });
}

function serverClientOptions() {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
}
