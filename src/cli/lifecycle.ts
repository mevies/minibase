import { basename, dirname, isAbsolute, join, relative } from "@std/path";
import type { MinibaseConfig } from "../config/types.ts";
import { startConfiguredDatabase } from "../database/factory.ts";
import { applySeed } from "../migrations/runner.ts";
import { readRuntimeState, removeRuntimeState, runtimeIsLive } from "../project/runtime.ts";
import { prepareProject, readProjectState } from "../project/state.ts";
import { S3ObjectStore } from "../storage/s3.ts";
import {
  clearObjectStore,
  createObjectSnapshot,
  type ObjectSnapshotEntry,
  restoreObjectSnapshot,
} from "../storage/snapshot.ts";
import { PROJECT_FORMAT_VERSION } from "../version.ts";

interface ResetBackupEntry {
  kind: "database" | "storage";
  sourcePath: string;
  backupPath: string;
}

interface ResetBackupManifest {
  formatVersion: 1;
  createdAt: string;
  reason: "reset";
  engine: "pglite" | "postgres";
  databaseMode: "embedded" | "managed";
  storageDriver: "local" | "s3";
  entries: ResetBackupEntry[];
  objects: ObjectSnapshotEntry[];
}

export async function stopProject(config: MinibaseConfig, force: boolean): Promise<{
  stopped: boolean;
  staleStateRemoved: boolean;
}> {
  const state = await readRuntimeState(config.project);
  if (state === null) {
    return { stopped: false, staleStateRemoved: false };
  }
  try {
    const response = await fetch(new URL("/_minibase/shutdown", state.controlUrl), {
      method: "POST",
      headers: { "x-minibase-control-token": state.controlToken },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`Control endpoint returned HTTP ${response.status}`);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await runtimeIsLive(state))) {
        await removeRuntimeState(config.project, state.pid);
        return { stopped: true, staleStateRemoved: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Minibase did not stop within 2 seconds");
  } catch (error) {
    if (!force) {
      throw new Error(
        `Could not stop PID ${state.pid}: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If the process no longer exists, rerun with --force to remove stale runtime state.",
      );
    }
    await removeRuntimeState(config.project, state.pid);
    return { stopped: false, staleStateRemoved: true };
  }
}

export async function resetProject(config: MinibaseConfig, force: boolean): Promise<{
  backupDir: string | null;
  migrations: string[];
  seedApplied: boolean;
}> {
  if (!force) {
    throw new Error("reset destroys current local data; rerun with --force to confirm");
  }
  const state = await readProjectState(config.project);
  if (state !== null && state.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new Error(
      `Project data format ${state.formatVersion} must be upgraded to ${PROJECT_FORMAT_VERSION} ` +
        "before reset; run `minibase upgrade` first",
    );
  }
  const runtime = await readRuntimeState(config.project);
  if (runtime !== null && await runtimeIsLive(runtime)) {
    throw new Error("Cannot reset a running project. Run `minibase stop` first.");
  }
  if (config.database.engine === "postgres" && !config.database.managed) {
    throw new Error(
      "External PostgreSQL reset cannot yet preserve a recoverable backup; export a logical backup before resetting",
    );
  }
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(/[:.]/g, "-");
  const backupDir = join(config.project.backupsDir, `reset-${timestamp}`);
  const databaseDir = config.database.engine === "pglite"
    ? config.project.pgliteDataDir
    : config.project.postgresDataDir;
  const candidates: Array<{ kind: ResetBackupEntry["kind"]; source: string }> = [
    { kind: "database", source: databaseDir },
    ...(config.storage.driver === "local"
      ? [{ kind: "storage" as const, source: config.storage.path }]
      : []),
  ];
  for (const { source } of candidates) {
    assertInside(config.project.minibaseDir, source);
    assertDisjoint(source, backupDir, "Reset source", "backup directory");
  }
  if (config.storage.driver === "local") {
    assertDisjoint(databaseDir, config.storage.path, "Database directory", "Storage directory");
  }

  const entries: ResetBackupEntry[] = [];
  const s3Store = config.storage.driver === "s3"
    ? new S3ObjectStore(config.storage.s3!, { ownershipRequired: true })
    : null;
  await s3Store?.acquireOwnership(config.projectId);
  let objects: ObjectSnapshotEntry[] = [];
  const manifest = (): ResetBackupManifest => ({
    formatVersion: 1,
    createdAt,
    reason: "reset",
    engine: config.database.engine,
    databaseMode: config.database.engine === "pglite" ? "embedded" : "managed",
    storageDriver: config.storage.driver,
    entries,
    objects,
  });
  try {
    if (s3Store !== null) {
      await Deno.mkdir(backupDir, { recursive: true });
      objects = await createObjectSnapshot(s3Store, join(backupDir, "objects"));
      await writeResetManifest(backupDir, manifest());
    }
    for (const { kind, source } of candidates) {
      if (!(await exists(source))) {
        continue;
      }
      await Deno.mkdir(backupDir, { recursive: true });
      const backupPath = kind === "database" ? config.database.engine : "storage";
      const target = join(backupDir, backupPath);
      if (await exists(target)) {
        throw new Error(`Reset backup target already exists: ${target}`);
      }
      await Deno.rename(source, target);
      entries.push({
        kind,
        sourcePath: relative(config.project.minibaseDir, source).replaceAll("\\", "/"),
        backupPath: basename(target),
      });
      await writeResetManifest(backupDir, manifest());
    }
  } catch (error) {
    const rollbackError = await rollbackResetBackup(config, backupDir, entries);
    const releaseError = await releaseStorageOwnership(s3Store);
    if (rollbackError !== null) {
      throw new Error(
        `Reset backup failed and could not be rolled back completely. Preserve ${backupDir}. ` +
          `Original error: ${errorMessage(error)}. Rollback error: ${errorMessage(rollbackError)}` +
          `${
            releaseError === null ? "" : `. Ownership release error: ${errorMessage(releaseError)}`
          }`,
      );
    }
    if (releaseError !== null) {
      throw new Error(
        `Reset backup failed and S3 ownership could not be released: ${errorMessage(releaseError)}`,
        { cause: error },
      );
    }
    throw error;
  }

  let remoteMutationStarted = false;
  let database: Awaited<ReturnType<typeof startConfiguredDatabase>> | null = null;
  try {
    if (s3Store !== null) {
      await clearObjectStore(s3Store, objects, () => {
        remoteMutationStarted = true;
      });
    }
    await prepareProject(config.project, config.database.engine);
    if (config.storage.driver === "local") {
      await Deno.mkdir(config.storage.path, { recursive: true });
    }
    database = await startConfiguredDatabase(config);
    const migrations = await database.engine.applyMigrations(config.project);
    const seedApplied = config.seed.enabled
      ? await applySeed(database.engine, config.project)
      : false;
    return {
      backupDir: await exists(backupDir) ? backupDir : null,
      migrations: migrations.map((migration) => migration.version),
      seedApplied,
    };
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    let filesystemRollbackSafe = true;
    if (database !== null) {
      try {
        await database.close();
        database = null;
      } catch (closeError) {
        rollbackFailures.push(closeError);
        filesystemRollbackSafe = false;
      }
    }
    if (s3Store !== null && remoteMutationStarted) {
      try {
        await restoreObjectSnapshot(s3Store, join(backupDir, "objects"), objects);
      } catch (storageError) {
        rollbackFailures.push(storageError);
      }
    }
    if (filesystemRollbackSafe) {
      const filesystemError = await rollbackResetBackup(config, backupDir, entries, {
        replaceTargets: true,
      });
      if (filesystemError !== null) rollbackFailures.push(filesystemError);
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Reset failed and automatic rollback was incomplete. Preserve ${backupDir}. ` +
          `Reset error: ${errorMessage(error)}. Rollback error: ${
            rollbackFailures.map(errorMessage).join("; ")
          }`,
        { cause: error },
      );
    }
    throw new Error(
      `Reset failed and was rolled back: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    try {
      await database?.close();
    } finally {
      await s3Store?.releaseOwnership();
    }
  }
}

async function releaseStorageOwnership(store: S3ObjectStore | null): Promise<unknown | null> {
  try {
    await store?.releaseOwnership();
    return null;
  } catch (error) {
    return error;
  }
}

async function writeResetManifest(
  backupDir: string,
  manifest: ResetBackupManifest,
): Promise<void> {
  const path = join(backupDir, "manifest.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await Deno.rename(temporary, path);
}

async function rollbackResetBackup(
  config: MinibaseConfig,
  backupDir: string,
  entries: ResetBackupEntry[],
  options: { replaceTargets?: boolean } = {},
): Promise<unknown | null> {
  try {
    for (const entry of [...entries].reverse()) {
      const source = join(backupDir, entry.backupPath);
      const target = join(config.project.minibaseDir, entry.sourcePath);
      if (await exists(source)) {
        if (await exists(target)) {
          if (!options.replaceTargets) {
            throw new Error(`Cannot roll back reset backup because ${target} already exists`);
          }
          assertInside(config.project.minibaseDir, target);
          await Deno.remove(target, { recursive: true });
        }
        await Deno.mkdir(dirname(target), { recursive: true });
        await Deno.rename(source, target);
      }
    }
    if (await exists(backupDir)) {
      assertInside(config.project.backupsDir, backupDir);
      await Deno.remove(backupDir, { recursive: true });
    }
    return null;
  } catch (error) {
    return error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function assertInside(parent: string, child: string): void {
  if (!isAbsolute(parent) || !isAbsolute(child)) {
    throw new Error("Reset paths must be absolute");
  }
  const childRelative = relative(parent, child);
  if (
    childRelative === "" || childRelative === ".." || childRelative.startsWith(`..\\`) ||
    childRelative.startsWith("../") || isAbsolute(childRelative)
  ) {
    throw new Error(`Refusing to reset path outside ${parent}: ${child}`);
  }
}

function assertDisjoint(left: string, right: string, leftName: string, rightName: string): void {
  if (containsPath(left, right) || containsPath(right, left)) {
    throw new Error(`${leftName} ${left} overlaps ${rightName} ${right}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" ||
    !(childRelative === ".." || childRelative.startsWith(`..\\`) ||
      childRelative.startsWith("../") || isAbsolute(childRelative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
