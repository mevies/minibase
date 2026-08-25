import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { MinibaseConfig } from "../config/types.ts";
import { readRuntimeState, runtimeIsLive } from "./runtime.ts";
import {
  type CurrentProjectState,
  type LegacyProjectState,
  readProjectState,
  upgradedProjectState,
  writeProjectState,
} from "./state.ts";
import { PROJECT_FORMAT_VERSION } from "../version.ts";
import { SUPPORTED_POSTGRES_MAJOR } from "../toolchain.ts";
import { hardenWindowsPrivateTreeAcl } from "../security/windows_acl.ts";
import { PostgresEngine } from "../database/postgres.ts";
import type { ObjectStore } from "../storage/contract.ts";
import { S3ObjectStore } from "../storage/s3.ts";
import {
  createObjectSnapshot,
  type ObjectSnapshotEntry,
  restoreObjectSnapshot,
  verifyObjectSnapshot,
} from "../storage/snapshot.ts";

interface UpgradeBackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface UpgradeBackupEntry {
  kind: "database" | "storage" | "secrets" | "state";
  sourcePath: string;
  backupPath: string;
  type: "file" | "directory";
  files: UpgradeBackupFile[];
}

interface UpgradeBackupManifest {
  formatVersion: 1;
  reason: "upgrade";
  createdAt: string;
  engine: "pglite" | "postgres";
  fromFormatVersion: number;
  toFormatVersion: number;
  databaseMajor: number | null;
  storageDriver: "local" | "s3";
  effects: UpgradeEffects;
  entries: UpgradeBackupEntry[];
  objects: ObjectSnapshotEntry[];
}

type UpgradeEffect = "read-only" | "write";

interface UpgradeEffects {
  database: UpgradeEffect;
  storage: UpgradeEffect;
  secrets: UpgradeEffect;
}

interface UpgradePlan {
  state: CurrentProjectState;
  effects: UpgradeEffects;
}

export interface UpgradeResult {
  upgraded: boolean;
  fromFormatVersion: number;
  toFormatVersion: number;
  databaseMajor: number | null;
  backupDir: string | null;
  rolledBack: false;
}

export interface UpgradeTestHooks {
  effects?: Partial<UpgradeEffects>;
  afterStateWrite?(context: { storage: ObjectStore | null }): void | Promise<void>;
}

