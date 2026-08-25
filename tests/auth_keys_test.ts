import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { decodeBase64Url, encodeBase64Url } from "../src/auth/encoding.ts";
import { signJwt, verifyJwt } from "../src/auth/jwt.ts";
import {
  activateAuthSigningKey,
  activeAuthSigningKey,
  authSecretValues,
  loadOrCreateAuthSecrets,
  publicAuthJwks,
  removeAuthSigningKey,
  rotateAuthSigningKey,
} from "../src/auth/secrets.ts";
import {
  inspectWindowsSecretAcl,
  unauthorizedWindowsAclSids,
} from "../src/security/windows_acl.ts";

Deno.test("Auth signing keys migrate legacy secrets and rotate without breaking retained tokens", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-keys-test-" });
  const path = join(temp, "secrets.json");
  const legacySecret = "legacy-secret-with-more-than-thirty-two-characters";
  const now = Math.floor(Date.now() / 1_000);
  const claims = { role: "anon" as const, iat: now, exp: now + 60 };
  try {
    const legacyToken = await signJwt(claims, legacySecret);
    await Deno.writeTextFile(path, JSON.stringify({ jwtSecret: legacySecret }));

    const migrated = await loadOrCreateAuthSecrets(path);
    assertEquals(migrated.formatVersion, 1);
    assertEquals(migrated.signingKeys.length, 2);
    assertEquals(
      migrated.signingKeys.some((key) => !("algorithm" in key) && key.secret === legacySecret),
      true,
    );
    assert("algorithm" in activeAuthSigningKey(migrated));
    assertEquals((await verifyJwt(legacyToken, migrated)).role, "anon");
    assertEquals((await Deno.readTextFile(path)).includes("jwtSecret"), false);

    const firstKid = migrated.activeKid;
    const firstToken = await signJwt(claims, activeAuthSigningKey(migrated));
    assertEquals(jwtHeader(firstToken).alg, "ES256");
    assertEquals(jwtHeader(firstToken).kid, firstKid);

    const rotated = await rotateAuthSigningKey(path);
    assertEquals(rotated.previousKid, firstKid);
    assertNotEquals(rotated.secrets.activeKid, firstKid);
    assertEquals(rotated.secrets.signingKeys.length, 3);
    assertEquals((await verifyJwt(legacyToken, rotated.secrets)).role, "anon");
    assertEquals((await verifyJwt(firstToken, rotated.secrets)).role, "anon");

    const rotatedKid = rotated.secrets.activeKid;
    const rotatedToken = await signJwt(claims, activeAuthSigningKey(rotated.secrets));
    assertEquals(jwtHeader(rotatedToken).alg, "ES256");
    assertEquals(jwtHeader(rotatedToken).kid, rotatedKid);

    const rolledBack = await activateAuthSigningKey(path, firstKid);
    assertEquals(rolledBack.activeKid, firstKid);
    const removed = await removeAuthSigningKey(path, rotatedKid);
    assertEquals(removed.signingKeys.map((key) => key.kid), ["legacy", firstKid]);
    await assertRejects(
      () => verifyJwt(rotatedToken, removed),
      Error,
      `Unknown JWT signing key: ${rotatedKid}`,
    );
    await assertRejects(
      () => removeAuthSigningKey(path, firstKid),
      Error,
      "Cannot remove the active Auth signing key",
    );
    await assertRejects(
      () => verifyJwt(`${firstToken}.extra`, removed),
      Error,
      "Invalid JWT structure",
    );
    const [, payload, signature] = firstToken.split(".");
    const unsupportedHeader = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT", kid: firstKid })),
    );
    await assertRejects(
      () => verifyJwt(`${unsupportedHeader}.${payload}.${signature}`, removed),
      Error,
      "Unsupported JWT algorithm or type",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth ES256 secrets expose only public JWKS material", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-jwks-test-" });
  const path = join(temp, "secrets.json");
  try {
    const secrets = await loadOrCreateAuthSecrets(path);
    assertEquals(secrets.signingKeys.length, 1);
    const active = activeAuthSigningKey(secrets);
    assert("algorithm" in active);
    assertEquals(active.algorithm, "ES256");

    const jwks = publicAuthJwks(secrets);
    assertEquals(jwks.keys, [{
      kty: "EC",
      crv: "P-256",
      x: active.publicJwk.x,
      y: active.publicJwk.y,
      kid: active.kid,
      alg: "ES256",
      use: "sig",
    }]);
    const serializedJwks = JSON.stringify(jwks);
    assertEquals(serializedJwks.includes('"d"'), false);
    assertEquals(serializedJwks.includes(active.privateJwk.d!), false);
    assertEquals(authSecretValues(secrets), [active.privateJwk.d]);

    const persisted = await Deno.readTextFile(path);
    assertStringIncludes(persisted, '"algorithm": "ES256"');
    assertStringIncludes(persisted, '"privateJwk"');
    assertStringIncludes(persisted, '"publicJwk"');
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth version 1 HS256-only keyrings upgrade once and retain old tokens", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-hs-keyring-upgrade-test-" });
  const path = join(temp, "secrets.json");
  const legacyKey = {
    kid: "retained-hs256",
    secret: "retained-hs256-secret-with-at-least-32-characters",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const now = Math.floor(Date.now() / 1_000);
  const claims = { role: "authenticated" as const, iat: now, exp: now + 60 };
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        formatVersion: 1,
        activeKid: legacyKey.kid,
        signingKeys: [legacyKey],
      }),
    );
    const oldToken = await signJwt(claims, legacyKey);

    const upgraded = await loadOrCreateAuthSecrets(path);
    assertEquals(upgraded.signingKeys.length, 2);
    assertNotEquals(upgraded.activeKid, legacyKey.kid);
    assert("algorithm" in activeAuthSigningKey(upgraded));
    assertEquals((await verifyJwt(oldToken, upgraded)).role, "authenticated");

    const reloaded = await loadOrCreateAuthSecrets(path);
    assertEquals(reloaded.activeKid, upgraded.activeKid);
    assertEquals(reloaded.signingKeys.length, 2);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth secrets reject links and enforce private platform permissions", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-secret-permissions-test-" });
  const path = join(temp, "secrets.json");
  try {
    await loadOrCreateAuthSecrets(path);
    const created = await Deno.lstat(path);
    assertEquals(created.isFile, true);
    if (Deno.build.os !== "windows") {
      assertEquals((created.mode ?? 0) & 0o077, 0);
      await Deno.chmod(path, 0o666);
      await loadOrCreateAuthSecrets(path);
      assertEquals(((await Deno.lstat(path)).mode ?? 0) & 0o777, 0o600);
    } else {
      let acl = await inspectWindowsSecretAcl(path);
      assertEquals(acl.ownerSid, acl.currentSid);
      assertEquals(acl.protected, true);
      assertEquals(unauthorizedWindowsAclSids(acl), []);

      const broadened = await new Deno.Command("icacls.exe", {
        args: [path, "/grant", "*S-1-1-0:(R)"],
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(
        broadened.success,
        true,
        new TextDecoder().decode(broadened.stderr),
      );
      acl = await inspectWindowsSecretAcl(path);
      assertEquals(unauthorizedWindowsAclSids(acl), ["S-1-1-0"]);

      await loadOrCreateAuthSecrets(path);
      await rotateAuthSigningKey(path);
      acl = await inspectWindowsSecretAcl(path);
      assertEquals(acl.ownerSid, acl.currentSid);
      assertEquals(acl.protected, true);
      assertEquals(unauthorizedWindowsAclSids(acl), []);
    }

    const link = join(temp, "linked-secrets.json");
    await Deno.symlink(path, link, { type: "file" });
    await assertRejects(
      () => loadOrCreateAuthSecrets(link),
      Error,
      "Auth secrets file must not be a symbolic link",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Auth key CLI rotates and removes keys without printing secrets", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-keys-cli-test-" });
  let child: Deno.ChildProcess | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    const listed = await runCliProcess(["auth", "keys", "list", "--project", temp, "--json"]);
    assertEquals(listed.code, 0, listed.stderr);
    assertEquals(listed.stderr, "");
    const initial = JSON.parse(listed.stdout) as {
      activeKid: string;
      keys: Array<{ kid: string; algorithm: string; active: boolean }>;
    };
    assertEquals(initial.keys.length, 1);
    assertEquals(initial.keys[0]?.kid, initial.activeKid);
    assertEquals(initial.keys[0]?.algorithm, "ES256");
    assertEquals(initial.keys[0]?.active, true);

    const rotated = await runCliProcess([
      "auth",
      "keys",
      "rotate",
      "--project",
      temp,
      "--json",
    ]);
    assertEquals(rotated.code, 0, rotated.stderr);
    assertEquals(rotated.stderr, "");
    const rotation = JSON.parse(rotated.stdout) as {
      activeKid: string;
      previousKid: string;
      keys: Array<{ kid: string; active: boolean }>;
    };
    assertEquals(rotation.previousKid, initial.activeKid);
    assertNotEquals(rotation.activeKid, initial.activeKid);
    assertEquals(rotation.keys.length, 2);

    const activated = await runCliProcess([
      "auth",
      "keys",
      "activate",
      "--kid",
      initial.activeKid,
      "--project",
      temp,
      "--json",
    ]);
    assertEquals(activated.code, 0, activated.stderr);
    assertEquals(
      (JSON.parse(activated.stdout) as { activeKid: string }).activeKid,
      initial.activeKid,
    );

    const refused = await runCliProcess([
      "auth",
      "keys",
      "remove",
      "--kid",
      rotation.activeKid,
      "--project",
      temp,
      "--json",
    ]);
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr, "rerun with --force");

    const removed = await runCliProcess([
      "auth",
      "keys",
      "remove",
      "--kid",
      rotation.activeKid,
      "--project",
      temp,
      "--force",
      "--json",
    ]);
    assertEquals(removed.code, 0, removed.stderr);
    assertEquals(removed.stderr, "");
    assertEquals((JSON.parse(removed.stdout) as { keys: unknown[] }).keys.length, 1);

    const persisted = JSON.parse(
      await Deno.readTextFile(join(temp, ".minibase", "secrets.json")),
    ) as {
      signingKeys: Array<{
        secret?: string;
        privateJwk?: { d?: string };
      }>;
    };
    const allOutput = [listed, rotated, activated, refused, removed]
      .map((result) => `${result.stdout}\n${result.stderr}`)
      .join("\n");
    for (const key of persisted.signingKeys) {
      if (key.secret !== undefined) assertEquals(allOutput.includes(key.secret), false);
      if (key.privateJwk?.d !== undefined) {
        assertEquals(allOutput.includes(key.privateJwk.d), false);
        assertEquals(allOutput.includes(JSON.stringify(key.privateJwk)), false);
      }
    }

    const port = availablePort();
    child = startServer(temp, port);
    await waitForRuntime(join(temp, ".minibase", "runtime.json"));
    const blocked = await runCliProcess([
      "auth",
      "keys",
      "rotate",
      "--project",
      temp,
      "--json",
    ]);
    assertEquals(blocked.code, 1);
    assertStringIncludes(blocked.stderr, "Stop Minibase before changing Auth signing keys");
    assertEquals(
      (await runCliProcess(["stop", "--project", temp, "--json"])).code,
      0,
    );
    const stopped = await child.output();
    assertEquals(stopped.code, 0, new TextDecoder().decode(stopped.stderr));
    child = null;
  } finally {
    try {
      child?.kill("SIGKILL");
    } catch {
      // Normal stop already reaped it.
    }
    await Deno.remove(temp, { recursive: true });
  }
});

function jwtHeader(token: string): { alg?: string; kid?: string } {
  return JSON.parse(
    new TextDecoder().decode(decodeBase64Url(token.split(".")[0]!)),
  ) as { alg?: string; kid?: string };
}

async function runCliProcess(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function startServer(project: string, port: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      project,
      "--port",
      String(port),
    ],
    cwd: project,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await Deno.readTextFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Auth key CLI runtime.json");
}

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}
