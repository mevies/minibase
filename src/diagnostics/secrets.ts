import { join } from "@std/path";
import type { MinibaseConfig } from "../config/types.ts";
import { parseFunctionEnvironmentFile } from "../functions/environment.ts";
import type { DiagnosticResult } from "./types.ts";

const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const SECRET_VARIABLE_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|SERVICE_ROLE_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/u;
const DATABASE_URL_VARIABLE_NAME = /(?:^|_)DATABASE_URL$/u;
const PLACEHOLDER_VALUE =
  /(?:example|placeholder|change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(?:api[-_ ]?)?(?:key|secret|token|password)|dummy|sample|insert[-_ ]?(?:key|secret|token|password))/iu;

type CredentialRisk = "missing" | "placeholder" | "weak";

export async function secretQualityChecks(
  config: MinibaseConfig,
): Promise<DiagnosticResult[]> {
  const checks: DiagnosticResult[] = [];
  checks.push(
    ...await environmentFileQualityChecks(
      "secrets.env.root",
      "project .env",
      join(config.project.root, ".env"),
    ),
  );
  checks.push(
    ...await environmentFileQualityChecks(
      "secrets.env.functions",
      "Functions .env",
      join(config.project.functionsDir, ".env"),
    ),
  );
  if (config.auth.jwtSecret === undefined) {
    checks.push(...await authSecretQualityChecks(config.project.secretsFile));
  } else {
    checks.push(...authKeyValueChecks(config.auth.jwtSecret, "external Auth signing key"));
  }
  checks.push(...s3CredentialQualityChecks(config));
  checks.push(...databaseCredentialQualityChecks(config));
  return checks;
}

async function environmentFileQualityChecks(
  code: string,
  label: string,
  path: string,
): Promise<DiagnosticResult[]> {
  const read = await readBoundedRegularFile(code, label, path);
  if (read.contents === null) return read.checks;

  let values: Record<string, string>;
  try {
    values = parseFunctionEnvironmentFile(read.contents, path);
  } catch {
    return [...read.checks, {
      code: `${code}.quality.parse`,
      severity: "warning",
      message: `${label} could not be parsed for Secret quality checks`,
      fix: "Use NAME=value entries with valid quoting, then rerun doctor.",
      file: path,
    }];
  }

  const checks = [...read.checks];
  for (
    const [name, value] of Object.entries(values).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) {
    const normalizedName = name.toUpperCase();
    if (DATABASE_URL_VARIABLE_NAME.test(normalizedName)) {
      checks.push(...urlPasswordChecks(`${code}.database_url`, name, value, path));
      continue;
    }
    if (!SECRET_VARIABLE_NAME.test(normalizedName)) continue;
    const risk = credentialRisk(value, 16);
    if (risk === null) continue;
    checks.push({
      code: `${code}.value.${risk}`,
      severity: "warning",
      message: `${name} in ${label} has a ${riskDescription(risk)} value`,
      fix: credentialFix(risk),
      file: path,
    });
  }
  return checks;
}

