import { basename, join } from "@std/path";
import type { DatabaseEngine, DatabaseSession } from "../database/contract.ts";
import { bootstrapSystemSchema } from "../database/bootstrap.ts";
import type { ProjectPaths } from "../project/types.ts";
import { assertMigrationCompatibility } from "./compatibility.ts";

interface MigrationRow {
  version: string;
  hash: string;
}

export type MigrationAttemptState = "running" | "failed" | "applied";

export interface MigrationAttempt {
  version: string;
  name: string;
  hash: string;
  transactional: boolean;
  state: MigrationAttemptState;
  attempt: number;
  errorCode: string | null;
}

interface MigrationAttemptRow {
  version: string;
  name: string;
  hash: string;
  transactional: boolean;
  state: MigrationAttemptState;
  attempt: number;
  error_code: string | null;
}

interface MigrationDefinition {
  filename: string;
  file: string;
  sql: string;
  migration: AppliedMigration;
}

export interface AppliedMigration {
  version: string;
  name: string;
  hash: string;
  transactional: boolean;
}

export class MigrationExecutionError extends Error {
  override readonly name = "MigrationExecutionError";

  constructor(
    readonly file: string,
    readonly line: number | undefined,
    readonly column: number | undefined,
    readonly databaseCode: string | undefined,
    cause: unknown,
  ) {
    const location = line === undefined
      ? file
      : column === undefined
      ? `${file}:${line}`
      : `${file}:${line}:${column}`;
    super(`Migration ${location} failed: ${errorMessage(cause)}`, { cause });
  }
}

export class InterruptedMigrationError extends Error {
  override readonly name = "InterruptedMigrationError";

