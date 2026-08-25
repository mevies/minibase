import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { DatabaseEngine, DatabaseSession } from "../database/contract.ts";
import { quoteSqlIdentifier } from "../database/sql.ts";
import { LocalObjectStore } from "../storage/local.ts";
import type { ObjectStore, PendingObjectWrite } from "../storage/contract.ts";
import {
  LOGICAL_BACKUP_FORMAT_VERSION,
  type LogicalBackupManifest,
  type LogicalBackupObject,
  type LogicalBackupTable,
} from "./format.ts";

const IMPORT_BATCH_SIZE = 100;

export interface RestoreLogicalBackupOptions {
  inputDir: string;
  force?: boolean;
  storagePath?: string;
  objectStore?: ObjectStore;
}

export interface RestoreLogicalBackupResult {
  sourceEngine: string;
  targetEngine: string;
  tablesRestored: number;
  rowsRestored: number;
  objectsRestored: number;
  objectsExcluded: number;
  estimatedRestoreBytes: number;
}

export async function loadLogicalBackup(inputDir: string): Promise<LogicalBackupManifest> {
  const root = resolve(inputDir);
  const manifest = JSON.parse(
    await Deno.readTextFile(join(root, "manifest.json")),
  ) as LogicalBackupManifest;
  validateManifest(manifest);
  const paths = new Set<string>();
  for (const table of manifest.tables) {
    validateEntryPath(root, table.path, paths);
    const verified = await verifyJsonLines(backupPath(root, table.path));
    if (verified.sha256 !== table.sha256) {
      throw new Error(`Backup checksum mismatch for ${table.path}`);
    }
    if (verified.rowCount !== table.rowCount) {
      throw new Error(
        `Backup row count mismatch for ${table.schema}.${table.name}: ` +
          `manifest ${table.rowCount}, file ${verified.rowCount}`,
      );
    }
    if (verified.bytes !== table.bytes) {
      throw new Error(
        `Backup byte count mismatch for ${table.schema}.${table.name}: ` +
          `manifest ${table.bytes}, file ${verified.bytes}`,
      );
    }
  }
  for (const object of manifest.objects) {
    validateEntryPath(root, object.path, paths);
    const path = backupPath(root, object.path);
    const stat = await Deno.stat(path);
    if (!stat.isFile) throw new Error(`Backup object is not a file: ${object.path}`);
    if (stat.size !== object.size) {
      throw new Error(
        `Backup object size mismatch for ${object.bucket}/${object.name}: ` +
          `manifest ${object.size}, file ${stat.size}`,
      );
    }
    if (await sha256File(path) !== object.sha256) {
      throw new Error(`Backup checksum mismatch for ${object.path}`);
    }
  }
  const tableDataBytes = manifest.tables.reduce((total, table) => total + table.bytes, 0);
  const objectBytes = manifest.objects.reduce((total, object) => total + object.size, 0);
  const estimatedRestoreBytes = Math.ceil(tableDataBytes * 2.5 + objectBytes);
  if (
    manifest.capacity.tableDataBytes !== tableDataBytes ||
    manifest.capacity.objectBytes !== objectBytes ||
    manifest.capacity.estimatedRestoreBytes !== estimatedRestoreBytes
  ) {
    throw new Error("Logical backup capacity estimates do not match its verified files");
  }
  return manifest;
}