export async function upgradeProject(
  config: MinibaseConfig,
  hooks: UpgradeTestHooks = {},
): Promise<UpgradeResult> {
  const runtime = await readRuntimeState(config.project);
  if (runtime !== null && await runtimeIsLive(runtime)) {
    throw new Error("Stop Minibase before upgrading project data");
  }

  const state = await readProjectState(config.project);
  if (state === null) {
    throw new Error("Project has not been initialized; run `minibase prepare` or start Minibase");
  }
  if (state.engine !== config.database.engine) {
    throw new Error(
      `Project data uses ${state.engine}; rerun upgrade with --engine ${state.engine}`,
    );
  }
  const databaseMajor = await inspectDatabaseMajor(config);
  if (state.formatVersion === PROJECT_FORMAT_VERSION) {
    return {
      upgraded: false,
      fromFormatVersion: state.formatVersion,
      toFormatVersion: PROJECT_FORMAT_VERSION,
      databaseMajor,
      backupDir: null,
      rolledBack: false,
    };
  }
  const createdAt = new Date().toISOString();
  const plan = createUpgradePlan(state, databaseMajor, createdAt, hooks.effects);
  requireRecoverableUpgrade(config, plan);
  const s3Store = config.storage.driver === "s3" && plan.effects.storage === "write"
    ? new S3ObjectStore(config.storage.s3!, { ownershipRequired: true })
    : null;
  await s3Store?.acquireOwnership(config.projectId);
  let result: UpgradeResult | undefined;
  let operationError: unknown;
  try {
    result = await executeUpgrade(config, state, databaseMajor, createdAt, plan, s3Store, hooks);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await s3Store?.releaseOwnership();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (releaseError !== undefined) {
      throw new Error(
        `Upgrade failed and S3 ownership release also failed. Upgrade error: ${
          errorMessage(operationError)
        }. Ownership error: ${errorMessage(releaseError)}`,
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw new Error(
      `Upgrade completed but S3 ownership could not be released: ${errorMessage(releaseError)}`,
      { cause: releaseError },
    );
  }
  if (result === undefined) throw new Error("Upgrade did not return a result");
  return result;
}

async function executeUpgrade(
  config: MinibaseConfig,
  state: LegacyProjectState,
  databaseMajor: number | null,
  createdAt: string,
  plan: UpgradePlan,
  s3Store: S3ObjectStore | null,
  hooks: UpgradeTestHooks,
): Promise<UpgradeResult> {
  const backup = await createUpgradeBackup(
    config,
    state,
    databaseMajor,
    createdAt,
    plan,
    s3Store,
  );
  let remoteMutationStarted = false;
  try {
    await writeProjectState(config.project, plan.state);
    if (s3Store !== null) {
      await verifyObjectSnapshot(s3Store, backup.manifest.objects);
      remoteMutationStarted = true;
    }
    await hooks.afterStateWrite?.({ storage: s3Store });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      await restoreUpgradeBackup(config, backup.outputDir, backup.manifest);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (s3Store !== null && remoteMutationStarted) {
      try {
        await restoreObjectSnapshot(
          s3Store,
          join(backup.outputDir, "objects"),
          backup.manifest.objects,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Upgrade failed and automatic rollback was incomplete. Preserve ${backup.outputDir}. ` +
          `Upgrade error: ${errorMessage(error)}. Rollback error: ${
            rollbackErrors.map(errorMessage).join("; ")
          }`,
        { cause: error },
      );
    }
    throw new Error(
      `Upgrade failed and was rolled back from ${backup.outputDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return {
    upgraded: true,
    fromFormatVersion: state.formatVersion,
    toFormatVersion: PROJECT_FORMAT_VERSION,
    databaseMajor,
    backupDir: backup.outputDir,
    rolledBack: false,
  };
}

async function inspectDatabaseMajor(config: MinibaseConfig): Promise<number | null> {
  if (config.database.engine === "postgres" && !config.database.managed) {
    return await inspectExternalPostgresMajor(config);
  }
  const dataDir = config.database.engine === "pglite"
    ? config.project.pgliteDataDir
    : config.project.postgresDataDir;
  const info = await pathInfo(dataDir);
  if (info === null) return null;
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`Database data path is not a real directory: ${dataDir}`);
  }
  const versionFile = join(dataDir, "PG_VERSION");
  const versionInfo = await pathInfo(versionFile);
  if (versionInfo === null) {
    const entries = [];
    for await (const entry of Deno.readDir(dataDir)) {
      if (entry.name !== ".minibase.lock") entries.push(entry.name);
    }
    if (entries.length === 0) return null;
    throw new Error(
      `Database data directory is not empty but PG_VERSION is missing: ${dataDir}`,
    );
  }
  if (
    !versionInfo.isFile || versionInfo.isSymlink || versionInfo.size < 2 || versionInfo.size > 32
  ) {
    throw new Error(`Database PG_VERSION is not a small regular file: ${versionFile}`);
  }
  const value = (await Deno.readTextFile(versionFile)).trim();
  if (!/^\d+$/u.test(value)) throw new Error(`Database PG_VERSION is invalid: ${versionFile}`);
  const major = Number(value);
  if (major !== SUPPORTED_POSTGRES_MAJOR) {
    throw new Error(
      `Database major version ${major} cannot be opened by this Minibase upgrade; ` +
        `expected PostgreSQL ${SUPPORTED_POSTGRES_MAJOR}`,
    );
  }
  return major;
}

async function inspectExternalPostgresMajor(config: MinibaseConfig): Promise<number> {
  const connectionUrl = config.database.url;
  if (connectionUrl === undefined) {
    throw new Error("External PostgreSQL upgrade requires database.url");
  }
  const engine = new PostgresEngine(connectionUrl, {
    min: 1,
    max: 1,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  try {
    await engine.start();
    const version = await engine.query<{ versionNumber: number }>(
      "select current_setting('server_version_num')::int as \"versionNumber\"",
    );
    const versionNumber = version.rows[0]?.versionNumber;
    if (!Number.isSafeInteger(versionNumber) || Number(versionNumber) < 10_000) {
      throw new Error("External PostgreSQL returned an invalid server_version_num");
    }
    const major = Math.floor(Number(versionNumber) / 10_000);
    if (major !== SUPPORTED_POSTGRES_MAJOR) {
      throw new Error(
        `Database major version ${major} cannot be opened by this Minibase upgrade; ` +
          `expected PostgreSQL ${SUPPORTED_POSTGRES_MAJOR}`,
      );
    }
    return major;
  } finally {
    await engine.close();
  }
}

function createUpgradePlan(
  state: LegacyProjectState,
  databaseMajor: number | null,
  createdAt: string,
  effects: Partial<UpgradeEffects> = {},
): UpgradePlan {
  return {
    state: upgradedProjectState(state, databaseMajor, createdAt),
    effects: {
      database: effects.database ?? "read-only",
      storage: effects.storage ?? "read-only",
      secrets: effects.secrets ?? "read-only",
    },
  };
}

function requireRecoverableUpgrade(config: MinibaseConfig, plan: UpgradePlan): void {
  if (
    config.database.engine === "postgres" && !config.database.managed &&
    plan.effects.database !== "read-only"
  ) {
    throw new Error(
      "Automatic database-mutating upgrade is unavailable for external PostgreSQL because a complete rollback backup cannot be guaranteed",
    );
  }
}

async function createUpgradeBackup(
  config: MinibaseConfig,
  state: LegacyProjectState,
  databaseMajor: number | null,
  createdAt: string,
  plan: UpgradePlan,
  s3Store: S3ObjectStore | null,
): Promise<{ outputDir: string; manifest: UpgradeBackupManifest }> {
  const timestamp = createdAt.replaceAll(/[:.]/g, "-");
  const outputDir = join(
    config.project.backupsDir,
    `upgrade-${timestamp}-v${state.formatVersion}-to-v${PROJECT_FORMAT_VERSION}`,
  );
  const temporaryDir = `${outputDir}.minibase-upgrade-${crypto.randomUUID()}`;
  if (await pathInfo(outputDir) !== null) {
    throw new Error(`Upgrade backup already exists: ${outputDir}`);
  }

  const databaseDir = config.database.engine === "pglite"
    ? config.project.pgliteDataDir
    : config.project.postgresDataDir;
  const candidates: Array<{ kind: UpgradeBackupEntry["kind"]; source: string }> = [
    ...(config.database.engine === "postgres" && !config.database.managed
      ? []
      : [{ kind: "database" as const, source: databaseDir }]),
    ...(config.storage.driver === "local"
      ? [{ kind: "storage" as const, source: config.storage.path }]
      : []),
    { kind: "secrets", source: config.project.secretsFile },
    { kind: "state", source: config.project.stateFile },
  ];
  for (const candidate of candidates) {
    assertInside(config.project.minibaseDir, candidate.source, `${candidate.kind} source`);
    assertDisjoint(candidate.source, outputDir, `${candidate.kind} source`, "upgrade backup");
  }
  assertPairwiseDisjoint(candidates);

  const entries: UpgradeBackupEntry[] = [];
  let objects: ObjectSnapshotEntry[] = [];
  try {
    await Deno.mkdir(join(temporaryDir, "entries"), { recursive: true, mode: 0o700 });
    if (Deno.build.os === "windows") await hardenWindowsPrivateTreeAcl(temporaryDir);
    if (s3Store !== null) {
      objects = await createObjectSnapshot(s3Store, join(temporaryDir, "objects"));
    }
    for (const [index, candidate] of candidates.entries()) {
      const info = await pathInfo(candidate.source);
      if (info === null) continue;
      if (info.isSymlink || (!info.isFile && !info.isDirectory)) {
        throw new Error(`Upgrade source is linked or has an unsupported type: ${candidate.source}`);
      }
      const backupPath = `entries/${String(index).padStart(2, "0")}-${basename(candidate.source)}`;
      const files = await copyEntry(
        candidate.source,
        join(temporaryDir, ...backupPath.split("/")),
      );
      entries.push({
        kind: candidate.kind,
        sourcePath: relative(config.project.minibaseDir, candidate.source).replaceAll("\\", "/"),
        backupPath,
        type: info.isDirectory ? "directory" : "file",
        files,
      });
    }
    const manifest: UpgradeBackupManifest = {
      formatVersion: 1,
      reason: "upgrade",
      createdAt,
      engine: config.database.engine,
      fromFormatVersion: state.formatVersion,
      toFormatVersion: PROJECT_FORMAT_VERSION,
      databaseMajor,
      storageDriver: config.storage.driver,
      effects: plan.effects,
      entries,
      objects,
    };
    await Deno.writeTextFile(
      join(temporaryDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    await Deno.mkdir(config.project.backupsDir, { recursive: true });
    await Deno.rename(temporaryDir, outputDir);
    return { outputDir, manifest };
  } catch (error) {
    await Deno.remove(temporaryDir, { recursive: true }).catch(ignoreNotFound);
    throw error;
  }
}

async function restoreUpgradeBackup(
  config: MinibaseConfig,
  backupDir: string,
  manifest: UpgradeBackupManifest,
): Promise<void> {
  for (const entry of manifest.entries) {
    const source = resolve(join(config.project.minibaseDir, ...entry.sourcePath.split("/")));
    assertInside(config.project.minibaseDir, source, "rollback target");
    const backup = resolve(join(backupDir, ...entry.backupPath.split("/")));
    assertInside(backupDir, backup, "rollback backup entry");
    const temporary = `${source}.minibase-restore-${crypto.randomUUID()}`;
    const displaced = `${source}.minibase-failed-upgrade-${crypto.randomUUID()}`;
    try {
      const files = await copyEntry(backup, temporary);
      assertBackupFiles(entry, files);
      if (await pathInfo(source) !== null) await Deno.rename(source, displaced);
      try {
        await Deno.mkdir(dirname(source), { recursive: true });
        await Deno.rename(temporary, source);
      } catch (error) {
        if (await pathInfo(displaced) !== null && await pathInfo(source) === null) {
          await Deno.rename(displaced, source);
        }
        throw error;
      }
      await Deno.remove(displaced, { recursive: true }).catch(ignoreNotFound);
    } finally {
      await Deno.remove(temporary, { recursive: true }).catch(ignoreNotFound);
    }
  }
}

async function copyEntry(source: string, destination: string): Promise<UpgradeBackupFile[]> {
  const info = await Deno.lstat(source);
  if (info.isSymlink) throw new Error(`Refusing to copy symbolic link during upgrade: ${source}`);
  if (info.isFile) {
    await Deno.mkdir(dirname(destination), { recursive: true });
    return [{ path: "", ...(await copyFile(source, destination)) }];
  }
  if (!info.isDirectory) throw new Error(`Unsupported upgrade backup entry: ${source}`);
  await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
  const files: UpgradeBackupFile[] = [];
  await copyTree(source, destination, "", files);
  return files;
}

async function copyTree(
  source: string,
  destination: string,
  prefix: string,
  files: UpgradeBackupFile[],
): Promise<void> {
  const entries = [];
  for await (const entry of Deno.readDir(source)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymlink) {
      throw new Error(`Refusing to copy symbolic link during upgrade: ${sourcePath}`);
    }
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true, mode: 0o700 });
      await copyTree(sourcePath, destinationPath, path, files);
    } else if (entry.isFile) {
      files.push({ path, ...(await copyFile(sourcePath, destinationPath)) });
    } else {
      throw new Error(`Unsupported filesystem entry during upgrade: ${sourcePath}`);
    }
  }
}

async function copyFile(
  source: string,
  destination: string,
): Promise<{ bytes: number; sha256: string }> {
  const input = await Deno.open(source, { read: true });
  const output = await Deno.open(destination, { createNew: true, write: true, mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const buffer = new Uint8Array(1024 * 1024);
    while (true) {
      const read = await input.read(buffer);
      if (read === null) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      bytes += read;
      let offset = 0;
      while (offset < read) offset += await output.write(chunk.subarray(offset));
    }
    await output.syncData();
  } finally {
    input.close();
    output.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function assertBackupFiles(entry: UpgradeBackupEntry, actual: UpgradeBackupFile[]): void {
  if (JSON.stringify(entry.files) !== JSON.stringify(actual)) {
    throw new Error(`Upgrade rollback backup verification failed for ${entry.kind}`);
  }
}

function assertPairwiseDisjoint(
  candidates: Array<{ kind: UpgradeBackupEntry["kind"]; source: string }>,
): void {
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      assertDisjoint(
        candidates[left]!.source,
        candidates[right]!.source,
        `${candidates[left]!.kind} source`,
        `${candidates[right]!.kind} source`,
      );
    }
  }
}

function assertInside(parent: string, child: string, label: string): void {
  if (!isAbsolute(parent) || !isAbsolute(child)) throw new Error("Upgrade paths must be absolute");
  const relation = relative(parent, child);
  if (
    relation === "" || relation === ".." || relation.startsWith(`..${SEPARATOR}`) ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} must be inside ${parent}: ${child}`);
  }
}

function assertDisjoint(left: string, right: string, leftLabel: string, rightLabel: string): void {
  if (containsPath(left, right) || containsPath(right, left)) {
    throw new Error(`${leftLabel} ${left} overlaps ${rightLabel} ${right}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" ||
    !(relation === ".." || relation.startsWith(`..${SEPARATOR}`) || isAbsolute(relation));
}

async function pathInfo(path: string): Promise<
  {
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
    size: number;
  } | null
> {
  try {
    const info = await Deno.lstat(path);
    return {
      isFile: info.isFile,
      isDirectory: info.isDirectory,
      isSymlink: info.isSymlink,
      size: info.size,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
