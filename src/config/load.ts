import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { parse } from "smol-toml";
import { parseFunctionEnvironmentFile } from "../functions/environment.ts";
import type { ProjectPaths } from "../project/types.ts";
import { createTrustedProxyMatcher } from "../server/trusted_proxy.ts";
import {
  normalizeAllowedHosts,
  validateFunctionNetworkOverride,
} from "../functions/network_policy.ts";
import type {
  ConfigOverrides,
  ConfigValueSource,
  DatabaseEngineName,
  FunctionNetworkOverride,
  FunctionRateLimitConfig,
  FunctionRateLimitOverride,
  LogFormat,
  MinibaseConfig,
  OutboundNetworkMode,
  StorageDriverName,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export const MINIBASE_CONFIG_FORMAT_VERSION = 1;

const EXTERNAL_SECRET_VARIABLES = new Set([
  "MINIBASE_AUTH_JWT_SECRET",
  "MINIBASE_DATABASE_URL",
  "MINIBASE_S3_ACCESS_KEY_ID",
  "MINIBASE_S3_SECRET_ACCESS_KEY",
  "MINIBASE_S3_SESSION_TOKEN",
]);
const MAX_EXTERNAL_SECRET_FILE_BYTES = 1024 * 1024;

interface ConfigChoice<T> {
  value: T | undefined;
  source: ConfigValueSource;
}

interface MigratedConfig {
  value: UnknownRecord;
  sourceVersion: number;
  migrations: string[];
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length === 0 || (path !== ".." && !path.startsWith("../") &&
    !path.startsWith("..\\") && !isAbsolute(path));
}

async function nearestExistingRealPath(path: string): Promise<string | undefined> {
  let candidate = path;
  while (true) {
    try {
      return await Deno.realPath(candidate);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

async function resolveFunctionPath(
  project: ProjectPaths,
  configuredPath: string,
  label: string,
): Promise<string> {
  const candidate = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(project.supabaseDir, configuredPath);
  if (
    candidate === resolve(project.functionsDir) ||
    !pathIsWithin(project.functionsDir, candidate)
  ) {
    throw new Error(`${label} must resolve inside ${project.functionsDir}`);
  }
  try {
    const functionsRoot = await Deno.realPath(project.functionsDir);
    const realCandidate = await nearestExistingRealPath(candidate);
    if (realCandidate !== undefined && !pathIsWithin(functionsRoot, realCandidate)) {
      throw new Error(`${label} must not escape ${project.functionsDir} through a link`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return candidate;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return [...value];
}

async function readToml(path: string | null): Promise<UnknownRecord> {
  if (path === null) return {};
  return asRecord(parse(await Deno.readTextFile(path)));
}

async function readExternalSecretEnvironment(path: string): Promise<Record<string, string>> {
  const pathInfo = await Deno.stat(path);
  if (!pathInfo.isFile) throw new Error("secrets.file must reference a regular file");
  if (pathInfo.size > MAX_EXTERNAL_SECRET_FILE_BYTES) {
    throw new Error("secrets.file must not exceed 1 MiB");
  }

  const file = await Deno.open(path, { read: true });
  let contents: string;
  try {
    const openInfo = await file.stat();
    if (!openInfo.isFile) throw new Error("secrets.file must reference a regular file");
    if (openInfo.size > MAX_EXTERNAL_SECRET_FILE_BYTES) {
      throw new Error("secrets.file must not exceed 1 MiB");
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_EXTERNAL_SECRET_FILE_BYTES) {
        throw new Error("secrets.file must not exceed 1 MiB");
      }
      chunks.push(buffer.slice(0, bytesRead));
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    contents = new TextDecoder().decode(bytes);
  } finally {
    file.close();
  }

  const values = parseFunctionEnvironmentFile(contents, path);
  for (const name of Object.keys(values)) {
    if (!EXTERNAL_SECRET_VARIABLES.has(name)) {
      throw new Error(`secrets.file contains unsupported variable ${name}`);
    }
  }
  return values;
}

function migrateMinibaseConfig(
  raw: UnknownRecord,
  path: string | null,
): MigratedConfig {
  if (path === null) {
    return { value: raw, sourceVersion: MINIBASE_CONFIG_FORMAT_VERSION, migrations: [] };
  }
  const declared = raw.format_version;
  if (declared !== undefined && (!Number.isInteger(declared) || (declared as number) < 0)) {
    throw new Error("minibase.toml format_version must be a non-negative integer");
  }
  const sourceVersion = declared === undefined ? 0 : declared as number;
  if (sourceVersion > MINIBASE_CONFIG_FORMAT_VERSION) {
    throw new Error(
      `minibase.toml format_version ${sourceVersion} is newer than supported version ${MINIBASE_CONFIG_FORMAT_VERSION}`,
    );
  }

  let version = sourceVersion;
  let value = { ...raw };
  const migrations: string[] = [];
  while (version < MINIBASE_CONFIG_FORMAT_VERSION) {
    if (version === 0) {
      value = { ...value, format_version: 1 };
      migrations.push("0->1: normalize legacy unversioned minibase.toml");
      version = 1;
      continue;
    }
    throw new Error(`No Minibase config migration exists from format_version ${version}`);
  }
  return { value, sourceVersion, migrations };
}

function choose<T>(
  key: string,
  choices: ConfigChoice<T>[],
  fallback: T,
  sources: Record<string, ConfigValueSource>,
): T {
  for (const choice of choices) {
    if (choice.value !== undefined) {
      sources[key] = choice.source;
      return choice.value;
    }
  }
  sources[key] = "default";
  return fallback;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeCorsOrigins(origins: string[]): string[] {
  const normalized = origins.map((origin) => {
    if (origin === "*") return origin;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`server.cors.allowed_origins contains an invalid origin: ${origin}`);
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) || parsed.username.length > 0 ||
      parsed.password.length > 0 || parsed.pathname !== "/" || parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error(`server.cors.allowed_origins must contain HTTP(S) origins: ${origin}`);
    }
    return parsed.origin;
  });
  return [...new Set(normalized)];
}

function parseEngine(value: unknown): DatabaseEngineName | undefined {
  return value === "pglite" || value === "postgres" ? value : undefined;
}

function parseStorageDriver(value: unknown): StorageDriverName | undefined {
  return value === "local" || value === "s3" ? value : undefined;
}

function parseOutbound(value: unknown): OutboundNetworkMode | undefined {
  return value === "allow" || value === "allowlist" || value === "deny" ? value : undefined;
}

function parseLogFormat(value: unknown): LogFormat | undefined {
  return value === "human" || value === "json" ? value : undefined;
}

function configuredLogFormat(value: unknown, key: string): LogFormat | undefined {
  if (value === undefined) return undefined;
  const parsed = parseLogFormat(value);
  if (parsed === undefined) throw new Error(`${key} must be human or json`);
  return parsed;
}

function configuredOutbound(value: unknown, key: string): OutboundNetworkMode | undefined {
  if (value === undefined) return undefined;
  const parsed = parseOutbound(value);
  if (parsed === undefined) throw new Error(`${key} must be allow, allowlist or deny`);
  return parsed;
}

function configuredStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = stringArray(value);
  if (parsed === undefined) throw new Error(`${key} must be an array of strings`);
  return parsed;
}

function configuredBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  const parsed = booleanValue(value);
  if (parsed === undefined) throw new Error(`${key} must be a boolean`);
  return parsed;
}

function configuredInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = numberValue(value);
  if (parsed === undefined) throw new Error(`${key} must be an integer`);
  return parsed;
}

function environmentInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer`);
  return parsed;
}

function environmentBoolean(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  const parsed = parseBoolean(value);
  if (parsed === undefined) throw new Error(`${key} must be true, false, 1 or 0`);
  return parsed;
}

function validateS3Config(config: NonNullable<MinibaseConfig["storage"]["s3"]>): void {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("storage.s3.endpoint must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) || endpoint.hostname.length === 0 ||
    endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error(
      "storage.s3.endpoint must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(config.bucket)) {
    throw new Error("storage.s3.bucket must be a valid bucket name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(config.region)) {
    throw new Error(
      "storage.s3.region must contain only letters, numbers, dots, underscores or hyphens",
    );
  }
  if (config.accessKeyId.trim().length === 0 || config.secretAccessKey.trim().length === 0) {
    throw new Error("storage.s3 credentials must not be blank");
  }
  if (config.sessionToken !== undefined && config.sessionToken.trim().length === 0) {
    throw new Error("storage.s3.session_token must not be blank");
  }
}

function validateFunctionRateLimitValue(value: number, key: string): void {
  if (value < 0 || value > 1_000_000) {
    throw new Error(`${key} must be between 0 and 1000000`);
  }
}

function validateFunctionRateLimitWindow(value: number, key: string): void {
  if (value < 100 || value > 3_600_000) {
    throw new Error(`${key} must be between 100 and 3600000`);
  }
}

function validateFunctionRateLimit(
  config: FunctionRateLimitConfig,
  key: string,
): void {
  validateFunctionRateLimitWindow(config.windowMs, `${key}.window_ms`);
  validateFunctionRateLimitValue(config.perIp, `${key}.per_ip`);
  validateFunctionRateLimitValue(config.perFunction, `${key}.per_function`);
  validateFunctionRateLimitValue(config.perIdentity, `${key}.per_identity`);
  if (config.maxKeys < 100 || config.maxKeys > 1_000_000) {
    throw new Error(`${key}.max_keys must be between 100 and 1000000`);
  }
}

function validateFunctionRateLimitOverride(
  config: FunctionRateLimitOverride,
  key: string,
): void {
  if (config.windowMs !== undefined) {
    validateFunctionRateLimitWindow(config.windowMs, `${key}.window_ms`);
  }
  if (config.perIp !== undefined) {
    validateFunctionRateLimitValue(config.perIp, `${key}.per_ip`);
  }
  if (config.perFunction !== undefined) {
    validateFunctionRateLimitValue(config.perFunction, `${key}.per_function`);
  }
  if (config.perIdentity !== undefined) {
    validateFunctionRateLimitValue(config.perIdentity, `${key}.per_identity`);
  }
}

function validateAuthRateLimit(config: MinibaseConfig["auth"]["rateLimit"]): void {
  validateFunctionRateLimitWindow(config.windowMs, "auth.rate_limit.window_ms");
  for (
    const [key, value] of Object.entries({
      signup_per_ip: config.signupPerIp,
      password_per_ip: config.passwordPerIp,
      refresh_per_ip: config.refreshPerIp,
      update_per_ip: config.updatePerIp,
      update_per_identity: config.updatePerIdentity,
    })
  ) {
    validateFunctionRateLimitValue(value, `auth.rate_limit.${key}`);
  }
  if (config.maxKeys < 100 || config.maxKeys > 1_000_000) {
    throw new Error("auth.rate_limit.max_keys must be between 100 and 1000000");
  }
}

function validate(config: MinibaseConfig): void {
  if (config.server.host.trim().length === 0) {
    throw new Error("server.host must not be empty");
  }
  if (config.server.port < 1 || config.server.port > 65_535) {
    throw new Error(`server.port must be between 1 and 65535, got ${config.server.port}`);
  }
  if ((config.server.tls?.certFile === undefined) !== (config.server.tls?.keyFile === undefined)) {
    throw new Error("server.tls requires both cert_file and key_file");
  }
  if (
    config.server.request.maxBodyBytes < 1_024 || config.server.request.maxBodyBytes > 1024 ** 3
  ) {
    throw new Error("server.request.max_body_bytes must be between 1024 and 1073741824");
  }
  if (config.server.request.timeoutMs < 100 || config.server.request.timeoutMs > 3_600_000) {
    throw new Error("server.request.timeout_ms must be between 100 and 3600000");
  }
  if (config.server.request.maxConcurrent < 1 || config.server.request.maxConcurrent > 100_000) {
    throw new Error("server.request.max_concurrent must be between 1 and 100000");
  }
  createTrustedProxyMatcher(config.server.trustedProxies);
  if (config.database.transactionTimeoutMs < 0) {
    throw new Error("database.transaction_timeout_ms must be zero or greater");
  }
  if (config.database.longTransactionWarningMs < 0) {
    throw new Error("database.long_transaction_warning_ms must be zero or greater");
  }
  if (config.database.poolMin < 0) {
    throw new Error("database.pool_min must be zero or greater");
  }
  if (config.database.poolMax < 1) {
    throw new Error("database.pool_max must be at least one");
  }
  if (config.database.poolMin > config.database.poolMax) {
    throw new Error("database.pool_min must not exceed database.pool_max");
  }
  if (config.database.connectTimeoutMs < 1) {
    throw new Error("database.connect_timeout_ms must be at least one millisecond");
  }
  if (config.functions.outbound === "allowlist" && config.functions.allowedHosts.length === 0) {
    throw new Error("functions.network.allowed_hosts must not be empty when outbound is allowlist");
  }
  if (
    config.functions.runtime.workersPerFunction < 1 ||
    config.functions.runtime.workersPerFunction > 16
  ) {
    throw new Error("functions.runtime.workers_per_function must be between 1 and 16");
  }
  validateFunctionRateLimit(config.functions.rateLimit, "functions.rate_limit");
  for (const [name, definition] of Object.entries(config.functions.definitions)) {
    if (definition.rateLimit !== undefined) {
      validateFunctionRateLimitOverride(definition.rateLimit, `functions.${name}.rate_limit`);
    }
  }
  if (config.functions.logs.maxBytes < 1_024 || config.functions.logs.maxBytes > 1024 ** 3) {
    throw new Error("logging.functions.max_bytes must be between 1024 and 1073741824");
  }
  if (config.functions.logs.retentionFiles < 0 || config.functions.logs.retentionFiles > 100) {
    throw new Error("logging.functions.retention_files must be between 0 and 100");
  }
  if (config.logging.maxBytes < 1_024 || config.logging.maxBytes > 1024 ** 3) {
    throw new Error("logging.max_bytes must be between 1024 and 1073741824");
  }
  if (config.logging.retentionFiles < 0 || config.logging.retentionFiles > 100) {
    throw new Error("logging.retention_files must be between 0 and 100");
  }
  if (config.auth.anonymousCleanup.retentionHours < 1) {
    throw new Error("auth.anonymous_cleanup.retention_hours must be at least one hour");
  }
  if (config.auth.anonymousCleanup.retentionHours > 10 * 365 * 24) {
    throw new Error("auth.anonymous_cleanup.retention_hours must not exceed ten years");
  }
  if (config.auth.anonymousCleanup.intervalMinutes < 1) {
    throw new Error("auth.anonymous_cleanup.interval_minutes must be at least one minute");
  }
  if (config.auth.anonymousCleanup.intervalMinutes > 35_791) {
    throw new Error("auth.anonymous_cleanup.interval_minutes must not exceed 35791 minutes");
  }
  if (
    config.auth.anonymousCleanup.batchSize < 1 ||
    config.auth.anonymousCleanup.batchSize > 10_000
  ) {
    throw new Error("auth.anonymous_cleanup.batch_size must be between 1 and 10000");
  }
  if (config.auth.passwordPolicy.minLength < 6 || config.auth.passwordPolicy.minLength > 128) {
    throw new Error("auth.password.min_length must be between 6 and 128");
  }
  if (
    config.auth.passwordPolicy.maxLength < config.auth.passwordPolicy.minLength ||
    config.auth.passwordPolicy.maxLength > 1_024
  ) {
    throw new Error("auth.password.max_length must be between min_length and 1024");
  }
  if (
    config.auth.reauthenticationWindowSeconds < 0 ||
    config.auth.reauthenticationWindowSeconds > 86_400
  ) {
    throw new Error("auth.reauthentication_window_seconds must be between 0 and 86400");
  }
  validateAuthRateLimit(config.auth.rateLimit);
  if (config.auth.auditLog.retentionDays < 1 || config.auth.auditLog.retentionDays > 3_650) {
    throw new Error("auth.audit_log.retention_days must be between 1 and 3650");
  }
  if (
    config.auth.auditLog.intervalMinutes < 1 ||
    config.auth.auditLog.intervalMinutes > 35_791
  ) {
    throw new Error("auth.audit_log.interval_minutes must be between 1 and 35791");
  }
  if (config.auth.auditLog.batchSize < 1 || config.auth.auditLog.batchSize > 10_000) {
    throw new Error("auth.audit_log.batch_size must be between 1 and 10000");
  }
  if (config.auth.jwtSecret !== undefined && config.auth.jwtSecret.length < 32) {
    throw new Error("MINIBASE_AUTH_JWT_SECRET must be at least 32 characters");
  }
  if (config.storage.driver === "s3" && config.storage.s3 === undefined) {
    throw new Error(
      "S3 storage requires endpoint, region, bucket, access key id and secret access key",
    );
  }
  if (config.storage.s3 !== undefined) validateS3Config(config.storage.s3);
}

export async function loadConfig(
  project: ProjectPaths,
  overrides: ConfigOverrides = {},
  env: Record<string, string> = Deno.env.toObject(),
): Promise<MinibaseConfig> {
  const supabase = await readToml(project.supabaseConfigFile);
  const migrated = migrateMinibaseConfig(
    await readToml(project.minibaseConfigFile),
    project.minibaseConfigFile,
  );
  const minibase = migrated.value;
  const secrets = asRecord(minibase.secrets);
  if (env.MINIBASE_SECRETS_FILE !== undefined && env.MINIBASE_SECRETS_FILE.trim().length === 0) {
    throw new Error("MINIBASE_SECRETS_FILE must not be blank");
  }
  const configuredSecretFile = env.MINIBASE_SECRETS_FILE ?? stringValue(secrets.file);
  const secretFile = configuredSecretFile === undefined
    ? undefined
    : isAbsolute(configuredSecretFile)
    ? resolve(configuredSecretFile)
    : resolve(join(project.root, configuredSecretFile));
  const secretEnvironment = secretFile === undefined
    ? {}
    : await readExternalSecretEnvironment(secretFile);
  const sources: Record<string, ConfigValueSource> = {
    format_version: project.minibaseConfigFile === null ? "default" : "minibase.toml",
  };
  if (secretFile !== undefined) {
    sources["secrets.file"] = env.MINIBASE_SECRETS_FILE !== undefined
      ? "environment"
      : "minibase.toml";
  }
  const supabaseApi = asRecord(supabase.api);
  const supabaseDb = asRecord(supabase.db);
  const supabaseSeed = asRecord(supabaseDb.seed);
  const supabaseFunctions = asRecord(supabase.functions);
  const server = asRecord(minibase.server);
  const serverRequest = asRecord(server.request);
  const cors = asRecord(server.cors);
  const tls = asRecord(server.tls);
  const database = asRecord(minibase.database);
  const storage = asRecord(minibase.storage);
  const s3 = asRecord(storage.s3);
  const minibaseFunctions = asRecord(minibase.functions);
  const functionRuntime = asRecord(minibaseFunctions.runtime);
  const functionRateLimit = asRecord(minibaseFunctions.rate_limit);
  const logging = asRecord(minibase.logging);
  const functionLogs = asRecord(logging.functions);
  const auth = asRecord(minibase.auth);
  const anonymousCleanup = asRecord(auth.anonymous_cleanup);
  const authPassword = asRecord(auth.password);
  const authRateLimit = asRecord(auth.rate_limit);
  const authAuditLog = asRecord(auth.audit_log);
  const network = asRecord(minibaseFunctions.network);
  const seed = asRecord(minibase.seed);

  const projectId = choose(
    "project_id",
    [{ value: stringValue(supabase.project_id), source: "supabase/config.toml" }],
    project.root.split(/[\\/]/).at(-1) ?? "minibase",
    sources,
  );
  const host = choose(
    "server.host",
    [
      { value: overrides.host, source: "cli" },
      { value: env.MINIBASE_HOST, source: "environment" },
      { value: stringValue(server.host), source: "minibase.toml" },
    ],
    "127.0.0.1",
    sources,
  );
  const port = choose(
    "server.port",
    [
      { value: overrides.port, source: "cli" },
      { value: parsePort(env.MINIBASE_PORT), source: "environment" },
      { value: numberValue(server.port), source: "minibase.toml" },
      { value: numberValue(supabaseApi.port), source: "supabase/config.toml" },
    ],
    54_321,
    sources,
  );
  const tlsCertFile = choose<string | undefined>(
    "server.tls.cert_file",
    [
      { value: env.MINIBASE_TLS_CERT_FILE, source: "environment" },
      { value: stringValue(tls.cert_file), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const tlsKeyFile = choose<string | undefined>(
    "server.tls.key_file",
    [
      { value: env.MINIBASE_TLS_KEY_FILE, source: "environment" },
      { value: stringValue(tls.key_file), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  if ((tlsCertFile === undefined) !== (tlsKeyFile === undefined)) {
    throw new Error("server.tls requires both cert_file and key_file");
  }
  const tlsConfig = tlsCertFile === undefined || tlsKeyFile === undefined ? undefined : {
    certFile: isAbsolute(tlsCertFile) ? resolve(tlsCertFile) : resolve(project.root, tlsCertFile),
    keyFile: isAbsolute(tlsKeyFile) ? resolve(tlsKeyFile) : resolve(project.root, tlsKeyFile),
  };
  const publicUrl = choose(
    "server.public_url",
    [
      { value: overrides.publicUrl, source: "cli" },
      { value: env.MINIBASE_PUBLIC_URL, source: "environment" },
      { value: stringValue(server.public_url), source: "minibase.toml" },
    ],
    `${tlsConfig === undefined ? "http" : "https"}://${
      host === "0.0.0.0" ? "127.0.0.1" : host
    }:${port}`,
    sources,
  );
  const corsAllowedOrigins = choose(
    "server.cors.allowed_origins",
    [
      {
        value: parseCommaSeparated(env.MINIBASE_CORS_ALLOWED_ORIGINS),
        source: "environment",
      },
      { value: stringArray(cors.allowed_origins), source: "minibase.toml" },
    ],
    [],
    sources,
  );
  const trustedProxies = choose(
    "server.trusted_proxies",
    [
      {
        value: parseCommaSeparated(env.MINIBASE_TRUSTED_PROXIES),
        source: "environment",
      },
      { value: stringArray(server.trusted_proxies), source: "minibase.toml" },
    ],
    [],
    sources,
  );
  const requestMaxBodyBytes = choose(
    "server.request.max_body_bytes",
    [
      {
        value: environmentInteger(
          env.MINIBASE_REQUEST_MAX_BODY_BYTES,
          "MINIBASE_REQUEST_MAX_BODY_BYTES",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          serverRequest.max_body_bytes,
          "server.request.max_body_bytes",
        ),
        source: "minibase.toml",
      },
    ],
    64 * 1024 * 1024,
    sources,
  );
  const requestTimeoutMs = choose(
    "server.request.timeout_ms",
    [
      {
        value: environmentInteger(
          env.MINIBASE_REQUEST_TIMEOUT_MS,
          "MINIBASE_REQUEST_TIMEOUT_MS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(serverRequest.timeout_ms, "server.request.timeout_ms"),
        source: "minibase.toml",
      },
    ],
    60_000,
    sources,
  );
  const requestMaxConcurrent = choose(
    "server.request.max_concurrent",
    [
      {
        value: environmentInteger(
          env.MINIBASE_REQUEST_MAX_CONCURRENT,
          "MINIBASE_REQUEST_MAX_CONCURRENT",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          serverRequest.max_concurrent,
          "server.request.max_concurrent",
        ),
        source: "minibase.toml",
      },
    ],
    256,
    sources,
  );
  const engine = choose(
    "database.engine",
    [
      { value: overrides.engine, source: "cli" },
      { value: parseEngine(env.MINIBASE_DATABASE_ENGINE), source: "environment" },
      { value: parseEngine(database.engine), source: "minibase.toml" },
    ],
    "pglite" as const,
    sources,
  );
  const databaseUrl = choose<string | undefined>(
    "database.url",
    [
      { value: env.MINIBASE_DATABASE_URL, source: "environment" },
      { value: secretEnvironment.MINIBASE_DATABASE_URL, source: "secrets-file" },
      { value: stringValue(database.url), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const databaseManaged = choose(
    "database.managed",
    [
      { value: parseBoolean(env.MINIBASE_DATABASE_MANAGED), source: "environment" },
      { value: booleanValue(database.managed), source: "minibase.toml" },
    ],
    databaseUrl === undefined,
    sources,
  );
  const databasePort = choose(
    "database.port",
    [
      { value: parsePort(env.MINIBASE_POSTGRES_PORT), source: "environment" },
      { value: numberValue(database.port), source: "minibase.toml" },
    ],
    54_322,
    sources,
  );
  const databaseRuntimePath = choose<string | undefined>(
    "database.runtime_path",
    [
      { value: env.MINIBASE_POSTGRES_RUNTIME_DIR, source: "environment" },
      { value: stringValue(database.runtime_path), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const poolMin = choose(
    "database.pool_min",
    [{ value: numberValue(database.pool_min), source: "minibase.toml" }],
    1,
    sources,
  );
  const poolMax = choose(
    "database.pool_max",
    [{ value: numberValue(database.pool_max), source: "minibase.toml" }],
    20,
    sources,
  );
  const connectTimeoutMs = choose(
    "database.connect_timeout_ms",
    [{ value: numberValue(database.connect_timeout_ms), source: "minibase.toml" }],
    10_000,
    sources,
  );
  const transactionTimeoutMs = choose(
    "database.transaction_timeout_ms",
    [
      {
        value: parsePort(env.MINIBASE_TRANSACTION_TIMEOUT_MS),
        source: "environment",
      },
      { value: numberValue(database.transaction_timeout_ms), source: "minibase.toml" },
    ],
    30_000,
    sources,
  );
  const longTransactionWarningMs = choose(
    "database.long_transaction_warning_ms",
    [
      {
        value: parsePort(env.MINIBASE_LONG_TRANSACTION_WARNING_MS),
        source: "environment",
      },
      { value: numberValue(database.long_transaction_warning_ms), source: "minibase.toml" },
    ],
    5_000,
    sources,
  );
  const storageDriver = choose(
    "storage.driver",
    [
      { value: overrides.storageDriver, source: "cli" },
      { value: parseStorageDriver(env.MINIBASE_STORAGE_DRIVER), source: "environment" },
      { value: parseStorageDriver(storage.driver), source: "minibase.toml" },
    ],
    "local" as const,
    sources,
  );
  const configuredStoragePath = choose(
    "storage.path",
    [
      { value: overrides.storagePath, source: "cli" },
      { value: env.MINIBASE_STORAGE_PATH, source: "environment" },
      { value: stringValue(storage.path), source: "minibase.toml" },
    ],
    project.storageDir,
    sources,
  );
  const storagePath = isAbsolute(configuredStoragePath)
    ? resolve(configuredStoragePath)
    : resolve(join(project.root, configuredStoragePath));
  const s3Endpoint = choose<string | undefined>(
    "storage.s3.endpoint",
    [
      { value: env.MINIBASE_S3_ENDPOINT, source: "environment" },
      { value: stringValue(s3.endpoint), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3Region = choose<string | undefined>(
    "storage.s3.region",
    [
      { value: env.MINIBASE_S3_REGION, source: "environment" },
      { value: stringValue(s3.region), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3Bucket = choose<string | undefined>(
    "storage.s3.bucket",
    [
      { value: env.MINIBASE_S3_BUCKET, source: "environment" },
      { value: stringValue(s3.bucket), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3AccessKeyId = choose<string | undefined>(
    "storage.s3.access_key_id",
    [
      { value: env.MINIBASE_S3_ACCESS_KEY_ID, source: "environment" },
      { value: secretEnvironment.MINIBASE_S3_ACCESS_KEY_ID, source: "secrets-file" },
      { value: stringValue(s3.access_key_id), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3SecretAccessKey = choose<string | undefined>(
    "storage.s3.secret_access_key",
    [
      { value: env.MINIBASE_S3_SECRET_ACCESS_KEY, source: "environment" },
      { value: secretEnvironment.MINIBASE_S3_SECRET_ACCESS_KEY, source: "secrets-file" },
      { value: stringValue(s3.secret_access_key), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3SessionToken = choose<string | undefined>(
    "storage.s3.session_token",
    [
      { value: env.MINIBASE_S3_SESSION_TOKEN, source: "environment" },
      { value: secretEnvironment.MINIBASE_S3_SESSION_TOKEN, source: "secrets-file" },
      { value: stringValue(s3.session_token), source: "minibase.toml" },
    ],
    undefined,
    sources,
  );
  const s3PathStyle = choose(
    "storage.s3.path_style",
    [
      {
        value: environmentBoolean(env.MINIBASE_S3_PATH_STYLE, "MINIBASE_S3_PATH_STYLE"),
        source: "environment",
      },
      {
        value: configuredBoolean(s3.path_style, "storage.s3.path_style"),
        source: "minibase.toml",
      },
    ],
    true,
    sources,
  );
  const s3Config = s3Endpoint !== undefined && s3Region !== undefined && s3Bucket !== undefined &&
      s3AccessKeyId !== undefined && s3SecretAccessKey !== undefined
    ? {
      endpoint: s3Endpoint,
      region: s3Region,
      bucket: s3Bucket,
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
      sessionToken: s3SessionToken,
      pathStyle: s3PathStyle,
    }
    : undefined;
  const outbound = choose(
    "functions.network.outbound",
    [
      { value: overrides.functionsOutbound, source: "cli" },
      {
        value: configuredOutbound(
          env.MINIBASE_FUNCTIONS_OUTBOUND,
          "MINIBASE_FUNCTIONS_OUTBOUND",
        ),
        source: "environment",
      },
      {
        value: configuredOutbound(network.outbound, "functions.network.outbound"),
        source: "minibase.toml",
      },
    ],
    "allow" as const,
    sources,
  );
  const allowedHosts = normalizeAllowedHosts(
    choose(
      "functions.network.allowed_hosts",
      [{
        value: configuredStringArray(
          network.allowed_hosts,
          "functions.network.allowed_hosts",
        ),
        source: "minibase.toml",
      }],
      [],
      sources,
    ),
    "functions.network.allowed_hosts",
  );
  const allowSupabaseUrl = choose(
    "functions.network.allow_supabase_url",
    [
      {
        value: parseBoolean(env.MINIBASE_FUNCTIONS_ALLOW_SUPABASE_URL),
        source: "environment",
      },
      {
        value: configuredBoolean(
          network.allow_supabase_url,
          "functions.network.allow_supabase_url",
        ),
        source: "minibase.toml",
      },
    ],
    true,
    sources,
  );
  const blockPrivateNetworks = choose(
    "functions.network.block_private_networks",
    [
      {
        value: parseBoolean(env.MINIBASE_FUNCTIONS_BLOCK_PRIVATE_NETWORKS),
        source: "environment",
      },
      {
        value: configuredBoolean(
          network.block_private_networks,
          "functions.network.block_private_networks",
        ),
        source: "minibase.toml",
      },
    ],
    false,
    sources,
  );
  const functionWorkersPerFunction = choose(
    "functions.runtime.workers_per_function",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION,
          "MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          functionRuntime.workers_per_function,
          "functions.runtime.workers_per_function",
        ),
        source: "minibase.toml",
      },
    ],
    2,
    sources,
  );
  const functionRateLimitWindowMs = choose(
    "functions.rate_limit.window_ms",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_RATE_LIMIT_WINDOW_MS,
          "MINIBASE_FUNCTIONS_RATE_LIMIT_WINDOW_MS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          functionRateLimit.window_ms,
          "functions.rate_limit.window_ms",
        ),
        source: "minibase.toml",
      },
    ],
    60_000,
    sources,
  );
  const functionRateLimitPerIp = choose(
    "functions.rate_limit.per_ip",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IP,
          "MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IP",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(functionRateLimit.per_ip, "functions.rate_limit.per_ip"),
        source: "minibase.toml",
      },
    ],
    0,
    sources,
  );
  const functionRateLimitPerFunction = choose(
    "functions.rate_limit.per_function",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION,
          "MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          functionRateLimit.per_function,
          "functions.rate_limit.per_function",
        ),
        source: "minibase.toml",
      },
    ],
    0,
    sources,
  );
  const functionRateLimitPerIdentity = choose(
    "functions.rate_limit.per_identity",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IDENTITY,
          "MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IDENTITY",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          functionRateLimit.per_identity,
          "functions.rate_limit.per_identity",
        ),
        source: "minibase.toml",
      },
    ],
    0,
    sources,
  );
  const functionRateLimitMaxKeys = choose(
    "functions.rate_limit.max_keys",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTIONS_RATE_LIMIT_MAX_KEYS,
          "MINIBASE_FUNCTIONS_RATE_LIMIT_MAX_KEYS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(functionRateLimit.max_keys, "functions.rate_limit.max_keys"),
        source: "minibase.toml",
      },
    ],
    10_000,
    sources,
  );
  const logFormat = choose(
    "logging.format",
    [
      {
        value: configuredLogFormat(env.MINIBASE_LOG_FORMAT, "MINIBASE_LOG_FORMAT"),
        source: "environment",
      },
      {
        value: configuredLogFormat(logging.format, "logging.format"),
        source: "minibase.toml",
      },
    ],
    "json",
    sources,
  );
  const logMaxBytes = choose(
    "logging.max_bytes",
    [
      {
        value: environmentInteger(env.MINIBASE_LOG_MAX_BYTES, "MINIBASE_LOG_MAX_BYTES"),
        source: "environment",
      },
      {
        value: configuredInteger(logging.max_bytes, "logging.max_bytes"),
        source: "minibase.toml",
      },
    ],
    10 * 1024 * 1024,
    sources,
  );
  const logRetentionFiles = choose(
    "logging.retention_files",
    [
      {
        value: environmentInteger(
          env.MINIBASE_LOG_RETENTION_FILES,
          "MINIBASE_LOG_RETENTION_FILES",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(logging.retention_files, "logging.retention_files"),
        source: "minibase.toml",
      },
    ],
    5,
    sources,
  );
  const functionLogMaxBytes = choose(
    "logging.functions.max_bytes",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTION_LOG_MAX_BYTES,
          "MINIBASE_FUNCTION_LOG_MAX_BYTES",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(functionLogs.max_bytes, "logging.functions.max_bytes"),
        source: "minibase.toml",
      },
    ],
    10 * 1024 * 1024,
    sources,
  );
  const functionLogRetentionFiles = choose(
    "logging.functions.retention_files",
    [
      {
        value: environmentInteger(
          env.MINIBASE_FUNCTION_LOG_RETENTION_FILES,
          "MINIBASE_FUNCTION_LOG_RETENTION_FILES",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          functionLogs.retention_files,
          "logging.functions.retention_files",
        ),
        source: "minibase.toml",
      },
    ],
    5,
    sources,
  );
  const definitions: MinibaseConfig["functions"]["definitions"] = {};
  const functionNames = new Set([
    ...Object.keys(supabaseFunctions),
    ...Object.keys(minibaseFunctions),
  ]);
  functionNames.delete("network");
  functionNames.delete("runtime");
  functionNames.delete("rate_limit");
  for (const name of [...functionNames].sort()) {
    const supabaseDefinition = asRecord(supabaseFunctions[name]);
    const minibaseDefinition = asRecord(minibaseFunctions[name]);
    const functionNetwork = asRecord(minibaseDefinition.network);
    const functionRateLimitOverride = asRecord(minibaseDefinition.rate_limit);
    const injectServiceRoleKey = configuredBoolean(
      minibaseDefinition.inject_service_role_key,
      `functions.${name}.inject_service_role_key`,
    );
    const configuredEntrypoint = choose<string | undefined>(
      `functions.${name}.entrypoint`,
      [
        { value: stringValue(minibaseDefinition.entrypoint), source: "minibase.toml" },
        {
          value: stringValue(supabaseDefinition.entrypoint),
          source: "supabase/config.toml",
        },
      ],
      undefined,
      sources,
    );
    const configuredImportMap = choose<string | undefined>(
      `functions.${name}.import_map`,
      [
        { value: stringValue(minibaseDefinition.import_map), source: "minibase.toml" },
        {
          value: stringValue(supabaseDefinition.import_map),
          source: "supabase/config.toml",
        },
      ],
      undefined,
      sources,
    );
    const functionOutbound = configuredOutbound(
      functionNetwork.outbound,
      `functions.${name}.network.outbound`,
    );
    const functionAllowedHosts = configuredStringArray(
      functionNetwork.allowed_hosts,
      `functions.${name}.network.allowed_hosts`,
    );
    const functionAllowSupabaseUrl = configuredBoolean(
      functionNetwork.allow_supabase_url,
      `functions.${name}.network.allow_supabase_url`,
    );
    const functionBlockPrivateNetworks = configuredBoolean(
      functionNetwork.block_private_networks,
      `functions.${name}.network.block_private_networks`,
    );
    const networkOverride: FunctionNetworkOverride = {
      outbound: functionOutbound,
      allowedHosts: functionAllowedHosts === undefined ? undefined : normalizeAllowedHosts(
        functionAllowedHosts,
        `functions.${name}.network.allowed_hosts`,
      ),
      allowSupabaseUrl: functionAllowSupabaseUrl,
      blockPrivateNetworks: functionBlockPrivateNetworks,
    };
    validateFunctionNetworkOverride(networkOverride, `functions.${name}.network`);
    const hasNetworkOverride = Object.values(networkOverride).some((value) => value !== undefined);
    const rateLimitOverride: FunctionRateLimitOverride = {
      windowMs: configuredInteger(
        functionRateLimitOverride.window_ms,
        `functions.${name}.rate_limit.window_ms`,
      ),
      perIp: configuredInteger(
        functionRateLimitOverride.per_ip,
        `functions.${name}.rate_limit.per_ip`,
      ),
      perFunction: configuredInteger(
        functionRateLimitOverride.per_function,
        `functions.${name}.rate_limit.per_function`,
      ),
      perIdentity: configuredInteger(
        functionRateLimitOverride.per_identity,
        `functions.${name}.rate_limit.per_identity`,
      ),
    };
    const hasRateLimitOverride = Object.values(rateLimitOverride).some((value) =>
      value !== undefined
    );
    definitions[name] = {
      verifyJwt: choose(
        `functions.${name}.verify_jwt`,
        [
          { value: booleanValue(minibaseDefinition.verify_jwt), source: "minibase.toml" },
          {
            value: booleanValue(supabaseDefinition.verify_jwt),
            source: "supabase/config.toml",
          },
        ],
        true,
        sources,
      ),
      injectServiceRoleKey: choose(
        `functions.${name}.inject_service_role_key`,
        [{ value: injectServiceRoleKey, source: "minibase.toml" }],
        true,
        sources,
      ),
      entrypoint: configuredEntrypoint === undefined ? undefined : await resolveFunctionPath(
        project,
        configuredEntrypoint,
        `functions.${name}.entrypoint`,
      ),
      importMap: configuredImportMap === undefined ? undefined : await resolveFunctionPath(
        project,
        configuredImportMap,
        `functions.${name}.import_map`,
      ),
      network: hasNetworkOverride ? networkOverride : undefined,
      rateLimit: hasRateLimitOverride ? rateLimitOverride : undefined,
    };
    if (functionOutbound !== undefined) {
      sources[`functions.${name}.network.outbound`] = "minibase.toml";
    }
    if (functionAllowedHosts !== undefined) {
      sources[`functions.${name}.network.allowed_hosts`] = "minibase.toml";
    }
    if (functionAllowSupabaseUrl !== undefined) {
      sources[`functions.${name}.network.allow_supabase_url`] = "minibase.toml";
    }
    if (functionBlockPrivateNetworks !== undefined) {
      sources[`functions.${name}.network.block_private_networks`] = "minibase.toml";
    }
    for (
      const [key, value] of Object.entries({
        window_ms: rateLimitOverride.windowMs,
        per_ip: rateLimitOverride.perIp,
        per_function: rateLimitOverride.perFunction,
        per_identity: rateLimitOverride.perIdentity,
      })
    ) {
      if (value !== undefined) {
        sources[`functions.${name}.rate_limit.${key}`] = "minibase.toml";
      }
    }
  }
  const seedEnabled = choose(
    "seed.enabled",
    [
      { value: parseBoolean(env.MINIBASE_SEED_ENABLED), source: "environment" },
      { value: booleanValue(seed.enabled), source: "minibase.toml" },
      { value: booleanValue(supabaseSeed.enabled), source: "supabase/config.toml" },
    ],
    true,
    sources,
  );
  const authPasswordMinLength = choose(
    "auth.password.min_length",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_PASSWORD_MIN_LENGTH,
          "MINIBASE_AUTH_PASSWORD_MIN_LENGTH",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(authPassword.min_length, "auth.password.min_length"),
        source: "minibase.toml",
      },
    ],
    12,
    sources,
  );
  const authPasswordMaxLength = choose(
    "auth.password.max_length",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_PASSWORD_MAX_LENGTH,
          "MINIBASE_AUTH_PASSWORD_MAX_LENGTH",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(authPassword.max_length, "auth.password.max_length"),
        source: "minibase.toml",
      },
    ],
    256,
    sources,
  );
  const authReauthenticationWindowSeconds = choose(
    "auth.reauthentication_window_seconds",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_REAUTHENTICATION_WINDOW_SECONDS,
          "MINIBASE_AUTH_REAUTHENTICATION_WINDOW_SECONDS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          auth.reauthentication_window_seconds,
          "auth.reauthentication_window_seconds",
        ),
        source: "minibase.toml",
      },
    ],
    5 * 60,
    sources,
  );
  const authRateLimitWindowMs = choose(
    "auth.rate_limit.window_ms",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_WINDOW_MS,
          "MINIBASE_AUTH_RATE_LIMIT_WINDOW_MS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(authRateLimit.window_ms, "auth.rate_limit.window_ms"),
        source: "minibase.toml",
      },
    ],
    60_000,
    sources,
  );
  const authRateLimitSignupPerIp = choose(
    "auth.rate_limit.signup_per_ip",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_SIGNUP_PER_IP,
          "MINIBASE_AUTH_RATE_LIMIT_SIGNUP_PER_IP",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authRateLimit.signup_per_ip,
          "auth.rate_limit.signup_per_ip",
        ),
        source: "minibase.toml",
      },
    ],
    10,
    sources,
  );
  const authRateLimitPasswordPerIp = choose(
    "auth.rate_limit.password_per_ip",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_PASSWORD_PER_IP,
          "MINIBASE_AUTH_RATE_LIMIT_PASSWORD_PER_IP",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authRateLimit.password_per_ip,
          "auth.rate_limit.password_per_ip",
        ),
        source: "minibase.toml",
      },
    ],
    30,
    sources,
  );
  const authRateLimitRefreshPerIp = choose(
    "auth.rate_limit.refresh_per_ip",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_REFRESH_PER_IP,
          "MINIBASE_AUTH_RATE_LIMIT_REFRESH_PER_IP",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authRateLimit.refresh_per_ip,
          "auth.rate_limit.refresh_per_ip",
        ),
        source: "minibase.toml",
      },
    ],
    120,
    sources,
  );
  const authRateLimitUpdatePerIp = choose(
    "auth.rate_limit.update_per_ip",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_UPDATE_PER_IP,
          "MINIBASE_AUTH_RATE_LIMIT_UPDATE_PER_IP",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authRateLimit.update_per_ip,
          "auth.rate_limit.update_per_ip",
        ),
        source: "minibase.toml",
      },
    ],
    30,
    sources,
  );
  const authRateLimitUpdatePerIdentity = choose(
    "auth.rate_limit.update_per_identity",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_UPDATE_PER_IDENTITY,
          "MINIBASE_AUTH_RATE_LIMIT_UPDATE_PER_IDENTITY",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authRateLimit.update_per_identity,
          "auth.rate_limit.update_per_identity",
        ),
        source: "minibase.toml",
      },
    ],
    10,
    sources,
  );
  const authRateLimitMaxKeys = choose(
    "auth.rate_limit.max_keys",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_RATE_LIMIT_MAX_KEYS,
          "MINIBASE_AUTH_RATE_LIMIT_MAX_KEYS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(authRateLimit.max_keys, "auth.rate_limit.max_keys"),
        source: "minibase.toml",
      },
    ],
    10_000,
    sources,
  );
  const anonymousCleanupEnabled = choose(
    "auth.anonymous_cleanup.enabled",
    [
      {
        value: parseBoolean(env.MINIBASE_AUTH_ANONYMOUS_CLEANUP_ENABLED),
        source: "environment",
      },
      { value: booleanValue(anonymousCleanup.enabled), source: "minibase.toml" },
    ],
    false,
    sources,
  );
  const anonymousRetentionHours = choose(
    "auth.anonymous_cleanup.retention_hours",
    [
      {
        value: parsePort(env.MINIBASE_AUTH_ANONYMOUS_RETENTION_HOURS),
        source: "environment",
      },
      { value: numberValue(anonymousCleanup.retention_hours), source: "minibase.toml" },
    ],
    30 * 24,
    sources,
  );
  const anonymousCleanupIntervalMinutes = choose(
    "auth.anonymous_cleanup.interval_minutes",
    [
      {
        value: parsePort(env.MINIBASE_AUTH_ANONYMOUS_CLEANUP_INTERVAL_MINUTES),
        source: "environment",
      },
      { value: numberValue(anonymousCleanup.interval_minutes), source: "minibase.toml" },
    ],
    60,
    sources,
  );
  const anonymousCleanupBatchSize = choose(
    "auth.anonymous_cleanup.batch_size",
    [
      {
        value: parsePort(env.MINIBASE_AUTH_ANONYMOUS_CLEANUP_BATCH_SIZE),
        source: "environment",
      },
      { value: numberValue(anonymousCleanup.batch_size), source: "minibase.toml" },
    ],
    1_000,
    sources,
  );
  const authAuditLogCleanupEnabled = choose(
    "auth.audit_log.cleanup_enabled",
    [
      {
        value: environmentBoolean(
          env.MINIBASE_AUTH_AUDIT_LOG_CLEANUP_ENABLED,
          "MINIBASE_AUTH_AUDIT_LOG_CLEANUP_ENABLED",
        ),
        source: "environment",
      },
      {
        value: configuredBoolean(
          authAuditLog.cleanup_enabled,
          "auth.audit_log.cleanup_enabled",
        ),
        source: "minibase.toml",
      },
    ],
    true,
    sources,
  );
  const authAuditLogRetentionDays = choose(
    "auth.audit_log.retention_days",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_AUDIT_LOG_RETENTION_DAYS,
          "MINIBASE_AUTH_AUDIT_LOG_RETENTION_DAYS",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authAuditLog.retention_days,
          "auth.audit_log.retention_days",
        ),
        source: "minibase.toml",
      },
    ],
    90,
    sources,
  );
  const authAuditLogIntervalMinutes = choose(
    "auth.audit_log.interval_minutes",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_AUDIT_LOG_INTERVAL_MINUTES,
          "MINIBASE_AUTH_AUDIT_LOG_INTERVAL_MINUTES",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(
          authAuditLog.interval_minutes,
          "auth.audit_log.interval_minutes",
        ),
        source: "minibase.toml",
      },
    ],
    60,
    sources,
  );
  const authAuditLogBatchSize = choose(
    "auth.audit_log.batch_size",
    [
      {
        value: environmentInteger(
          env.MINIBASE_AUTH_AUDIT_LOG_BATCH_SIZE,
          "MINIBASE_AUTH_AUDIT_LOG_BATCH_SIZE",
        ),
        source: "environment",
      },
      {
        value: configuredInteger(authAuditLog.batch_size, "auth.audit_log.batch_size"),
        source: "minibase.toml",
      },
    ],
    1_000,
    sources,
  );
  const authJwtSecret = choose<string | undefined>(
    "auth.jwt_secret",
    [
      { value: env.MINIBASE_AUTH_JWT_SECRET, source: "environment" },
      { value: secretEnvironment.MINIBASE_AUTH_JWT_SECRET, source: "secrets-file" },
    ],
    undefined,
    sources,
  );

  const config: MinibaseConfig = {
    metadata: {
      formatVersion: MINIBASE_CONFIG_FORMAT_VERSION,
      sourceFormatVersion: migrated.sourceVersion,
      migrations: migrated.migrations,
      sources,
    },
    project,
    projectId,
    secrets: { file: secretFile },
    server: {
      host,
      port,
      publicUrl,
      request: {
        maxBodyBytes: requestMaxBodyBytes,
        timeoutMs: requestTimeoutMs,
        maxConcurrent: requestMaxConcurrent,
      },
      cors: { allowedOrigins: normalizeCorsOrigins(corsAllowedOrigins) },
      trustedProxies,
      tls: tlsConfig,
    },
    database: {
      engine,
      url: databaseUrl,
      managed: databaseManaged,
      port: databasePort,
      runtimePath: databaseRuntimePath,
      poolMin,
      poolMax,
      connectTimeoutMs,
      transactionTimeoutMs,
      longTransactionWarningMs,
    },
    storage: { driver: storageDriver, path: storagePath, s3: s3Config },
    logging: {
      format: logFormat,
      maxBytes: logMaxBytes,
      retentionFiles: logRetentionFiles,
    },
    functions: {
      outbound,
      allowedHosts,
      allowSupabaseUrl,
      blockPrivateNetworks,
      runtime: {
        workersPerFunction: functionWorkersPerFunction,
      },
      rateLimit: {
        windowMs: functionRateLimitWindowMs,
        perIp: functionRateLimitPerIp,
        perFunction: functionRateLimitPerFunction,
        perIdentity: functionRateLimitPerIdentity,
        maxKeys: functionRateLimitMaxKeys,
      },
      logs: {
        maxBytes: functionLogMaxBytes,
        retentionFiles: functionLogRetentionFiles,
      },
      definitions,
    },
    auth: {
      jwtSecret: authJwtSecret,
      passwordPolicy: {
        minLength: authPasswordMinLength,
        maxLength: authPasswordMaxLength,
      },
      reauthenticationWindowSeconds: authReauthenticationWindowSeconds,
      rateLimit: {
        windowMs: authRateLimitWindowMs,
        signupPerIp: authRateLimitSignupPerIp,
        passwordPerIp: authRateLimitPasswordPerIp,
        refreshPerIp: authRateLimitRefreshPerIp,
        updatePerIp: authRateLimitUpdatePerIp,
        updatePerIdentity: authRateLimitUpdatePerIdentity,
        maxKeys: authRateLimitMaxKeys,
      },
      anonymousCleanup: {
        enabled: anonymousCleanupEnabled,
        retentionHours: anonymousRetentionHours,
        intervalMinutes: anonymousCleanupIntervalMinutes,
        batchSize: anonymousCleanupBatchSize,
      },
      auditLog: {
        cleanupEnabled: authAuditLogCleanupEnabled,
        retentionDays: authAuditLogRetentionDays,
        intervalMinutes: authAuditLogIntervalMinutes,
        batchSize: authAuditLogBatchSize,
      },
    },
    seed: { enabled: seedEnabled },
  };
  validate(config);
  return config;
}
