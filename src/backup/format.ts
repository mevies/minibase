import type { DatabaseEngineName } from "../config/types.ts";

export const LOGICAL_BACKUP_FORMAT_VERSION = 1;

export interface LogicalBackupColumn {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  generated: boolean;
  identity: false | "ALWAYS" | "BY DEFAULT";
  sequence: boolean;
}

export interface LogicalBackupTable {
  schema: string;
  name: string;
  columns: LogicalBackupColumn[];
  rowCount: number;
  bytes: number;
  path: string;
  sha256: string;
}

export interface LogicalBackupObject {
  bucket: string;
  name: string;
  size: number;
  path: string;
  sha256: string;
}

export interface LogicalBackupManifest {
  formatVersion: typeof LOGICAL_BACKUP_FORMAT_VERSION;
  createdAt: string;
  source: {
    engine: DatabaseEngineName;
    postgresVersion: string;
    projectId: string;
    minibaseVersion: string;
  };
  migrations: Array<{ version: string; name: string; hash: string }>;
  seedHashes: string[];
  excludedSchemas: string[];
  tables: LogicalBackupTable[];
  objectsIncluded: boolean;
  objects: LogicalBackupObject[];
  capacity: {
    tableDataBytes: number;
    objectBytes: number;
    estimatedRestoreBytes: number;
  };
  secretsIncluded: false;
}