export async function restoreLogicalBackup(
  engine: DatabaseEngine,
  options: RestoreLogicalBackupOptions,
): Promise<RestoreLogicalBackupResult> {
  const inputDir = resolve(options.inputDir);
  const manifest = await loadLogicalBackup(inputDir);
  const objectStore = options.objectStore ??
    (options.storagePath === undefined ? undefined : new LocalObjectStore(options.storagePath));
  await validateMigrations(engine, manifest);
  await validateTargetSchema(engine, manifest.tables);
  const occupied = await occupiedTables(engine, manifest.tables);
  if (occupied.length > 0 && !options.force) {
    throw new Error(
      `Restore target is not empty (${occupied.join(", ")}); ` +
        "rerun with --force after preserving a backup",
    );
  }
  if (manifest.objectsIncluded && objectStore === undefined) {
    throw new Error("This backup contains objects but no Storage target was provided");
  }

  const pendingObjects = manifest.objectsIncluded
    ? await stageObjects(inputDir, objectStore!, manifest.objects)
    : [];
  let committingObjects = false;
  try {
    await engine.transaction(async (session) => {
      await session.exec("set local session_replication_role = replica");
      if (options.force && manifest.tables.length > 0) {
        await session.exec(
          `truncate table ${
            manifest.tables.map((table) => qualifiedTable(table)).join(", ")
          } restart identity cascade`,
        );
      }
      for (const table of manifest.tables) {
        await importTable(session, inputDir, table);
      }
      await resetSequences(session, manifest.tables);
      await session.exec("delete from minibase_meta.seed_history");
      for (const hash of manifest.seedHashes) {
        await session.query(
          "insert into minibase_meta.seed_history(hash) values ($1) on conflict do nothing",
          [hash],
        );
      }
      committingObjects = true;
      for (const pending of pendingObjects) await pending.commit();
      committingObjects = false;
    });
  } catch (error) {
    const rollbackFailures = await rollbackObjects(pendingObjects);
    if (rollbackFailures > 0) {
      throw new Error(
        `Restore failed and ${rollbackFailures} Storage object rollback(s) were incomplete. ` +
          "Run storage check before serving traffic.",
        { cause: error },
      );
    }
    if (committingObjects) {
      throw new Error(
        `Storage object commit failed; database restore was rolled back: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    for (const pending of pendingObjects) await pending.finalize();
  } catch (error) {
    throw new Error(
      `Database and Storage restore committed but Storage cleanup failed: ${
        errorMessage(error)
      }. ` +
        "Run storage check before serving traffic.",
      { cause: error },
    );
  }

  return {
    sourceEngine: manifest.source.engine,
    targetEngine: engine.name,
    tablesRestored: manifest.tables.length,
    rowsRestored: manifest.tables.reduce((total, table) => total + table.rowCount, 0),
    objectsRestored: pendingObjects.length,
    objectsExcluded: manifest.objectsIncluded ? 0 : storageMetadataCount(manifest),
    estimatedRestoreBytes: manifest.capacity.estimatedRestoreBytes,
  };
}

async function validateMigrations(
  engine: DatabaseEngine,
  manifest: LogicalBackupManifest,
): Promise<void> {
  const target = await engine.query<{ version: string; name: string; hash: string }>(
    `select version, name, hash
     from supabase_migrations.schema_migrations order by version`,
  );
  if (JSON.stringify(target.rows) !== JSON.stringify(manifest.migrations)) {
    throw new Error("Backup migrations do not exactly match the target project migrations");
  }
}

async function validateTargetSchema(
  engine: DatabaseEngine,
  tables: LogicalBackupTable[],
): Promise<void> {
  for (const table of tables) {
    const result = await engine.query<{
      column_name: string;
      udt_name: string;
      is_generated: "ALWAYS" | "NEVER";
    }>(
      `select column_name, udt_name, is_generated
       from information_schema.columns
       where table_schema = $1 and table_name = $2
       order by ordinal_position`,
      [table.schema, table.name],
    );
    const target = result.rows.map((column) => ({
      name: column.column_name,
      udtName: column.udt_name,
      generated: column.is_generated === "ALWAYS",
    }));
    const source = table.columns.map((column) => ({
      name: column.name,
      udtName: column.udtName,
      generated: column.generated,
    }));
    if (JSON.stringify(target) !== JSON.stringify(source)) {
      throw new Error(`Backup schema does not match target table ${table.schema}.${table.name}`);
    }
  }
}

async function occupiedTables(
  engine: DatabaseEngine,
  tables: LogicalBackupTable[],
): Promise<string[]> {
  const occupied: string[] = [];
  for (const table of tables) {
    const result = await engine.query<{ occupied: boolean }>(
      `select exists(select 1 from ${qualifiedTable(table)} limit 1) as occupied`,
    );
    if (result.rows[0]?.occupied === true) occupied.push(`${table.schema}.${table.name}`);
  }
  return occupied;
}

async function importTable(
  session: DatabaseSession,
  inputDir: string,
  table: LogicalBackupTable,
): Promise<void> {
  const columns = table.columns.filter((column) => !column.generated);
  if (columns.length === 0 && table.rowCount > 0) {
    throw new Error(
      `Cannot restore ${table.schema}.${table.name}: every column is generated`,
    );
  }
  const names = columns.map((column) => quoteSqlIdentifier(column.name)).join(", ");
  const overriding = columns.some((column) => column.identity === "ALWAYS")
    ? " overriding system value"
    : "";
  const batch: Array<{ line: string; lineNumber: number }> = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const records = batch.map((_, index) =>
      `select ${names} from jsonb_populate_record(
        null::${qualifiedTable(table)}, $${index + 1}::text::jsonb
      )`
    ).join(" union all ");
    try {
      await session.query(
        `insert into ${qualifiedTable(table)} (${names})${overriding} ${records}`,
        batch.map((entry) => entry.line),
      );
    } catch (error) {
      const range = `${batch[0]!.lineNumber}-${batch.at(-1)!.lineNumber}`;
      throw new Error(
        `Failed to restore ${table.schema}.${table.name} rows ${range}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    batch.length = 0;
  };
  const verified = await consumeJsonLines(
    backupPath(inputDir, table.path),
    async (line, lineNumber) => {
      batch.push({ line, lineNumber });
      if (batch.length === IMPORT_BATCH_SIZE) await flush();
    },
  );
  await flush();
  assertTableFileMatchesManifest(table, verified, "changed after validation");
}

async function resetSequences(
  session: DatabaseSession,
  tables: LogicalBackupTable[],
): Promise<void> {
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.identity === false && !column.sequence) continue;
      const relation = `${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.name)}`;
      const sequence = await session.query<{ sequence_name: string | null }>(
        "select pg_get_serial_sequence($1, $2) as sequence_name",
        [relation, column.name],
      );
      const sequenceName = sequence.rows[0]?.sequence_name;
      if (sequenceName === null || sequenceName === undefined) continue;
      const maximum = await session.query<{ value: string | null }>(
        `select max(${quoteSqlIdentifier(column.name)})::text as value from ${
          qualifiedTable(table)
        }`,
      );
      const value = maximum.rows[0]?.value;
      await session.query("select setval($1::regclass, $2::bigint, $3)", [
        sequenceName,
        value ?? "1",
        value !== null && value !== undefined,
      ]);
    }
  }
}

