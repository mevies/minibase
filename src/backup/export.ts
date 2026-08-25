import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { DatabaseEngine } from "../database/contract.ts";
import { quoteSqlIdentifier } from "../database/sql.ts";
import type { ListedObject, ObjectStore } from "../storage/contract.ts";
import { LocalObjectStore } from "../storage/local.ts";
import { MINIBASE_VERSION } from "../version.ts";
import {
  LOGICAL_BACKUP_FORMAT_VERSION,
  type LogicalBackupColumn,
  type LogicalBackupManifest,
  type LogicalBackupObject,
  type LogicalBackupTable,
} from "./format.ts";

const EXCLUDED_SCHEMAS = [
  "cron",
  "extensions",
  "graphql",
  "graphql_public",
  "information_schema",
  "minibase_meta",
  "net",
  "pglite",
  "realtime",
  "supabase_migrations",
  "vault",
];
const PAGE_SIZE = 500;

interface CatalogTableRow {
  table_schema: string;
  table_name: string;
}

interface CatalogColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  is_generated: "ALWAYS" | "NEVER";
  is_identity: "YES" | "NO";
  identity_generation: "ALWAYS" | "BY DEFAULT" | null;
  column_default: string | null;
}

export interface ExportLogicalBackupOptions {
  projectId: string;
  outputDir: string;
  includeStorage?: boolean;
  storagePath?: string;
  objectStore?: ObjectStore;
}

export type ExportLogicalBackupResult = LogicalBackupManifest & { outputDir: string };

