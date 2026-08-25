import type { DatabaseEngineName } from "../config/types.ts";
import type { ExportLogicalBackupOptions, ExportLogicalBackupResult } from "../backup/export.ts";
import type { RestoreLogicalBackupOptions, RestoreLogicalBackupResult } from "../backup/restore.ts";
import type { AppliedMigration } from "../migrations/runner.ts";
import type { ProjectPaths } from "../project/types.ts";

export type QueryRow = Record<string, unknown>;

export interface QueryResult<T extends object = QueryRow> {
  rows: T[];
  affectedRows: number | null;
}

export interface QueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRows?: number;
}

export interface DatabaseSession {
  query<T extends object = QueryRow>(
    sql: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  /** Execute only static control/DDL or an unchanged project migration/seed script. */
  exec(sql: string): Promise<void>;
}

export interface RequestDatabaseContext {
  role: "anon" | "authenticated" | "service_role";
  claims: Record<string, unknown>;
}

export interface DatabaseCapabilities {
  engine: DatabaseEngineName;
  postgresVersion: string;
  externalConnections: boolean;
  extensions: string[];
  concurrentConnections: boolean;
  logicalReplication: "unavailable" | "configurable";
}

export interface DatabaseEngine extends DatabaseSession {
  readonly name: DatabaseEngineName;
  start(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<boolean>;
  capabilities(): Promise<DatabaseCapabilities>;
  applyMigrations(project: ProjectPaths): Promise<AppliedMigration[]>;
  exportLogicalBackup(options: ExportLogicalBackupOptions): Promise<ExportLogicalBackupResult>;
  restoreLogicalBackup(options: RestoreLogicalBackupOptions): Promise<RestoreLogicalBackupResult>;
  transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T>;
  withRequestContext<T>(
    context: RequestDatabaseContext,
    callback: (session: DatabaseSession) => Promise<T>,
  ): Promise<T>;
}
