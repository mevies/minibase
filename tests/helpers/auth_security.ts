import { assertEquals, assertRejects } from "@std/assert";
import { AuthService, type UpdateUserInput } from "../../src/auth/service.ts";
import type { DatabaseEngine } from "../../src/database/contract.ts";

export async function assertAuthSecurityContract(
  engine: DatabaseEngine,
  prefix: string,
): Promise<void> {
  const passwordPolicy = { minLength: 12, maxLength: 64 };
  const auth = new AuthService(
    engine,
    { jwtSecret: `${prefix}-auth-security-secret-with-at-least-32-characters` },
    { passwordPolicy, reauthenticationWindowSeconds: 300 },
  );
  const originalEmail = `${prefix}-security@example.test`;
  const updatedEmail = `${prefix}-updated@example.test`;
  const originalPassword = "original passphrase 2026";
  const updatedPassword = "updated passphrase 2026";

  await assertRejects(
    () => auth.signUp({ email: `${prefix}-short@example.test`, password: "too short" }),
    Error,
    "at least 12 characters",
  );
  await assertRejects(
    () => auth.signUp({ email: `${prefix}-long@example.test`, password: "x".repeat(65) }),
    Error,
    "at most 64 characters",
  );
  await assertRejects(
    () => auth.signUp({ email: `${prefix}-control@example.test`, password: "valid length\nvalue" }),
    Error,
    "control characters",
  );

  const first = await auth.signUp({ email: originalEmail, password: originalPassword });
  const otherSession = await auth.signInWithPassword(originalEmail, originalPassword);
  await engine.query(
    "update auth.sessions set created_at = $1 where id = $2",
    ["2000-01-01T00:00:00.000Z", sessionId(first.access_token)],
  );

  const metadataOnly = await auth.updateUser(first.access_token, {
    data: { display_name: "metadata remains allowed" },
  });
  assertEquals(metadataOnly.user_metadata.display_name, "metadata remains allowed");
  await assertRejects(
    () => auth.updateUser(first.access_token, { email: updatedEmail }),
    Error,
    "Reauthentication required",
  );

  const recent = await auth.signInWithPassword(originalEmail, originalPassword);
  const updated = await auth.updateUser(recent.access_token, {
    email: updatedEmail,
    password: updatedPassword,
  });
  assertEquals(updated.email, updatedEmail);
  await assertRejects(() => auth.getUser(otherSession.access_token), Error, "revoked");
  assertEquals((await auth.getUser(recent.access_token)).id, first.user.id);
  await assertRejects(
    () => auth.signInWithPassword(updatedEmail, originalPassword),
    Error,
    "Invalid login credentials",
  );
  assertEquals(
    (await auth.signInWithPassword(updatedEmail, updatedPassword)).user.id,
    first.user.id,
  );

  await auth.updateUser(recent.access_token, {
    role: "service_role",
    app_metadata: { provider: "attacker" },
    banned_until: "2999-01-01T00:00:00.000Z",
    disabled: true,
    ban_duration: "876000h",
    is_anonymous: true,
  } as unknown as UpdateUserInput);
  const protectedFields = await engine.query<{
    role: string;
    app_provider: string;
    banned_until: string | null;
    is_anonymous: boolean;
  }>(
    `select role, raw_app_meta_data ->> 'provider' as app_provider,
       banned_until, is_anonymous
     from auth.users where id = $1`,
    [first.user.id],
  );
  assertEquals(protectedFields.rows, [{
    role: "authenticated",
    app_provider: "email",
    banned_until: null,
    is_anonymous: false,
  }]);

  const serviceToken = await auth.createRoleToken("service_role");
  await assertRejects(
    () => auth.adminUpdateUser(serviceToken, first.user.id, { password: "too short" }),
    Error,
    "at least 12 characters",
  );

  const credentialAudit = await engine.query<{
    action: string;
    metadata: Record<string, unknown>;
  }>(
    `select action, metadata from auth.audit_log
     where target_user_id = $1 and action = 'user.credentials_updated'
     order by id`,
    [first.user.id],
  );
  assertEquals(credentialAudit.rows, [{
    action: "user.credentials_updated",
    metadata: {
      email_changed: true,
      password_changed: true,
      anonymous_upgraded: false,
      other_sessions_revoked: true,
    },
  }]);
  const serializedAudit = JSON.stringify(credentialAudit.rows);
  assertEquals(serializedAudit.includes(originalPassword), false);
  assertEquals(serializedAudit.includes(updatedPassword), false);
  assertEquals(serializedAudit.includes(originalEmail), false);
  assertEquals(serializedAudit.includes(updatedEmail), false);

  await engine.query(
    `insert into auth.audit_log(actor_role, action, target_user_id, created_at)
     values ('system', $1, $2, $3), ('system', $4, $2, now())`,
    [
      `${prefix}.audit.old`,
      first.user.id,
      "2000-01-01T00:00:00.000Z",
      `${prefix}.audit.current`,
    ],
  );
  const cleanup = await auth.cleanupAuditLog(24 * 60 * 60 * 1_000, 1);
  assertEquals(cleanup.deleted, 1);
  const retainedAudit = await engine.query<{ action: string }>(
    `select action from auth.audit_log
     where action in ($1, $2, 'audit.cleanup') order by action`,
    [`${prefix}.audit.old`, `${prefix}.audit.current`],
  );
  assertEquals(retainedAudit.rows, [
    { action: "audit.cleanup" },
    { action: `${prefix}.audit.current` },
  ]);
}

function sessionId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) throw new Error("Access token payload is missing");
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const claims = JSON.parse(atob(padded)) as { session_id?: string };
  if (claims.session_id === undefined) throw new Error("Access token session_id is missing");
  return claims.session_id;
}
