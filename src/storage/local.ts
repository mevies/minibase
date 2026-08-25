import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import {
  type ObjectRecoveryReport,
  type ObjectStore,
  ObjectStoreError,
  type PendingObjectRecovery,
  type PendingObjectWrite,
  type StoredObject,
} from "./contract.ts";

interface LocalWriteTarget {
  writable: WritableStream<Uint8Array>;
  close(): void;
}

interface LocalWriteManifest extends PendingObjectRecovery {
  formatVersion: 1;
}

interface LocalWritePaths {
  target: string;
  temporary: string;
  backup: string;
  journalDir: string;
}

const INTERNAL_DIRECTORY = ".minibase-internal";

function validateBucket(bucket: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(bucket)) {
    throw new Error("Invalid storage bucket name");
  }
}

function validateObjectName(name: string): void {
  if (
    name.length === 0 || name.startsWith("/") || name.includes("\0") ||
    name.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new Error("Invalid storage object name");
  }
}

export class LocalObjectStore implements ObjectStore {
  readonly driver = "local" as const;
  constructor(private readonly root: string) {}

  async health(): Promise<boolean> {
    const healthDir = join(this.root, INTERNAL_DIRECTORY, "health");
    const probe = join(healthDir, `${crypto.randomUUID()}.probe`);
    try {
      await Deno.mkdir(healthDir, { recursive: true });
      await Deno.writeTextFile(probe, "ok", { createNew: true });
      await Deno.remove(probe);
      return true;
    } catch {
      await Deno.remove(probe).catch(() => undefined);
      return false;
    }
  }

  async write(
    bucket: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PendingObjectWrite> {
    const writeId = crypto.randomUUID();
    const paths = this.writePaths(bucket, name, writeId);
    let file: LocalWriteTarget | null = null;
    let size = 0;
    try {
      await this.createJournal({ formatVersion: 1, writeId, bucket, name }, paths.journalDir);
      await Deno.mkdir(dirname(paths.target), { recursive: true });
      file = await this.openTemporary(paths.temporary);
      if (body !== null) {
        await body.pipeTo(file.writable);
      } else {
        file.close();
      }
      size = (await Deno.stat(paths.temporary)).size;
    } catch (error) {
      try {
        file?.close();
      } catch {
        // The stream may already have closed the file.
      }
      await Deno.remove(paths.temporary).catch(() => {});
      await Deno.remove(paths.journalDir, { recursive: true }).catch(() => {});
      if (isStorageCapacityError(error)) {
        throw new ObjectStoreError(
          "Local storage capacity is exhausted",
          "StorageCapacityExceeded",
          507,
          { cause: error },
        );
      }
      throw error;
    }
    let committed = false;
    return {
      writeId,
      size,
      commit: async () => {
        try {
          if (await exists(paths.target)) {
            await Deno.rename(paths.target, paths.backup);
            await markPhase(paths.journalDir, "backed-up");
          }
          await markPhase(paths.journalDir, "switching");
          await Deno.rename(paths.temporary, paths.target);
          committed = true;
          await markPhase(paths.journalDir, "switched");
        } catch (error) {
          await rollbackPaths(paths, committed);
          committed = false;
          throw error;
        }
      },
      rollback: async () => {
        await rollbackPaths(paths, committed);
        committed = false;
      },
      finalize: async () => {
        await finalizePaths(paths);
        committed = false;
      },
    };
  }

  async read(bucket: string, name: string): Promise<StoredObject> {
    const file = await Deno.open(this.path(bucket, name), { read: true });
    return { body: file.readable, size: (await file.stat()).size };
  }

  async remove(bucket: string, name: string): Promise<void> {
    await Deno.remove(this.path(bucket, name));
  }

  path(bucket: string, name: string): string {
    validateBucket(bucket);
    validateObjectName(name);
    const bucketRoot = resolve(join(this.root, bucket));
    const target = resolve(join(bucketRoot, ...name.split("/")));
    const relation = relative(bucketRoot, target);
    if (relation === ".." || relation.startsWith(`..${SEPARATOR}`)) {
      throw new Error("Storage path escapes the configured root");
    }
    return target;
  }

  async list(): Promise<Array<{ bucket: string; name: string; size: number }>> {
    const objects: Array<{ bucket: string; name: string; size: number }> = [];
    try {
      for await (const bucket of Deno.readDir(this.root)) {
        if (!bucket.isDirectory || bucket.name === INTERNAL_DIRECTORY) continue;
        const bucketPath = join(this.root, bucket.name);
        for await (const file of walk(bucketPath)) {
          const name = relative(bucketPath, file).split(SEPARATOR).join("/");
          objects.push({ bucket: bucket.name, name, size: (await Deno.stat(file)).size });
        }
      }
      return objects;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  protected async openTemporary(path: string): Promise<LocalWriteTarget> {
    return await Deno.open(path, { createNew: true, write: true });
  }

  async recoverPendingWrites(
    isMetadataCommitted: (write: PendingObjectRecovery) => Promise<boolean>,
  ): Promise<ObjectRecoveryReport> {
    const report: ObjectRecoveryReport = { rolledBack: 0, finalized: 0 };
    const writesRoot = this.writesRoot();
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(writesRoot)) entries.push(entry);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return report;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory) continue;
      if (entry.name.endsWith(".tmp")) {
        await Deno.remove(join(writesRoot, entry.name), { recursive: true });
        continue;
      }
      const manifest = await this.readJournal(entry.name);
      const paths = this.writePaths(manifest.bucket, manifest.name, manifest.writeId);
      if (await isMetadataCommitted(manifest)) {
        if (!(await exists(paths.target))) {
          throw new ObjectStoreError(
            `Storage recovery cannot finalize missing object ${manifest.bucket}/${manifest.name}`,
            "StorageRecoveryRequired",
            503,
          );
        }
        await finalizePaths(paths);
        report.finalized++;
      } else {
        const switched = await phaseExists(paths.journalDir, "switched") ||
          (await phaseExists(paths.journalDir, "switching") &&
            !(await exists(paths.temporary)) && await exists(paths.target));
        await rollbackPaths(paths, switched);
        report.rolledBack++;
      }
    }
    return report;
  }