async function authSecretQualityChecks(path: string): Promise<DiagnosticResult[]> {
  const read = await readBoundedRegularFile("secrets.auth", "Auth secrets", path);
  if (read.missing) {
    return [...read.checks, {
      code: "secrets.auth.uninitialized",
      severity: "info",
      message: "Auth secrets are not initialized yet",
      fix: "Start Minibase once to create a random Auth signing key.",
      file: path,
    }];
  }
  if (read.contents === null) return read.checks;

  let raw: unknown;
  try {
    raw = JSON.parse(read.contents);
  } catch {
    return [...read.checks, {
      code: "secrets.auth.quality.parse",
      severity: "error",
      message: "Auth secrets are not valid JSON",
      fix: "Restore the Auth Secret file from a trusted backup without printing its contents.",
      file: path,
    }];
  }
  if (!isRecord(raw)) {
    return [...read.checks, missingAuthStructure(path, "Auth secrets must be a JSON object")];
  }

  if ("jwtSecret" in raw) {
    return [...read.checks, ...authKeyValueChecks(raw.jwtSecret, "legacy JWT key", path)];
  }

  const checks = [...read.checks];
  if (typeof raw.activeKid !== "string" || raw.activeKid.length === 0) {
    checks.push(missingAuthStructure(path, "Auth secrets are missing activeKid"));
  }
  if (!Array.isArray(raw.signingKeys) || raw.signingKeys.length === 0) {
    checks.push(missingAuthStructure(path, "Auth secrets are missing signing keys"));
    return checks;
  }

  const privateValues: string[] = [];
  const kids = new Set<string>();
  let activeKidPresent = false;
  for (let index = 0; index < raw.signingKeys.length; index++) {
    const key = raw.signingKeys[index];
    if (!isRecord(key)) {
      checks.push(missingAuthStructure(path, `Auth signing key ${index + 1} is invalid`));
      continue;
    }
    if (typeof key.kid === "string" && key.kid.length > 0) {
      if (kids.has(key.kid)) {
        checks.push({
          code: "secrets.auth.kid.duplicate",
          severity: "error",
          message: "Auth signing key ids are not unique",
          fix: "Assign a unique id to every signing key and preserve activeKid.",
          file: path,
        });
      }
      kids.add(key.kid);
      if (key.kid === raw.activeKid) activeKidPresent = true;
    } else {
      checks.push(missingAuthStructure(path, `Auth signing key ${index + 1} is missing its id`));
    }
    if (key.algorithm === "ES256") {
      checks.push(...await authEs256KeyChecks(key, index + 1, path));
      if (isRecord(key.privateJwk) && typeof key.privateJwk.d === "string") {
        privateValues.push(key.privateJwk.d);
      }
    } else if (key.algorithm !== undefined) {
      checks.push(
        invalidAuthJwk(path, `Auth signing key ${index + 1} uses an unsupported algorithm`),
      );
    } else {
      checks.push(...authKeyValueChecks(key.secret, `Auth signing key ${index + 1}`, path));
      if (typeof key.secret === "string" && key.secret.length > 0) {
        privateValues.push(key.secret);
      }
    }
    if (
      typeof key.createdAt !== "string" ||
      !Number.isFinite(new Date(key.createdAt).getTime())
    ) {
      checks.push(missingAuthStructure(
        path,
        `Auth signing key ${index + 1} is missing a valid creation timestamp`,
      ));
    }
  }
  if (typeof raw.activeKid === "string" && raw.activeKid.length > 0 && !activeKidPresent) {
    checks.push(missingAuthStructure(path, "activeKid does not reference a signing key"));
  }
  if (new Set(privateValues).size !== privateValues.length) {
    checks.push({
      code: "secrets.auth.key.duplicate",
      severity: "error",
      message: "Auth signing keys reuse the same Secret value",
      fix: "Rotate the active signing key and remove duplicated retired keys after tokens expire.",
      file: path,
    });
  }
  return checks;
}

