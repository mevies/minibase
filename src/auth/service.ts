import type {
  DatabaseEngine,
  DatabaseSession,
  RequestDatabaseContext,
} from "../database/contract.ts";
import type { MinibaseConfig } from "../config/types.ts";
import { randomToken, sha256 } from "./encoding.ts";
import { type JwtClaims, signJwt, verifyJwt } from "./jwt.ts";
import { DEFAULT_AUTH_PASSWORD_POLICY, hashPassword, verifyPassword } from "./password.ts";
import {
  activeAuthSigningKey,
  type AuthSecrets,
  type AuthSecretsInput,
  normalizeAuthSecrets,
} from "./secrets.ts";

interface UserRow {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  is_anonymous: boolean;
  banned_until: string | null;
}

export interface PublicUser {
  id: string;
  email: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  is_anonymous: boolean;
}

export interface AuthSessionResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: PublicUser;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  data?: Record<string, unknown>;
  ban_duration?: string;
  disabled?: boolean;
}

export interface AnonymousCleanupResult {
  deleted: number;
  cutoff: string;
  batchSize: number;
}

export interface AuditLogCleanupResult {
  deleted: number;
  cutoff: string;
  batchSize: number;
}

type AuthServiceSecurityOptions = Pick<
  MinibaseConfig["auth"],
  "passwordPolicy" | "reauthenticationWindowSeconds"
>;

const DEFAULT_AUTH_SECURITY_OPTIONS: AuthServiceSecurityOptions = {
  passwordPolicy: DEFAULT_AUTH_PASSWORD_POLICY,
  reauthenticationWindowSeconds: 5 * 60,
};

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    app_metadata: row.raw_app_meta_data ?? {},
    user_metadata: row.raw_user_meta_data ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_anonymous: row.is_anonymous,
  };
}

export class AuthService {
  static readonly ACCESS_TOKEN_SECONDS = 15 * 60;
  static readonly REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

  constructor(
    private readonly engine: DatabaseEngine,
    secrets: AuthSecretsInput,
    security: AuthServiceSecurityOptions = DEFAULT_AUTH_SECURITY_OPTIONS,
  ) {
    this.secrets = normalizeAuthSecrets(secrets);
    this.security = security;
  }

  private readonly secrets: AuthSecrets;
  private readonly security: AuthServiceSecurityOptions;

  async signUp(input: {
    email?: string;
    password?: string;
    data?: Record<string, unknown>;
  }): Promise<AuthSessionResponse> {
    const anonymous = input.email === undefined && input.password === undefined;
    if (!anonymous && (input.email === undefined || input.password === undefined)) {
      throw new Error("Email and password must be provided together");
    }
    const id = crypto.randomUUID();
    const encryptedPassword = anonymous
      ? null
      : await hashPassword(input.password!, this.security.passwordPolicy);
    const result = await this.engine.query<UserRow>(
      `insert into auth.users(
        id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        email_confirmed_at, confirmed_at, is_anonymous
      ) values ($1, 'authenticated', 'authenticated', $2, $3, $4::text::jsonb, $5::text::jsonb, now(), now(), $6)
      returning id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until`,
      [
        id,
        input.email?.trim().toLowerCase() ?? null,
        encryptedPassword,
        JSON.stringify({ provider: anonymous ? "anonymous" : "email", providers: [] }),
        JSON.stringify(input.data ?? {}),
        anonymous,
      ],
    );
    return await this.createSession(result.rows[0]!);
  }

  async signInWithPassword(email: string, password: string): Promise<AuthSessionResponse> {
    const result = await this.engine.query<UserRow>(
      `select id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until
       from auth.users where lower(email) = lower($1) limit 1`,
      [email.trim()],
    );
    const user = result.rows[0];
    if (
      user === undefined || user.encrypted_password === null ||
      (user.banned_until !== null && new Date(user.banned_until).getTime() > Date.now()) ||
      !(await verifyPassword(password, user.encrypted_password))
    ) {
      throw new Error("Invalid login credentials");
    }
    return await this.createSession(user);
  }

