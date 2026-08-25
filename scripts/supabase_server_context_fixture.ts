import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createClient } from "@supabase/supabase-js";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const FIXTURE = join(ROOT, "fixtures", "supabase-server-context-functions");

interface WorkerContextResponse {
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

export async function installSupabaseServerContextFixture(projectRoot: string): Promise<void> {
  const supabaseDir = join(projectRoot, "supabase");
  await copyTree(join(FIXTURE, "functions"), join(supabaseDir, "functions"));
  const configPath = join(supabaseDir, "config.toml");
  const fragment = (await Deno.readTextFile(join(FIXTURE, "config.toml.append"))).trim();
  const current = await Deno.readTextFile(configPath);
  if (!current.includes("[functions.context-user]")) {
    await Deno.writeTextFile(configPath, `${current.trimEnd()}\n\n${fragment}\n`);
  }
}

export async function seedSupabaseServerFunctionCache(
  targetDenoDir: string,
): Promise<void> {
  const functionDir = join(FIXTURE, "functions", "context-user");
  const lockPath = join(functionDir, "deno.lock");
  const cacheOutput = await new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--config",
      join(functionDir, "deno.json"),
      "--lock",
      lockPath,
      "--frozen",
      join(functionDir, "index.ts"),
    ],
    env: { DENO_NO_UPDATE_CHECK: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(cacheOutput.success, true, new TextDecoder().decode(cacheOutput.stderr));
  const lock = JSON.parse(
    await Deno.readTextFile(lockPath),
  ) as { npm?: Record<string, unknown> };
  const infoOutput = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    env: { DENO_NO_UPDATE_CHECK: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(infoOutput.success, true, new TextDecoder().decode(infoOutput.stderr));
  const info = JSON.parse(new TextDecoder().decode(infoOutput.stdout)) as { npmCache: string };
  const sourceRegistry = join(info.npmCache, "registry.npmjs.org");
  const targetRegistry = join(targetDenoDir, "npm", "registry.npmjs.org");
  for (const locked of Object.keys(lock.npm ?? {})) {
    const withoutPeers = locked.split("_", 1)[0]!;
    const versionSeparator = withoutPeers.lastIndexOf("@");
    assert(versionSeparator > 0, `Invalid npm lock key: ${locked}`);
    const name = withoutPeers.slice(0, versionSeparator);
    const version = withoutPeers.slice(versionSeparator + 1);
    const packagePath = name.split("/");
    const sourcePackage = join(sourceRegistry, ...packagePath);
    const targetPackage = join(targetRegistry, ...packagePath);
    await Deno.mkdir(targetPackage, { recursive: true });
    await copyTree(join(sourcePackage, version), join(targetPackage, version));
    await copyFileIfPresent(
      join(sourcePackage, "registry.json"),
      join(targetPackage, "registry.json"),
    );
  }
}

export async function assertSupabaseServerWorkerContract(options: {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  prefix: string;
}): Promise<void> {
  const serviceClient = createClient(
    options.apiUrl,
    options.serviceRoleKey,
    serverClientOptions(),
  );
  assertEquals(
    (await serviceClient.storage.createBucket("avatars", { public: false })).error,
    null,
  );
  const alice = await signUpClient(
    options.apiUrl,
    options.anonKey,
    `${options.prefix}-alice@example.test`,
  );
  const bob = await signUpClient(
    options.apiUrl,
    options.anonKey,
    `${options.prefix}-bob@example.test`,
  );
  const aliceClient = authenticatedClient(options.apiUrl, options.anonKey, alice.accessToken);
  const bobClient = authenticatedClient(options.apiUrl, options.anonKey, bob.accessToken);
  const contextPrefix = `${options.prefix}-worker-context`;
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

  const invoked = await aliceClient.functions.invoke("context-user", {
    body: { prefix: contextPrefix },
  });
  assertEquals(invoked.error, null);
  const context = invoked.data as WorkerContextResponse;
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
      body: { source: contextPrefix, userId: alice.id },
    },
    error: null,
  });

  const none = await fetch(new URL("/functions/v1/context-none", options.apiUrl));
  assertEquals(none.status, 200);
  assertEquals(await none.json(), { authMode: "none", userClaims: null, jwtClaims: null });

  const named = await fetch(new URL("/functions/v1/context-named", options.apiUrl), {
    headers: {
      apikey: options.serviceRoleKey,
      authorization: `Bearer ${options.serviceRoleKey}`,
    },
  });
  assertEquals(named.status, 401);
  assertEquals((await named.json()).code, "INVALID_CREDENTIALS");

  const invalidFallback = await fetch(
    new URL("/functions/v1/context-invalid-fallback", options.apiUrl),
    { headers: { authorization: "Bearer definitely.invalid.token" } },
  );
  assertEquals(invalidFallback.status, 401);
  assertEquals((await invalidFallback.json()).code, "INVALID_CREDENTIALS");
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

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile) await Deno.copyFile(sourcePath, destinationPath);
    else throw new Error(`Fixture cache contains an unsupported entry: ${sourcePath}`);
  }
}

async function copyFileIfPresent(source: string, destination: string): Promise<void> {
  try {
    await Deno.copyFile(source, destination);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
