import { dirname } from "@std/path";
import { hardenWindowsSecretAcl } from "../security/windows_acl.ts";
import type { JwtAsymmetricSigningKey, JwtKeyring, JwtSigningKey } from "./jwt.ts";

export interface LegacyAuthSecrets {
  jwtSecret: string;
}

export interface AuthHmacSigningKey extends JwtSigningKey {
  createdAt: string;
}

export interface AuthEs256SigningKey extends JwtAsymmetricSigningKey {
  createdAt: string;
}

export type AuthSigningKey = AuthHmacSigningKey | AuthEs256SigningKey;

export interface AuthSecrets extends JwtKeyring {
  formatVersion: 1;
  signingKeys: AuthSigningKey[];
}

export interface PublicAuthJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

export type AuthSecretsInput = AuthSecrets | LegacyAuthSecrets;

export async function loadOrCreateAuthSecrets(path: string): Promise<AuthSecrets> {
  let contents: string;
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink) throw new Error(`Auth secrets file must not be a symbolic link: ${path}`);
    if (!info.isFile) throw new Error(`Auth secrets path must be a regular file: ${path}`);
    await enforceAuthSecretPermissions(path, info);
    contents = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    const secrets = await createAuthSecrets();
    await writeAuthSecrets(path, secrets, true);
    return secrets;
  }
  const raw = JSON.parse(contents) as unknown;
  const normalized = normalizeAuthSecrets(raw);
  const migrated = await migrateLegacySigningKeys(normalized);
  if (isLegacyAuthSecrets(raw) || migrated !== normalized) {
    await writeAuthSecrets(path, migrated, false);
  }
  return migrated;
}

async function enforceAuthSecretPermissions(path: string, info: Deno.FileInfo): Promise<void> {
  if (Deno.build.os === "windows") {
    await hardenWindowsSecretAcl(path);
    return;
  }
  if (info.mode === null) return;
  if ((info.mode & 0o777) !== 0o600) await Deno.chmod(path, 0o600);
}

export function normalizeAuthSecrets(value: unknown): AuthSecrets {
  if (isLegacyAuthSecrets(value)) {
    const kid = "legacy";
    return {
      formatVersion: 1,
      activeKid: kid,
      signingKeys: [{
        kid,
        secret: value.jwtSecret,
        createdAt: new Date().toISOString(),
      }],
    } satisfies AuthSecrets;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Auth secrets must be a JSON object");
  }
  const candidate = value as Partial<AuthSecrets>;
  if (candidate.formatVersion !== 1) {
    throw new Error(`Unsupported Auth secrets format version: ${candidate.formatVersion}`);
  }
  if (typeof candidate.activeKid !== "string" || candidate.activeKid.length === 0) {
    throw new Error("Auth secrets activeKid must be a non-empty string");
  }
  if (!Array.isArray(candidate.signingKeys) || candidate.signingKeys.length === 0) {
    throw new Error("Auth secrets must contain at least one signing key");
  }
  const signingKeys = candidate.signingKeys.map((key) => validateSigningKey(key));
  if (new Set(signingKeys.map((key) => key.kid)).size !== signingKeys.length) {
    throw new Error("Auth signing key ids must be unique");
  }
  if (!signingKeys.some((key) => key.kid === candidate.activeKid)) {
    throw new Error(`Active Auth signing key does not exist: ${candidate.activeKid}`);
  }
  return {
    formatVersion: 1,
    activeKid: candidate.activeKid,
    signingKeys,
  };
}

export function activeAuthSigningKey(secrets: AuthSecrets): AuthSigningKey {
  const active = secrets.signingKeys.find((key) => key.kid === secrets.activeKid);
  if (active === undefined) {
    throw new Error(`Active Auth signing key does not exist: ${secrets.activeKid}`);
  }
  return active;
}

export async function rotateAuthSigningKey(path: string): Promise<{
  secrets: AuthSecrets;
  previousKid: string;
}> {
  const current = await loadOrCreateAuthSecrets(path);
  const next = await newEs256SigningKey();
  const secrets: AuthSecrets = {
    ...current,
    activeKid: next.kid,
    signingKeys: [...current.signingKeys, next],
  };
  await writeAuthSecrets(path, secrets, false);
  return { secrets, previousKid: current.activeKid };
}

export async function activateAuthSigningKey(path: string, kid: string): Promise<AuthSecrets> {
  const current = await loadOrCreateAuthSecrets(path);
  if (!current.signingKeys.some((key) => key.kid === kid)) {
    throw new Error(`Auth signing key does not exist: ${kid}`);
  }
  const secrets = { ...current, activeKid: kid };
  await writeAuthSecrets(path, secrets, false);
  return secrets;
}

export async function removeAuthSigningKey(path: string, kid: string): Promise<AuthSecrets> {
  const current = await loadOrCreateAuthSecrets(path);
  if (kid === current.activeKid) {
    throw new Error("Cannot remove the active Auth signing key");
  }
  const signingKeys = current.signingKeys.filter((key) => key.kid !== kid);
  if (signingKeys.length === current.signingKeys.length) {
    throw new Error(`Auth signing key does not exist: ${kid}`);
  }
  const secrets = { ...current, signingKeys };
  await writeAuthSecrets(path, secrets, false);
  return secrets;
}

export function publicAuthKeyring(secrets: AuthSecrets): {
  formatVersion: number;
  activeKid: string;
  keys: Array<{
    kid: string;
    algorithm: "HS256" | "ES256";
    createdAt: string;
    active: boolean;
  }>;
} {
  return {
    formatVersion: secrets.formatVersion,
    activeKid: secrets.activeKid,
    keys: secrets.signingKeys.map((key) => ({
      kid: key.kid,
      algorithm: "algorithm" in key ? key.algorithm : "HS256",
      createdAt: key.createdAt,
      active: key.kid === secrets.activeKid,
    })),
  };
}