  private writePaths(bucket: string, name: string, writeId: string): LocalWritePaths {
    validateWriteId(writeId);
    const target = this.path(bucket, name);
    return {
      target,
      temporary: `${target}.minibase-upload-${writeId}`,
      backup: `${target}.minibase-upload-backup-${writeId}`,
      journalDir: join(this.writesRoot(), writeId),
    };
  }

  private writesRoot(): string {
    return join(this.root, INTERNAL_DIRECTORY, "writes");
  }

  private async createJournal(manifest: LocalWriteManifest, journalDir: string): Promise<void> {
    const writesRoot = dirname(journalDir);
    const stagingDir = `${journalDir}.tmp`;
    await Deno.mkdir(writesRoot, { recursive: true });
    await Deno.mkdir(stagingDir);
    try {
      await Deno.writeTextFile(
        join(stagingDir, "manifest.json"),
        `${JSON.stringify(manifest)}\n`,
        { createNew: true },
      );
      await Deno.rename(stagingDir, journalDir);
    } catch (error) {
      await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  private async readJournal(writeId: string): Promise<LocalWriteManifest> {
    validateWriteId(writeId);
    const path = join(this.writesRoot(), writeId, "manifest.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      throw new ObjectStoreError(
        `Storage recovery journal ${writeId} is unreadable`,
        "StorageRecoveryRequired",
        503,
        { cause: error },
      );
    }
    if (!isLocalWriteManifest(parsed) || parsed.writeId !== writeId) {
      throw new ObjectStoreError(
        `Storage recovery journal ${writeId} is invalid`,
        "StorageRecoveryRequired",
        503,
      );
    }
    return parsed;
  }
}

function isStorageCapacityError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "ENOSPC") return true;
  return typeof candidate.message === "string" &&
    /(?:no space left|not enough space|os error (?:28|112))/iu.test(candidate.message);
}

function validateWriteId(writeId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(writeId)) {
    throw new Error("Invalid storage write id");
  }
}

function isLocalWriteManifest(value: unknown): value is LocalWriteManifest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<LocalWriteManifest>;
  return candidate.formatVersion === 1 && typeof candidate.writeId === "string" &&
    typeof candidate.bucket === "string" && typeof candidate.name === "string";
}

async function markPhase(
  journalDir: string,
  phase: "backed-up" | "switching" | "switched",
): Promise<void> {
  await Deno.writeTextFile(join(journalDir, phase), "\n", { createNew: true });
}

async function phaseExists(
  journalDir: string,
  phase: "backed-up" | "switching" | "switched",
): Promise<boolean> {
  return await exists(join(journalDir, phase));
}

async function rollbackPaths(paths: LocalWritePaths, knownSwitched: boolean): Promise<void> {
  const backupExists = await exists(paths.backup);
  if (knownSwitched) await removeFileIfExists(paths.target);
  if (backupExists) await Deno.rename(paths.backup, paths.target);
  await removeFileIfExists(paths.temporary);
  await removeDirectoryIfExists(paths.journalDir);
}

async function finalizePaths(paths: LocalWritePaths): Promise<void> {
  await removeFileIfExists(paths.temporary);
  await removeFileIfExists(paths.backup);
  await removeDirectoryIfExists(paths.journalDir);
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function removeDirectoryIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function* walk(path: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.isFile) yield child;
  }
}