  async refresh(refreshToken: string): Promise<AuthSessionResponse> {
    const tokenHash = await sha256(refreshToken);
    return await this.engine.transaction(async (session) => {
      const result = await session.query<UserRow & { refresh_id: number; session_id: string }>(
        `select u.id, u.email, u.encrypted_password, u.raw_app_meta_data, u.raw_user_meta_data,
          u.created_at, u.updated_at, u.is_anonymous, r.id::int as refresh_id, r.session_id
         from auth.refresh_tokens r
         join auth.users u on u.id = r.user_id
         where r.token_hash = $1 and r.revoked_at is null and r.expires_at > now()
           and (u.banned_until is null or u.banned_until <= now())
         for update of r`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Invalid refresh token");
      }
      await session.query("update auth.refresh_tokens set revoked_at = now() where id = $1", [
        row.refresh_id,
      ]);
      return await this.createSessionInSession(session, row, row.session_id);
    });
  }

  async getUser(token: string): Promise<PublicUser> {
    const claims = await this.verifyActiveUserToken(token);
    if (claims.sub === undefined) {
      throw new Error("JWT does not contain a user id");
    }
    const result = await this.engine.query<UserRow>(
      `select id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until
       from auth.users where id = $1`,
      [claims.sub],
    );
    const user = result.rows[0];
    if (user === undefined) {
      throw new Error("User not found");
    }
    return publicUser(user);
  }

  async updateUser(token: string, input: UpdateUserInput): Promise<PublicUser> {
    const claims = await this.verifyActiveUserToken(token);
    const current = await this.userById(claims.sub!);
    const wantsIdentityUpgrade = current.is_anonymous &&
      (input.email !== undefined || input.password !== undefined);
    if (wantsIdentityUpgrade && (input.email === undefined || input.password === undefined)) {
      throw new Error("Anonymous account upgrade requires both email and password");
    }
    const sensitiveUpdate = input.email !== undefined || input.password !== undefined;

    const email = input.email?.trim().toLowerCase() ?? current.email;
    const encryptedPassword = input.password === undefined
      ? current.encrypted_password
      : await hashPassword(input.password, this.security.passwordPolicy);
    const metadata = input.data === undefined
      ? current.raw_user_meta_data
      : { ...current.raw_user_meta_data, ...input.data };
    const anonymous = wantsIdentityUpgrade ? false : current.is_anonymous;
    const appMetadata = wantsIdentityUpgrade
      ? { provider: "email", providers: ["email"] }
      : current.raw_app_meta_data;
    return await this.engine.transaction(async (session) => {
      if (sensitiveUpdate) {
        await this.requireSensitiveUpdateSession(session, claims, !current.is_anonymous);
      }
      const result = await session.query<UserRow>(
        `update auth.users set
          email = $2,
          encrypted_password = $3,
          raw_user_meta_data = $4::text::jsonb,
          raw_app_meta_data = $5::text::jsonb,
          is_anonymous = $6,
          email_confirmed_at = case when $6 then email_confirmed_at else coalesce(email_confirmed_at, now()) end,
          confirmed_at = case when $6 then confirmed_at else coalesce(confirmed_at, now()) end,
          updated_at = now()
         where id = $1
         returning id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
          created_at, updated_at, is_anonymous, banned_until`,
        [
          current.id,
          email,
          encryptedPassword,
          JSON.stringify(metadata),
          JSON.stringify(appMetadata),
          anonymous,
        ],
      );
      if (sensitiveUpdate) {
        await session.query(
          `update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now())
           where user_id = $1 and session_id <> $2`,
          [current.id, claims.session_id],
        );
        await session.query(
          `update auth.sessions set revoked_at = coalesce(revoked_at, now()), updated_at = now()
           where user_id = $1 and id <> $2`,
          [current.id, claims.session_id],
        );
        await this.auditInSession(session, claims, "user.credentials_updated", current.id, {
          email_changed: input.email !== undefined,
          password_changed: input.password !== undefined,
          anonymous_upgraded: wantsIdentityUpgrade,
          other_sessions_revoked: true,
        });
      }
      return publicUser(result.rows[0]!);
    });
  }

  async logout(token: string): Promise<void> {
    const claims = await verifyJwt(token, this.secrets);
    if (claims.role !== "authenticated" || typeof claims.session_id !== "string") {
      throw new Error("A user session token is required");
    }
    await this.engine.transaction(async (session) => {
      await session.query(
        `update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now())
         where session_id = $1`,
        [claims.session_id],
      );
      await session.query(
        `update auth.sessions set revoked_at = coalesce(revoked_at, now()), updated_at = now()
         where id = $1 and user_id = $2`,
        [claims.session_id, claims.sub],
      );
    });
  }