async function authEs256KeyChecks(
  key: Record<string, unknown>,
  index: number,
  path: string,
): Promise<DiagnosticResult[]> {
  const privateJwk = key.privateJwk;
  const publicJwk = key.publicJwk;
  if (!isRecord(privateJwk) || !isRecord(publicJwk)) {
    return [invalidAuthJwk(path, `Auth signing key ${index} is missing its ES256 JWK pair`)];
  }
  const kid = typeof key.kid === "string" ? key.kid : undefined;
  if (
    privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" ||
    typeof privateJwk.x !== "string" || typeof privateJwk.y !== "string" ||
    typeof privateJwk.d !== "string" ||
    publicJwk.kty !== "EC" || publicJwk.crv !== "P-256" ||
    typeof publicJwk.x !== "string" || typeof publicJwk.y !== "string" ||
    publicJwk.d !== undefined || privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y ||
    (privateJwk.alg !== undefined && privateJwk.alg !== "ES256") ||
    (publicJwk.alg !== undefined && publicJwk.alg !== "ES256") ||
    (privateJwk.kid !== undefined && privateJwk.kid !== kid) ||
    (publicJwk.kid !== undefined && publicJwk.kid !== kid) ||
    (privateJwk.use !== undefined && privateJwk.use !== "sig") ||
    (publicJwk.use !== undefined && publicJwk.use !== "sig")
  ) {
    return [invalidAuthJwk(path, `Auth signing key ${index} has an invalid ES256 JWK pair`)];
  }
  const privateRisk = credentialRisk(privateJwk.d, 32);
  if (privateRisk !== null) {
    return [{
      code: `secrets.auth.key.${privateRisk}`,
      severity: "error",
      message: `Auth signing key ${index} has a ${riskDescription(privateRisk)} private value`,
      fix: "Rotate the Auth signing key to a newly generated ES256 key.",
      file: path,
    }];
  }
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const probe = new TextEncoder().encode("minibase-auth-key-diagnostic");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      probe,
    );
    if (
      !await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        probe,
      )
    ) {
      return [
        invalidAuthJwk(path, `Auth signing key ${index} public and private keys do not match`),
      ];
    }
  } catch {
    return [invalidAuthJwk(path, `Auth signing key ${index} cannot be imported as ES256`)];
  }
  return [];
}

function invalidAuthJwk(path: string, message: string): DiagnosticResult {
  return {
    code: "secrets.auth.jwk.invalid",
    severity: "error",
    message,
    fix: "Restore the Auth Secret file from a trusted backup or rotate the affected key.",
    file: path,
  };
}

function authKeyValueChecks(
  value: unknown,
  label: string,
  path?: string,
): DiagnosticResult[] {
  if (typeof value !== "string") {
    return [missingAuthStructure(path, `${label} is missing its Secret value`)];
  }
  const risk = credentialRisk(value, 32);
  if (risk === null) return [];
  return [{
    code: `secrets.auth.key.${risk}`,
    severity: "error",
    message: `${label} has a ${riskDescription(risk)} value`,
    fix: risk === "missing"
      ? "Restore or rotate the missing Auth signing key before starting Minibase."
      : "Rotate the Auth signing key to a newly generated random value.",
    file: path,
  }];
}

function missingAuthStructure(path: string | undefined, message: string): DiagnosticResult {
  return {
    code: "secrets.auth.key.missing",
    severity: "error",
    message,
    fix: "Restore the Auth Secret file from a trusted backup or reinitialize Auth intentionally.",
    file: path,
  };
}

function s3CredentialQualityChecks(config: MinibaseConfig): DiagnosticResult[] {
  if (config.storage.driver !== "s3") return [];
  const s3 = config.storage.s3;
  if (s3 === undefined) {
    return [{
      code: "secrets.s3.credentials.missing",
      severity: "error",
      message: "S3 storage is selected but its credentials are incomplete",
      fix: "Configure the S3 access key id and Secret access key through protected inputs.",
    }];
  }
  const checks: DiagnosticResult[] = [];
  const accessRisk = credentialRisk(s3.accessKeyId, 1);
  if (accessRisk === "missing" || accessRisk === "placeholder") {
    checks.push({
      code: `secrets.s3.access_key_id.${accessRisk}`,
      severity: accessRisk === "missing" ? "error" : "warning",
      message: `S3 access key id has a ${riskDescription(accessRisk)} value`,
      fix: "Provide a real S3 access key id through an environment variable or Secret file.",
    });
  }
  const secretRisk = credentialRisk(s3.secretAccessKey, 16);
  if (secretRisk !== null) {
    checks.push({
      code: `secrets.s3.secret_access_key.${secretRisk}`,
      severity: "error",
      message: `S3 Secret access key has a ${riskDescription(secretRisk)} value`,
      fix: credentialFix(secretRisk),
    });
  }
  if (s3.sessionToken !== undefined) {
    const tokenRisk = credentialRisk(s3.sessionToken, 16);
    if (tokenRisk !== null) {
      checks.push({
        code: `secrets.s3.session_token.${tokenRisk}`,
        severity: tokenRisk === "missing" ? "error" : "warning",
        message: `S3 session token has a ${riskDescription(tokenRisk)} value`,
        fix: credentialFix(tokenRisk),
      });
    }
  }
  return checks;
}