export async function exportLogicalBackup(
  engine: DatabaseEngine,
  options: ExportLogicalBackupOptions,
): Promise<ExportLogicalBackupResult> {
  const outputDir = resolve(options.outputDir);
  const temporaryDir = `${outputDir}.minibase-export-${crypto.randomUUID()}`;
  const objectStore = options.objectStore ??
    (options.storagePath === undefined ? undefined : new LocalObjectStore(options.storagePath));
  if (await exists(outputDir)) {
    throw new Error(`Backup output already exists: ${outputDir}`);
  }
  if (options.includeStorage && objectStore === undefined) {
    throw new Error("Including Storage requires a configured ObjectStore");
  }
  if (options.storagePath !== undefined) {
    assertDisjoint(outputDir, resolve(options.storagePath), "Backup output", "Storage source");
  }

  await Deno.mkdir(dirname(outputDir), { recursive: true });
  await Deno.mkdir(join(temporaryDir, "tables"), { recursive: true });
  try {
    const capabilities = await engine.capabilities();
    const migrations = await engine.query<{ version: string; name: string; hash: string }>(
      `select version, name, hash
       from supabase_migrations.schema_migrations order by version`,
    );
    const seedHistory = await engine.query<{ hash: string }>(
      "select hash from minibase_meta.seed_history order by hash",
    );
    const tables: LogicalBackupTable[] = [];
    const catalog = await logicalTables(engine);
    for (const [index, table] of catalog.entries()) {
      const columns = await logicalColumns(engine, table.table_schema, table.table_name);
      const path = `tables/${String(index).padStart(4, "0")}.jsonl`;
      const exported = await exportTable(
        engine,
        table.table_schema,
        table.table_name,
        join(temporaryDir, ...path.split("/")),
      );
      tables.push({
        schema: table.table_schema,
        name: table.table_name,
        columns,
        rowCount: exported.rowCount,
        bytes: exported.bytes,
        path,
        sha256: exported.sha256,
      });
    }

    const objects = options.includeStorage ? await exportObjects(temporaryDir, objectStore!) : [];
    const tableDataBytes = tables.reduce((total, table) => total + table.bytes, 0);
    const objectBytes = objects.reduce((total, object) => total + object.size, 0);
    const manifest: LogicalBackupManifest = {
      formatVersion: LOGICAL_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        engine: engine.name,
        postgresVersion: capabilities.postgresVersion,
        projectId: options.projectId,
        minibaseVersion: MINIBASE_VERSION,
      },
      migrations: migrations.rows,
      seedHashes: seedHistory.rows.map((row) => row.hash),
      excludedSchemas: EXCLUDED_SCHEMAS,
      tables,
      objectsIncluded: options.includeStorage === true,
      objects,
      capacity: {
        tableDataBytes,
        objectBytes,
        estimatedRestoreBytes: Math.ceil(tableDataBytes * 2.5 + objectBytes),
      },
      secretsIncluded: false,
    };
    await Deno.writeTextFile(
      join(temporaryDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    await Deno.rename(temporaryDir, outputDir);
    return { ...manifest, outputDir };
  } catch (error) {
    await Deno.remove(temporaryDir, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function logicalTables(engine: DatabaseEngine): Promise<CatalogTableRow[]> {
  const result = await engine.query<CatalogTableRow>(
    `select table_schema, table_name
     from information_schema.tables
     where table_type = 'BASE TABLE'
       and table_schema not like 'pg_%'
       and table_schema <> all($1::text[])
     order by table_schema, table_name`,
    [EXCLUDED_SCHEMAS],
  );
  return result.rows;
}

async function logicalColumns(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): Promise<LogicalBackupColumn[]> {
  const result = await engine.query<CatalogColumnRow>(
    `select column_name, data_type, udt_name, is_nullable, is_generated,
       is_identity, identity_generation, column_default
     from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [schema, table],
  );
  return result.rows.map((column) => ({
    name: column.column_name,
    dataType: column.data_type,
    udtName: column.udt_name,
    nullable: column.is_nullable === "YES",
    generated: column.is_generated === "ALWAYS",
    identity: column.is_identity === "YES" ? column.identity_generation ?? "BY DEFAULT" : false,
    sequence: column.column_default?.includes("nextval(") === true,
  }));
}

async function exportTable(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  path: string,
): Promise<{ rowCount: number; bytes: number; sha256: string }> {
  const file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
  const hash = createHash("sha256");
  const encoder = new TextEncoder();
  let rowCount = 0;
  let bytesWritten = 0;
  try {
    for (let offset = 0;; offset += PAGE_SIZE) {
      const result = await engine.query<{ data: string }>(
        `select to_jsonb(source_row)::text as data
         from ${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(table)} as source_row
         order by to_jsonb(source_row)::text
         limit $1 offset $2`,
        [PAGE_SIZE, offset],
        { maxRows: PAGE_SIZE },
      );
      for (const row of result.rows) {
        const bytes = encoder.encode(`${row.data}\n`);
        await file.write(bytes);
        hash.update(bytes);
        bytesWritten += bytes.byteLength;
        rowCount++;
      }
      if (result.rows.length < PAGE_SIZE) break;
    }
  } finally {
    file.close();
  }
  return { rowCount, bytes: bytesWritten, sha256: hash.digest("hex") };
}

async function exportObjects(
  backupRoot: string,
  store: ObjectStore,
): Promise<LogicalBackupObject[]> {
  if (store.list === undefined) {
    throw new Error(`The ${store.driver} Storage backend cannot list objects for backup export`);
  }
  const listed = (await store.list()).filter((object) => !isInternalObject(object)).sort(
    (left, right) => left.bucket.localeCompare(right.bucket) || left.name.localeCompare(right.name),
  );
  const objects: LogicalBackupObject[] = [];
  const names = new Set<string>();
  for (const [index, object] of listed.entries()) {
    validateListedObject(object);
    const name = `${object.bucket}\0${object.name}`;
    if (names.has(name)) {
      throw new Error(`Storage backend listed a duplicate object: ${object.bucket}/${object.name}`);
    }
    names.add(name);
    const path = `objects/${String(index).padStart(6, "0")}.bin`;
    const target = join(backupRoot, ...path.split("/"));
    await Deno.mkdir(dirname(target), { recursive: true });
    const source = await store.read(object.bucket, object.name);
    const exported = await writeObjectFile(target, source.body);
    if (
      exported.size !== object.size || source.size !== undefined && source.size !== exported.size
    ) {
      throw new Error(
        `Storage object changed while exporting ${object.bucket}/${object.name}: ` +
          `listed ${object.size}, read ${exported.size}`,
      );
    }
    objects.push({
      bucket: object.bucket,
      name: object.name,
      size: exported.size,
      path,
      sha256: exported.sha256,
    });
  }
  return objects;
}

async function writeObjectFile(
  path: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ size: number; sha256: string }> {
  const file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  try {
    if (body !== null) {
      for await (const chunk of body) {
        await writeAll(file, chunk);
        hash.update(chunk);
        size += chunk.byteLength;
      }
    }
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await file.write(chunk.subarray(offset));
    if (written === 0) throw new Error("Backup object file write made no progress");
    offset += written;
  }
}

function isInternalObject(object: ListedObject): boolean {
  return object.name.includes(".minibase-upload-") ||
    object.backendKey?.startsWith(".minibase-tmp/") === true;
}

function validateListedObject(object: ListedObject): void {
  if (object.bucket.length === 0 || object.name.length === 0) {
    throw new Error(
      `Storage backend listed an object outside the Minibase namespace: ${object.backendKey ?? ""}`,
    );
  }
  if (!Number.isSafeInteger(object.size) || object.size < 0) {
    throw new Error(`Storage backend listed an invalid size for ${object.bucket}/${object.name}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function assertDisjoint(left: string, right: string, leftName: string, rightName: string): void {
  if (!isAbsolute(left) || !isAbsolute(right)) throw new Error("Backup paths must be absolute");
  if (containsPath(left, right) || containsPath(right, left)) {
    throw new Error(`${leftName} ${left} overlaps ${rightName} ${right}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" ||
    !(relation === ".." || relation.startsWith(`..${SEPARATOR}`) || isAbsolute(relation));
}