  async listUsers(serviceToken: string, page = 1, perPage = 50): Promise<{
    users: PublicUser[];
    aud: string;
    nextPage: number | null;
    lastPage: number;
    total: number;
  }> {
    await this.requireServiceRole(serviceToken);
    const safePage = Math.max(1, Math.floor(page));
    const safePerPage = Math.min(1_000, Math.max(1, Math.floor(perPage)));
    const totalResult = await this.engine.query<{ count: bigint }>(
      "select count(*)::bigint as count from auth.users",
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);
    const result = await this.engine.query<UserRow>(
      `select id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until
       from auth.users order by created_at, id limit $1 offset $2`,
      [safePerPage, (safePage - 1) * safePerPage],
    );
    const lastPage = Math.max(1, Math.ceil(total / safePerPage));
    return {
      users: result.rows.map(publicUser),
      aud: "authenticated",
      nextPage: safePage < lastPage ? safePage + 1 : null,
      lastPage,
      total,
    };
  }

  async adminGetUser(serviceToken: string, userId: string): Promise<PublicUser> {
    await this.requireServiceRole(serviceToken);
    return publicUser(await this.userById(userId));
  }

  async adminUpdateUser(
    serviceToken: string,
    userId: string,
    input: UpdateUserInput,
  ): Promise<PublicUser> {
    const actor = await this.requireServiceRole(serviceToken);
    const current = await this.userById(userId);
    const email = input.email?.trim().toLowerCase() ?? current.email;
    const encryptedPassword = input.password === undefined
      ? current.encrypted_password
      : await hashPassword(input.password, this.security.passwordPolicy);
    const metadata = input.data === undefined
      ? current.raw_user_meta_data
      : { ...current.raw_user_meta_data, ...input.data };
    const bannedUntil = input.disabled === true || input.ban_duration !== undefined
      ? new Date(Date.now() + parseBanDuration(input.ban_duration ?? "876000h")).toISOString()
      : null;
    const result = await this.engine.query<UserRow>(
      `update auth.users set email = $2, encrypted_password = $3,
        raw_user_meta_data = $4::text::jsonb, banned_until = $5, updated_at = now()
       where id = $1
       returning id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until`,
      [userId, email, encryptedPassword, JSON.stringify(metadata), bannedUntil],
    );
    await this.audit(actor, "user.updated", userId, {
      email_changed: input.email !== undefined,
      password_changed: input.password !== undefined,
      disabled: input.disabled === true || input.ban_duration !== undefined,
    });
    return publicUser(result.rows[0]!);
  }

  async adminDeleteUser(serviceToken: string, userId: string): Promise<PublicUser> {
    const actor = await this.requireServiceRole(serviceToken);
    const user = await this.userById(userId);
    await this.engine.transaction(async (session) => {
      await session.query("delete from auth.users where id = $1", [userId]);
      await this.auditInSession(session, actor, "user.deleted", userId, {});
    });
    return publicUser(user);
  }