function databaseCredentialQualityChecks(config: MinibaseConfig): DiagnosticResult[] {
  if (config.database.url === undefined) return [];
  return urlPasswordChecks(
    "secrets.database.url",
    "configured PostgreSQL URL",
    config.database.url,
  );
}

function urlPasswordChecks(
  code: string,
  label: string,
  value: string,
  file?: string,
): DiagnosticResult[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [{
      code: `${code}.invalid`,
      severity: "warning",
      message: `${label} could not be inspected for password quality`,
      fix: "Use a valid PostgreSQL connection URL and keep it in a protected Secret source.",
      file,
    }];
  }
  const password = safelyDecodeUrlComponent(url.password);
  const risk = credentialRisk(password, 12);
  if (risk === null) return [];
  return [{
    code: `${code}.password.${risk}`,
    severity: "warning",
    message: `${label} has a ${riskDescription(risk)} password`,
    fix: risk === "missing"
      ? "Configure password authentication unless the database intentionally uses another secured mechanism."
      : "Replace the database password with a strong random value from a protected Secret source.",
    file,
  }];
}

function safelyDecodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function credentialRisk(value: string, minimumLength: number): CredentialRisk | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "missing";
  if (isPlaceholderValue(trimmed)) return "placeholder";
  if (trimmed.length < minimumLength || new Set(trimmed).size < Math.min(6, minimumLength)) {
    return "weak";
  }
  return null;
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return PLACEHOLDER_VALUE.test(normalized) ||
    /^(?:password|secret|token|key|none|null|undefined|todo|tbd)$/u.test(normalized) ||
    /^(?:x+|0+|1+|a+)$/u.test(normalized);
}

function riskDescription(risk: CredentialRisk): string {
  if (risk === "missing") return "missing or blank";
  if (risk === "placeholder") return "placeholder or example";
  return "weak";
}

function credentialFix(risk: CredentialRisk): string {
  return risk === "missing"
    ? "Provide the missing value through a protected Secret source."
    : "Replace it with a strong random value from a protected Secret source.";
}

async function readBoundedRegularFile(
  code: string,
  label: string,
  path: string,
): Promise<{ contents: string | null; checks: DiagnosticResult[]; missing: boolean }> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { contents: null, checks: [], missing: true };
    }
    return {
      contents: null,
      missing: false,
      checks: [{
        code: `${code}.quality.read`,
        severity: "warning",
        message: `${label} could not be read for Secret quality checks`,
        fix: "Inspect the file and parent directory permissions, then rerun doctor.",
        file: path,
      }],
    };
  }
  if (info.isSymlink || !info.isFile) {
    return { contents: null, checks: [], missing: false };
  }
  if (info.size > MAX_SECRET_FILE_BYTES) {
    return {
      contents: null,
      missing: false,
      checks: [{
        code: `${code}.quality.size`,
        severity: "warning",
        message: `${label} exceeds the 1 MiB Secret quality inspection limit`,
        fix: "Keep Secret files small and split unrelated configuration into separate files.",
        file: path,
      }],
    };
  }
  try {
    return { contents: await Deno.readTextFile(path), checks: [], missing: false };
  } catch {
    return {
      contents: null,
      missing: false,
      checks: [{
        code: `${code}.quality.read`,
        severity: "warning",
        message: `${label} could not be read for Secret quality checks`,
        fix: "Inspect the file and parent directory permissions, then rerun doctor.",
        file: path,
      }],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