  constructor(readonly migration: MigrationAttempt, reason = "was interrupted") {
    super(
      `Non-transactional migration ${migration.version}_${migration.name}.sql ${reason} during ` +
        `attempt ${migration.attempt}. Inspect the partial database changes, then run ` +
        `minibase migration recover --migration-version ${migration.version} --force.`,
    );
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function migrationIdentity(filename: string): { version: string; name: string } {
  const match = /^(\d+)(?:_(.+))?\.sql$/i.exec(filename);
  if (match === null) {
    throw new Error(
      `Invalid migration filename: ${filename}. Expected <version>_<name>.sql`,
    );
  }
  return {
    version: match[1]!,
    name: match[2] ?? basename(filename, ".sql"),
  };
}

async function listMigrations(project: ProjectPaths): Promise<string[]> {
  if (!(await directoryExists(project.migrationsDir))) {
    return [];
  }
  const files: string[] = [];
  for await (const entry of Deno.readDir(project.migrationsDir)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(".sql")) {
      files.push(entry.name);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function loadMigrationDefinitions(project: ProjectPaths): Promise<MigrationDefinition[]> {
  const definitions: MigrationDefinition[] = [];
  for (const filename of await listMigrations(project)) {
    const identity = migrationIdentity(filename);
    const file = join(project.migrationsDir, filename);
    const sql = await Deno.readTextFile(file);
    definitions.push({
      filename,
      file,
      sql,
      migration: {
        ...identity,
        hash: await sha256(sql),
        transactional: !/^\s*--\s*minibase:no-transaction\b/im.test(sql),
      },
    });
  }
  return definitions;
}

async function recordMigration(
  session: DatabaseSession,
  migration: AppliedMigration,
): Promise<void> {
  await session.query(
    `insert into supabase_migrations.schema_migrations(version, name, statements, hash)
     values ($1, $2, array[]::text[], $3)`,
    [migration.version, migration.name, migration.hash],
  );
}

async function migrationAttempts(session: DatabaseSession): Promise<MigrationAttempt[]> {
  const result = await session.query<MigrationAttemptRow>(
    `select version, name, hash, transactional, state, attempt, error_code
     from minibase_meta.migration_attempts
     order by version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    hash: row.hash,
    transactional: row.transactional,
    state: row.state,
    attempt: row.attempt,
    errorCode: row.error_code,
  }));
}

async function beginMigrationAttempt(
  session: DatabaseSession,
  migration: AppliedMigration,
): Promise<MigrationAttempt> {
  const result = await session.query<MigrationAttemptRow>(
    `insert into minibase_meta.migration_attempts(
       version, name, hash, transactional, state, attempt, started_at, finished_at, error_code
     ) values ($1, $2, $3, $4, 'running', 1, now(), null, null)
     on conflict(version) do update set
       name = excluded.name,
       hash = excluded.hash,
       transactional = excluded.transactional,
       state = 'running',
       attempt = minibase_meta.migration_attempts.attempt + 1,
       started_at = now(),
       finished_at = null,
       error_code = null
     returning version, name, hash, transactional, state, attempt, error_code`,
    [migration.version, migration.name, migration.hash, migration.transactional],
  );
  const row = result.rows[0]!;
  return {
    version: row.version,
    name: row.name,
    hash: row.hash,
    transactional: row.transactional,
    state: row.state,
    attempt: row.attempt,
    errorCode: row.error_code,
  };
}

async function markMigrationApplied(
  session: DatabaseSession,
  migration: AppliedMigration,
): Promise<void> {
  await session.query(
    `insert into minibase_meta.migration_attempts(
       version, name, hash, transactional, state, attempt, started_at, finished_at, error_code
     ) values ($1, $2, $3, $4, 'applied', 1, now(), now(), null)
     on conflict(version) do update set
       name = excluded.name,
       hash = excluded.hash,
       transactional = excluded.transactional,
       state = 'applied',
       finished_at = now(),
       error_code = null`,
    [migration.version, migration.name, migration.hash, migration.transactional],
  );
}

async function markMigrationFailed(
  session: DatabaseSession,
  migration: AppliedMigration,
  error: unknown,
): Promise<void> {
  await session.query(
    `update minibase_meta.migration_attempts
     set state = 'failed', finished_at = now(), error_code = $2
     where version = $1`,
    [migration.version, databaseErrorCode(error) ?? "migration_failed"],
  );
}

export async function applyMigrations(
  engine: DatabaseEngine,
  project: ProjectPaths,
): Promise<AppliedMigration[]> {
  return await applyMigrationsInternal(engine, project);
}

async function applyMigrationsInternal(
  engine: DatabaseEngine,
  project: ProjectPaths,
  options: { recoverNonTransactionalVersion?: string; stopAfterVersion?: string } = {},
): Promise<AppliedMigration[]> {
  await assertMigrationCompatibility(engine, project);
  await bootstrapSystemSchema(engine);
  const existing = await engine.query<MigrationRow>(
    "select version, hash from supabase_migrations.schema_migrations",
  );
  const appliedByVersion = new Map(existing.rows.map((row) => [row.version, row.hash]));
  const attempts = await migrationAttempts(engine);
  const attemptsByVersion = new Map(attempts.map((attempt) => [attempt.version, attempt]));
  const definitions = await loadMigrationDefinitions(project);
  const definitionsByVersion = new Map(
    definitions.map((definition) => [definition.migration.version, definition]),
  );
  for (const attempt of attempts) {
    if (attempt.state !== "applied" && !definitionsByVersion.has(attempt.version)) {
      throw new Error(
        `Migration attempt ${attempt.version} is ${attempt.state}, but its SQL file is missing. ` +
          "Restore the unchanged migration file before retrying or recovering.",
      );
    }
  }
  const applied: AppliedMigration[] = [];

  for (const definition of definitions) {
    const { filename, file, sql, migration } = definition;
    const existingHash = appliedByVersion.get(migration.version);
    const previousAttempt = attemptsByVersion.get(migration.version);
    if (existingHash !== undefined) {
      if (existingHash !== migration.hash) {
        throw new Error(
          `Migration ${filename} was modified after it was applied. Expected hash ${existingHash}, got ${migration.hash}.`,
        );
      }
      if (previousAttempt?.state !== "applied") {
        await markMigrationApplied(engine, migration);
      }
      continue;
    }
    if (previousAttempt !== undefined) {
      if (
        previousAttempt.hash !== migration.hash ||
        previousAttempt.transactional !== migration.transactional
      ) {
        throw new Error(
          `Migration ${filename} was modified after attempt ${previousAttempt.attempt}. ` +
            "Restore the exact interrupted SQL before recovery.",
        );
      }
      if (previousAttempt.state === "applied") {
        throw new Error(
          `Migration ${filename} is marked applied in the attempt journal but has no schema record. ` +
            "Restore a backup and inspect the migration metadata before continuing.",
        );
      }
      if (
        !migration.transactional &&
        options.recoverNonTransactionalVersion !== migration.version
      ) {
        throw new InterruptedMigrationError(
          previousAttempt,
          previousAttempt.state === "failed" ? "failed after partial execution" : undefined,
        );
      }
    }
    const currentAttempt = await beginMigrationAttempt(engine, migration);
    attemptsByVersion.set(migration.version, currentAttempt);
    try {
      if (migration.transactional) {
        await engine.transaction(async (session) => {
          // Project migrations are trusted SQL scripts executed unchanged, never mixed with API input.
          await session.exec(sql);
          await recordMigration(session, migration);
          await markMigrationApplied(session, migration);
        });
      } else {
        // Non-transactional project migrations use the same unchanged-script boundary.
        await engine.exec(sql);
        await engine.transaction(async (session) => {
          await recordMigration(session, migration);
          await markMigrationApplied(session, migration);
        });
      }
    } catch (error) {
      await markMigrationFailed(engine, migration, error).catch(() => undefined);
      const position = databaseErrorPosition(error, sql);
      throw new MigrationExecutionError(
        file,
        position.line,
        position.column,
        databaseErrorCode(error),
        error,
      );
    }
    applied.push(migration);
    if (options.stopAfterVersion === migration.version) break;
  }
  return applied;
}

export async function recoverInterruptedMigration(
  engine: DatabaseEngine,
  project: ProjectPaths,
  version: string,
): Promise<MigrationAttempt> {
  await bootstrapSystemSchema(engine);
  const definition = (await loadMigrationDefinitions(project)).find((candidate) =>
    candidate.migration.version === version
  );
  if (definition === undefined) {
    throw new Error(`Migration ${version} does not exist in ${project.migrationsDir}`);
  }
  const attempt = (await migrationAttempts(engine)).find((candidate) =>
    candidate.version === version
  );
  if (attempt === undefined || attempt.state === "applied") {
    throw new Error(`Migration ${version} has no interrupted or failed attempt to recover`);
  }
  if (attempt.transactional) {
    throw new Error(
      `Migration ${version} is transactional and will recover automatically on the next start`,
    );
  }
  if (attempt.hash !== definition.migration.hash) {
    throw new Error(
      `Migration ${definition.filename} changed after interruption; restore the exact SQL before recovery`,
    );
  }
  await applyMigrationsInternal(engine, project, {
    recoverNonTransactionalVersion: version,
    stopAfterVersion: version,
  });
  const recovered = (await migrationAttempts(engine)).find((candidate) =>
    candidate.version === version
  );
  if (recovered?.state !== "applied") {
    throw new Error(`Migration ${version} recovery did not reach the applied state`);
  }
  return recovered;
}

export async function inspectMigrationAttempts(
  engine: DatabaseEngine,
): Promise<MigrationAttempt[]> {
  try {
    return await migrationAttempts(engine);
  } catch (error) {
    if (/minibase_meta\.migration_attempts|does not exist|not found/iu.test(errorMessage(error))) {
      return [];
    }
    throw error;
  }
}

export async function migrationsReady(
  engine: DatabaseEngine,
  project: ProjectPaths,
): Promise<boolean> {
  try {
    const existing = await engine.query<MigrationRow>(
      "select version, hash from supabase_migrations.schema_migrations",
    );
    const appliedByVersion = new Map(existing.rows.map((row) => [row.version, row.hash]));
    for (const filename of await listMigrations(project)) {
      const identity = migrationIdentity(filename);
      const sql = await Deno.readTextFile(join(project.migrationsDir, filename));
      if (appliedByVersion.get(identity.version) !== await sha256(sql)) return false;
    }
    const attempts = await migrationAttempts(engine);
    if (attempts.some((attempt) => attempt.state !== "applied")) return false;
    return true;
  } catch {
    return false;
  }
}

function databaseErrorPosition(
  error: unknown,
  sql: string,
): { line: number | undefined; column: number | undefined } {
  const candidate = error as { position?: unknown };
  const offset = positiveInteger(candidate.position);
  if (offset !== undefined) {
    const prefix = sql.slice(0, offset - 1);
    const line = prefix.split("\n").length;
    const lastNewline = prefix.lastIndexOf("\n");
    return { line, column: prefix.length - lastNewline };
  }
  const message = errorMessage(error);
  const location = /\bline\s+(\d+)(?:\D+column\s+(\d+))?/iu.exec(message);
  return {
    line: positiveInteger(location?.[1]),
    column: positiveInteger(location?.[2]),
  };
}

function databaseErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function applySeed(
  engine: DatabaseEngine,
  project: ProjectPaths,
): Promise<boolean> {
  if (project.seedFile === null) {
    return false;
  }
  const sql = await Deno.readTextFile(project.seedFile);
  const hash = await sha256(sql);
  const existing = await engine.query<{ exists: boolean }>(
    "select exists(select 1 from minibase_meta.seed_history where hash = $1) as exists",
    [hash],
  );
  if (existing.rows[0]?.exists === true) {
    return false;
  }
  await engine.transaction(async (session) => {
    // seed.sql is a trusted project script; its hash is the only value recorded by Minibase.
    await session.exec(sql);
    await session.query("insert into minibase_meta.seed_history(hash) values ($1)", [hash]);
  });
  return true;
}
