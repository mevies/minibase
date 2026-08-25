import {
  exportLogicalBackup,
  type ExportLogicalBackupOptions,
  type ExportLogicalBackupResult,
} from "../backup/export.ts";
import {
  restoreLogicalBackup,
  type RestoreLogicalBackupOptions,
  type RestoreLogicalBackupResult,
} from "../backup/restore.ts";
import { type AppliedMigration, applyMigrations } from "../migrations/runner.ts";
import type { ProjectPaths } from "../project/types.ts";
import type {
  DatabaseCapabilities,
  DatabaseEngine,
  DatabaseSession,
  QueryOptions,
  QueryResult,
  QueryRow,
  RequestDatabaseContext,
} from "./contract.ts";

export abstract class DatabaseEngineBase implements DatabaseEngine {
  abstract readonly name: DatabaseEngine["name"];

  abstract start(): Promise<void>;
  abstract close(): Promise<void>;
  abstract health(): Promise<boolean>;
  abstract capabilities(): Promise<DatabaseCapabilities>;
  abstract query<T extends object = QueryRow>(
    sql: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  abstract exec(sql: string): Promise<void>;
  abstract transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T>;
  abstract withRequestContext<T>(
    context: RequestDatabaseContext,
    callback: (session: DatabaseSession) => Promise<T>,
  ): Promise<T>;

  async applyMigrations(project: ProjectPaths): Promise<AppliedMigration[]> {
    return await applyMigrations(this, project);
  }

  async exportLogicalBackup(
    options: ExportLogicalBackupOptions,
  ): Promise<ExportLogicalBackupResult> {
    return await exportLogicalBackup(this, options);
  }

  async restoreLogicalBackup(
    options: RestoreLogicalBackupOptions,
  ): Promise<RestoreLogicalBackupResult> {
    return await restoreLogicalBackup(this, options);
  }
}