export function publicAuthJwks(secrets: AuthSecrets): { keys: PublicAuthJwk[] } {
  return {
    keys: secrets.signingKeys.flatMap((key) => {
      if (!("algorithm" in key)) return [];
      const { crv, kty, x, y } = key.publicJwk;
      if (crv !== "P-256" || kty !== "EC" || x === undefined || y === undefined) {
        throw new Error(`Auth signing key ${key.kid} has an invalid ES256 public JWK`);
      }
      return [
        {
          kty,
          crv,
          x,
          y,
          kid: key.kid,
          alg: "ES256",
          use: "sig",
        } satisfies PublicAuthJwk,
      ];
    }),
  };
}

export function authSecretValues(secrets: AuthSecrets): string[] {
  return secrets.signingKeys.flatMap((key) => {
    if (!("algorithm" in key)) return [key.secret];
    return typeof key.privateJwk.d === "string" ? [key.privateJwk.d] : [];
  });
}

async function createAuthSecrets(): Promise<AuthSecrets> {
  const key = await newEs256SigningKey();
  return { formatVersion: 1, activeKid: key.kid, signingKeys: [key] };
}

async function migrateLegacySigningKeys(secrets: AuthSecrets): Promise<AuthSecrets> {
  if (secrets.signingKeys.some((key) => "algorithm" in key)) return secrets;
  const key = await newEs256SigningKey();
  return {
    ...secrets,
    activeKid: key.kid,
    signingKeys: [...secrets.signingKeys, key],
  };
}

async function newEs256SigningKey(): Promise<AuthEs256SigningKey> {
  const kid = crypto.randomUUID();
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    algorithm: "ES256",
    privateJwk: { ...privateJwk, alg: "ES256", kid, use: "sig" } as JsonWebKey,
    publicJwk: { ...publicJwk, alg: "ES256", kid, use: "sig" } as JsonWebKey,
    createdAt: new Date().toISOString(),
  };
}

function isLegacyAuthSecrets(value: unknown): value is LegacyAuthSecrets {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { jwtSecret?: unknown }).jwtSecret === "string" &&
    (value as { jwtSecret: string }).jwtSecret.length >= 32;
}

function validateSigningKey(value: unknown): AuthSigningKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Auth signing keys must be JSON objects");
  }
  const candidate = value as Record<string, unknown>;
  const kid = candidate.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    throw new Error("Auth signing key kid must be a non-empty string");
  }
  const createdAt = candidate.createdAt;
  if (typeof createdAt !== "string" || !Number.isFinite(new Date(createdAt).getTime())) {
    throw new Error(`Auth signing key ${kid} createdAt must be an ISO timestamp`);
  }
  if (candidate.algorithm === "ES256") {
    const privateJwk = validateEs256Jwk(candidate.privateJwk, kid, "private");
    const publicJwk = validateEs256Jwk(candidate.publicJwk, kid, "public");
    if (privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y) {
      throw new Error(`Auth signing key ${kid} public and private JWK coordinates do not match`);
    }
    return { kid, algorithm: "ES256", privateJwk, publicJwk, createdAt };
  }
  if (candidate.algorithm !== undefined) {
    throw new Error(`Auth signing key ${kid} uses an unsupported algorithm`);
  }
  if (typeof candidate.secret !== "string" || candidate.secret.length < 32) {
    throw new Error(`Auth signing key ${kid} secret must be at least 32 characters`);
  }
  return { kid, secret: candidate.secret, createdAt };
}

function validateEs256Jwk(value: unknown, kid: string, part: "private" | "public"): JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Auth signing key ${kid} ${part} JWK must be a JSON object`);
  }
  const jwk = value as JsonWebKey & { kid?: string };
  if (
    jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" ||
    jwk.x.length === 0 || typeof jwk.y !== "string" || jwk.y.length === 0
  ) {
    throw new Error(`Auth signing key ${kid} ${part} JWK is not a P-256 EC key`);
  }
  if (part === "private" && (typeof jwk.d !== "string" || jwk.d.length === 0)) {
    throw new Error(`Auth signing key ${kid} private JWK is missing its private value`);
  }
  if (part === "public" && jwk.d !== undefined) {
    throw new Error(`Auth signing key ${kid} public JWK must not contain a private value`);
  }
  if (jwk.alg !== undefined && jwk.alg !== "ES256") {
    throw new Error(`Auth signing key ${kid} ${part} JWK has an invalid algorithm`);
  }
  if (jwk.kid !== undefined && jwk.kid !== kid) {
    throw new Error(`Auth signing key ${kid} ${part} JWK has a mismatched key id`);
  }
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new Error(`Auth signing key ${kid} ${part} JWK has an invalid use`);
  }
  return { ...jwk };
}

async function writeAuthSecrets(
  path: string,
  secrets: AuthSecrets,
  createNew: boolean,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  if (createNew) {
    try {
      await Deno.writeTextFile(path, JSON.stringify(secrets, null, 2) + "\n", {
        createNew: true,
        mode: 0o600,
      });
      if (Deno.build.os === "windows") await hardenWindowsSecretAcl(path);
    } catch (error) {
      await Deno.remove(path).catch(() => undefined);
      throw error;
    }
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, JSON.stringify(secrets, null, 2) + "\n", {
      createNew: true,
      mode: 0o600,
    });
    if (Deno.build.os === "windows") await hardenWindowsSecretAcl(temporary);
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}
