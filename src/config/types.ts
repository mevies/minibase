import type { ProjectPaths } from "../project/types.ts";

export type DatabaseEngineName = "pglite" | "postgres";
export type StorageDriverName = "local" | "s3";
export type OutboundNetworkMode = "allow" | "allowlist" | "deny";
export type LogFormat = "human" | "json";

export interface FunctionNetworkOverride {
  outbound?: OutboundNetworkMode;
  allowedHosts?: string[];
  allowSupabaseUrl?: boolean;
  blockPrivateNetworks?: boolean;
}

export interface FunctionRateLimitConfig {
  windowMs: number;
  perIp: number;
  perFunction: number;
  perIdentity: number;
  maxKeys: number;
}

export interface FunctionRateLimitOverride {
  windowMs?: number;
  perIp?: number;
  perFunction?: number;
  perIdentity?: number;
}

export interface AuthPasswordPolicyConfig {
  minLength: number;
  maxLength: number;
}

export interface AuthRateLimitConfig {
  windowMs: number;
  signupPerIp: number;
  passwordPerIp: number;
  refreshPerIp: number;
  updatePerIp: number;
  updatePerIdentity: number;
  maxKeys: number;
}
export type ConfigValueSource =
  | "cli"
  | "environment"
  | "secrets-file"
  | "minibase.toml"
  | "supabase/config.toml"
  | "default";

export interface ConfigMetadata {
  formatVersion: number;
  sourceFormatVersion: number;
  migrations: string[];
  sources: Record<string, ConfigValueSource>;
}

export interface MinibaseConfig {
  metadata: ConfigMetadata;
  project: ProjectPaths;
  projectId: string;
  secrets: {
    file?: string;
  };
  server: {
    host: string;
    port: number;
    publicUrl: string;
    request: {
      maxBodyBytes: number;
      timeoutMs: number;
      maxConcurrent: number;
    };
    cors: {
      allowedOrigins: string[];
    };
    trustedProxies: string[];
    tls?: {
      certFile: string;
      keyFile: string;
    };
  };
  database: {
    engine: DatabaseEngineName;
    url?: string;
    managed: boolean;
    port: number;
    runtimePath?: string;
    poolMin: number;
    poolMax: number;
    connectTimeoutMs: number;
    transactionTimeoutMs: number;
    longTransactionWarningMs: number;
  };
  storage: {
    driver: StorageDriverName;
    path: string;
    s3?: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      pathStyle: boolean;
    };
  };
  logging: {
    format: LogFormat;
    maxBytes: number;
    retentionFiles: number;
  };
  functions: {
    outbound: OutboundNetworkMode;
    allowedHosts: string[];
    allowSupabaseUrl: boolean;
    blockPrivateNetworks: boolean;
    runtime: {
      workersPerFunction: number;
    };
    rateLimit: FunctionRateLimitConfig;
    logs: {
      maxBytes: number;
      retentionFiles: number;
    };
    definitions: Record<string, {
      verifyJwt: boolean;
      injectServiceRoleKey: boolean;
      entrypoint?: string;
      importMap?: string;
      network?: FunctionNetworkOverride;
      rateLimit?: FunctionRateLimitOverride;
    }>;
  };
  auth: {
    jwtSecret?: string;
    passwordPolicy: AuthPasswordPolicyConfig;
    reauthenticationWindowSeconds: number;
    rateLimit: AuthRateLimitConfig;
    anonymousCleanup: {
      enabled: boolean;
      retentionHours: number;
      intervalMinutes: number;
      batchSize: number;
    };
    auditLog: {
      cleanupEnabled: boolean;
      retentionDays: number;
      intervalMinutes: number;
      batchSize: number;
    };
  };
  seed: {
    enabled: boolean;
  };
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  publicUrl?: string;
  engine?: DatabaseEngineName;
  storageDriver?: StorageDriverName;
  storagePath?: string;
  functionsOutbound?: OutboundNetworkMode;
}