  async cleanupAnonymousUsers(
    retentionMs: number,
    batchSize: number,
    now = Date.now(),
  ): Promise<AnonymousCleanupResult> {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("Anonymous user retention must be greater than zero");
    }
    if (!Number.isFinite(now)) {
      throw new Error("Anonymous user cleanup time must be finite");
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error("Anonymous user cleanup batch size must be between 1 and 10000");
    }
    const cutoffTime = now - retentionMs;
    if (Math.abs(cutoffTime) > 8_640_000_000_000_000) {
      throw new Error("Anonymous user cleanup cutoff is outside the supported date range");
    }
    const cutoff = new Date(cutoffTime).toISOString();
    const deleted = await this.engine.transaction(async (session) => {
      const result = await session.query<{ id: string }>(
        `with expired as (
           select id from auth.users
           where is_anonymous = true and created_at < $1
           order by created_at, id
           limit $2
         )
         delete from auth.users as target
         using expired
         where target.id = expired.id and target.is_anonymous = true
         returning target.id`,
        [cutoff, batchSize],
        { maxRows: batchSize },
      );
      if (result.rows.length > 0) {
        await session.query(
          `insert into auth.audit_log(actor_role, action, metadata)
           values ('system', 'anonymous.cleanup', $1::text::jsonb)`,
          [JSON.stringify({ deleted: result.rows.length, cutoff, batch_size: batchSize })],
        );
      }
      return result.rows.length;
    });
    return { deleted, cutoff, batchSize };
  }

  async cleanupAuditLog(
    retentionMs: number,
    batchSize: number,
    now = Date.now(),
  ): Promise<AuditLogCleanupResult> {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("Auth audit log retention must be greater than zero");
    }
    if (!Number.isFinite(now)) {
      throw new Error("Auth audit log cleanup time must be finite");
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error("Auth audit log cleanup batch size must be between 1 and 10000");
    }
    const cutoffTime = now - retentionMs;
    if (Math.abs(cutoffTime) > 8_640_000_000_000_000) {
      throw new Error("Auth audit log cleanup cutoff is outside the supported date range");
    }
    const cutoff = new Date(cutoffTime).toISOString();
    const deleted = await this.engine.transaction(async (session) => {
      const result = await session.query<{ id: number }>(
        `with expired as (
           select id from auth.audit_log
           where created_at < $1
           order by created_at, id
           limit $2
         )
         delete from auth.audit_log as target
         using expired
         where target.id = expired.id
         returning target.id::int`,
        [cutoff, batchSize],
        { maxRows: batchSize },
      );
      if (result.rows.length > 0) {
        await session.query(
          `insert into auth.audit_log(actor_role, action, metadata)
           values ('system', 'audit.cleanup', $1::text::jsonb)`,
          [JSON.stringify({ deleted: result.rows.length, cutoff, batch_size: batchSize })],
        );
      }
      return result.rows.length;
    });
    return { deleted, cutoff, batchSize };
  }

  async resolveRequestContext(request: Request): Promise<RequestDatabaseContext> {
    const authorization = request.headers.get("authorization");
    if (authorization === null || !authorization.toLowerCase().startsWith("bearer ")) {
      return { role: "anon", claims: { role: "anon" } };
    }
    const token = authorization.slice(7).trim();
    const claims = await verifyJwt(token, this.secrets);
    if (claims.role === "authenticated") {
      await this.verifyActiveUserClaims(claims);
    }
    return { role: claims.role, claims };
  }

  async createRoleToken(role: "anon" | "service_role", lifetimeSeconds = 365 * 24 * 60 * 60) {
    const now = Math.floor(Date.now() / 1_000);
    return await signJwt(
      {
        role,
        aud: "authenticated",
        iat: now,
        exp: now + lifetimeSeconds,
      },
      activeAuthSigningKey(this.secrets),
    );
  }

  async createSignedObjectToken(
    bucket: string,
    object: string,
    lifetimeSeconds: number,
  ): Promise<string> {
    if (
      !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 ||
      lifetimeSeconds > 7 * 24 * 60 * 60
    ) {
      throw new Error("Signed URL lifetime must be between 1 second and 7 days");
    }
    const now = Math.floor(Date.now() / 1_000);
    return await signJwt(
      {
        role: "anon",
        aud: "storage",
        storage_bucket: bucket,
        storage_object: object,
        iat: now,
        exp: now + lifetimeSeconds,
      },
      activeAuthSigningKey(this.secrets),
    );
  }

  async verifySignedObjectToken(token: string, bucket: string, object: string): Promise<void> {
    const claims = await verifyJwt(token, this.secrets);
    if (
      claims.aud !== "storage" || claims.storage_bucket !== bucket ||
      claims.storage_object !== object
    ) {
      throw new Error("Signed URL token does not match this object");
    }
  }

  private async createSession(user: UserRow): Promise<AuthSessionResponse> {
    return await this.engine.transaction(async (session) => {
      return await this.createSessionInSession(session, user);
    });
  }

  private async createSessionInSession(
    session: DatabaseSession,
    user: UserRow,
    existingSessionId?: string,
  ): Promise<AuthSessionResponse> {
    const sessionId = existingSessionId ?? crypto.randomUUID();
    if (existingSessionId === undefined) {
      await session.query("insert into auth.sessions(id, user_id) values ($1, $2)", [
        sessionId,
        user.id,
      ]);
    } else {
      await session.query("update auth.sessions set updated_at = now() where id = $1", [sessionId]);
    }
    const refreshToken = randomToken(48);
    const refreshExpires = new Date(
      Date.now() + AuthService.REFRESH_TOKEN_SECONDS * 1_000,
    ).toISOString();
    await session.query(
      `insert into auth.refresh_tokens(token_hash, user_id, session_id, expires_at)
       values ($1, $2, $3, $4)`,
      [await sha256(refreshToken), user.id, sessionId, refreshExpires],
    );

    const now = Math.floor(Date.now() / 1_000);
    const claims: JwtClaims = {
      sub: user.id,
      role: "authenticated",
      aud: "authenticated",
      email: user.email ?? undefined,
      session_id: sessionId,
      is_anonymous: user.is_anonymous,
      iat: now,
      exp: now + AuthService.ACCESS_TOKEN_SECONDS,
    };
    return {
      access_token: await signJwt(claims, activeAuthSigningKey(this.secrets)),
      token_type: "bearer",
      expires_in: AuthService.ACCESS_TOKEN_SECONDS,
      expires_at: claims.exp,
      refresh_token: refreshToken,
      user: publicUser(user),
    };
  }

  private async verifyActiveUserToken(token: string): Promise<JwtClaims> {
    const claims = await verifyJwt(token, this.secrets);
    if (claims.role !== "authenticated" || claims.sub === undefined) {
      throw new Error("A user access token is required");
    }
    await this.verifyActiveUserClaims(claims);
    return claims;
  }

  private async verifyActiveUserClaims(claims: JwtClaims): Promise<void> {
    if (claims.sub === undefined || typeof claims.session_id !== "string") {
      throw new Error("JWT does not contain an active session");
    }
    const result = await this.engine.query<{ active: boolean }>(
      `select true as active
       from auth.sessions s
       join auth.users u on u.id = s.user_id
       where s.id = $1 and s.user_id = $2 and s.revoked_at is null
         and (u.banned_until is null or u.banned_until <= now())`,
      [claims.session_id, claims.sub],
    );
    if (result.rows[0]?.active !== true) {
      throw new Error("Session is invalid or revoked");
    }
  }

  private async requireSensitiveUpdateSession(
    session: DatabaseSession,
    claims: JwtClaims,
    requireRecent: boolean,
  ): Promise<void> {
    const result = await session.query<{ created_at: string }>(
      `select created_at from auth.sessions
       where id = $1 and user_id = $2 and revoked_at is null
       for update`,
      [claims.session_id, claims.sub],
    );
    const authenticatedAt = Date.parse(result.rows[0]?.created_at ?? "");
    if (!Number.isFinite(authenticatedAt)) {
      throw new Error("Session is invalid or revoked");
    }
    if (!requireRecent || this.security.reauthenticationWindowSeconds === 0) return;
    const earliestAllowed = Date.now() - this.security.reauthenticationWindowSeconds * 1_000;
    if (authenticatedAt < earliestAllowed) {
      throw new Error("Reauthentication required for email or password changes");
    }
  }

  private async userById(userId: string): Promise<UserRow> {
    const result = await this.engine.query<UserRow>(
      `select id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_anonymous, banned_until
       from auth.users where id = $1`,
      [userId],
    );
    if (result.rows[0] === undefined) {
      throw new Error("User not found");
    }
    return result.rows[0];
  }

  private async requireServiceRole(token: string): Promise<JwtClaims> {
    const claims = await verifyJwt(token, this.secrets);
    if (claims.role !== "service_role") {
      throw new Error("Service Role token is required");
    }
    return claims;
  }

  private async audit(
    actor: JwtClaims,
    action: string,
    targetUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.engine.transaction(async (session) => {
      await this.auditInSession(session, actor, action, targetUserId, metadata);
    });
  }

  private async auditInSession(
    session: DatabaseSession,
    actor: JwtClaims,
    action: string,
    targetUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await session.query(
      `insert into auth.audit_log(actor_role, actor_id, action, target_user_id, metadata)
       values ($1, $2, $3, $4, $5::text::jsonb)`,
      [actor.role, actor.sub ?? null, action, targetUserId, JSON.stringify(metadata)],
    );
  }
}

function parseBanDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(value.trim());
  if (match === null) {
    throw new Error("ban_duration must use a positive s, m, h, or d duration");
  }
  const amount = Number(match[1]);
  const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * units[match[2]!]!;
}