async function stageObjects(
  inputDir: string,
  store: ObjectStore,
  objects: LogicalBackupObject[],
): Promise<PendingObjectWrite[]> {
  if (store.list === undefined) {
    throw new Error(`The ${store.driver} Storage backend cannot list restore targets`);
  }
  const existing = new Set(
    (await store.list()).map((object) => `${object.bucket}\0${object.name}`),
  );
  for (const object of objects) {
    if (existing.has(`${object.bucket}\0${object.name}`)) {
      throw new Error(
        `Storage restore target already exists: ${object.bucket}/${object.name}; reset it first`,
      );
    }
  }
  const pending: PendingObjectWrite[] = [];
  try {
    for (const object of objects) {
      const source = await Deno.open(backupPath(inputDir, object.path), { read: true });
      const write = await store.write(object.bucket, object.name, source.readable);
      if (write.size !== object.size) {
        await write.rollback();
        throw new Error(`Staged object size changed for ${object.bucket}/${object.name}`);
      }
      pending.push(write);
    }
    return pending;
  } catch (error) {
    const rollbackFailures = await rollbackObjects(pending);
    if (rollbackFailures > 0) {
      throw new Error(
        `Storage staging failed and ${rollbackFailures} rollback(s) were incomplete. ` +
          "Run storage check before restoring again.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function rollbackObjects(objects: PendingObjectWrite[]): Promise<number> {
  const results = await Promise.allSettled(objects.map((object) => object.rollback()));
  return results.filter((result) => result.status === "rejected").length;
}

function storageMetadataCount(manifest: LogicalBackupManifest): number {
  return manifest.tables.find((table) => table.schema === "storage" && table.name === "objects")
    ?.rowCount ?? 0;
}

function validateManifest(manifest: LogicalBackupManifest): void {
  if (manifest.formatVersion !== LOGICAL_BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported logical backup format version: ${manifest.formatVersion}`);
  }
  if (manifest.secretsIncluded !== false) {
    throw new Error("Refusing a logical backup that declares embedded Secrets");
  }
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.objects)) {
    throw new Error("Logical backup manifest is missing table or object entries");
  }
  if (
    !Number.isSafeInteger(manifest.capacity?.tableDataBytes) ||
    !Number.isSafeInteger(manifest.capacity?.objectBytes) ||
    !Number.isSafeInteger(manifest.capacity?.estimatedRestoreBytes) ||
    manifest.capacity.tableDataBytes < 0 || manifest.capacity.objectBytes < 0 ||
    manifest.capacity.estimatedRestoreBytes < 0
  ) {
    throw new Error("Logical backup manifest has invalid capacity estimates");
  }
  const tableNames = new Set<string>();
  for (const table of manifest.tables) {
    const key = `${table.schema}\0${table.name}`;
    if (tableNames.has(key)) {
      throw new Error(`Duplicate backup table: ${table.schema}.${table.name}`);
    }
    tableNames.add(key);
    if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) {
      throw new Error(`Invalid row count for ${table.schema}.${table.name}`);
    }
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (columns.has(column.name)) {
        throw new Error(`Duplicate column in ${table.schema}.${table.name}: ${column.name}`);
      }
      columns.add(column.name);
    }
  }
  if (!manifest.objectsIncluded && manifest.objects.length > 0) {
    throw new Error("Backup contains object files but objectsIncluded is false");
  }
  const objectNames = new Set<string>();
  for (const object of manifest.objects) {
    if (
      typeof object.bucket !== "string" || object.bucket.length === 0 ||
      typeof object.name !== "string" || object.name.length === 0
    ) {
      throw new Error("Logical backup manifest has an invalid object name");
    }
    if (!Number.isSafeInteger(object.size) || object.size < 0) {
      throw new Error(`Invalid object size for ${object.bucket}/${object.name}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(object.sha256)) {
      throw new Error(`Invalid object checksum for ${object.bucket}/${object.name}`);
    }
    const name = `${object.bucket}\0${object.name}`;
    if (objectNames.has(name)) {
      throw new Error(`Duplicate backup object: ${object.bucket}/${object.name}`);
    }
    objectNames.add(name);
  }
}

function validateEntryPath(root: string, path: string, paths: Set<string>): void {
  if (paths.has(path)) throw new Error(`Duplicate backup entry path: ${path}`);
  paths.add(path);
  backupPath(root, path);
}

function backupPath(root: string, path: string): string {
  if (path.length === 0 || path.includes("\\") || isAbsolute(path)) {
    throw new Error(`Unsafe backup entry path: ${path}`);
  }
  const target = resolve(join(root, ...path.split("/")));
  const relation = relative(root, target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${SEPARATOR}`)) {
    throw new Error(`Backup entry escapes its root: ${path}`);
  }
  return target;
}

async function verifyJsonLines(
  path: string,
): Promise<{ sha256: string; rowCount: number; bytes: number }> {
  return await consumeJsonLines(path, (line, lineNumber) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON in backup table ${path} at row ${lineNumber}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Backup table row ${lineNumber} is not a JSON object: ${path}`);
    }
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

async function consumeJsonLines(
  path: string,
  consume: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<{ sha256: string; rowCount: number; bytes: number }> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const file = await Deno.open(path, { read: true });
  let pending = "";
  let rowCount = 0;
  let bytes = 0;

  const emit = async (line: string): Promise<void> => {
    rowCount++;
    await consume(line.endsWith("\r") ? line.slice(0, -1) : line, rowCount);
  };

  for await (const chunk of file.readable) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    pending += decoder.decode(chunk, { stream: true });
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      await emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) await emit(pending);

  return { sha256: hash.digest("hex"), rowCount, bytes };
}

function assertTableFileMatchesManifest(
  table: LogicalBackupTable,
  verified: { sha256: string; rowCount: number; bytes: number },
  context: string,
): void {
  if (
    verified.sha256 !== table.sha256 || verified.rowCount !== table.rowCount ||
    verified.bytes !== table.bytes
  ) {
    throw new Error(`Backup table ${table.schema}.${table.name} ${context}`);
  }
}

function qualifiedTable(table: Pick<LogicalBackupTable, "schema" | "name">): string {
  return `${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.name)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
