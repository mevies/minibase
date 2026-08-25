import type { DatabaseEngine } from "../database/contract.ts";
import type { ListedObject, ObjectStore } from "./contract.ts";

interface MetadataRow {
  bucket_id: string;
  name: string;
  size: number | null;
}

export interface StorageConsistencyReport {
  ok: boolean;
  missingFiles: Array<{ bucket: string; name: string }>;
  orphanFiles: Array<{ bucket: string; name: string; size: number }>;
  temporaryFiles: Array<{ bucket: string; name: string; size: number }>;
  sizeMismatches: Array<{
    bucket: string;
    name: string;
    metadataSize: number | null;
    actualSize: number;
  }>;
  repaired: boolean;
}

export async function checkStorageConsistency(
  engine: DatabaseEngine,
  store: ObjectStore,
  options: { repair?: boolean; force?: boolean } = {},
): Promise<StorageConsistencyReport> {
  if (store.list === undefined) {
    throw new Error(`Storage consistency listing is not implemented for ${store.driver}`);
  }
  if (options.repair && !options.force) {
    throw new Error("Storage repair requires --force because it modifies files and metadata");
  }
  const metadata = await engine.query<MetadataRow>(
    `select bucket_id, name, nullif(metadata ->> 'size', '')::double precision as size
     from storage.objects order by bucket_id, name`,
  );
  const files = await store.list();
  const metadataMap = new Map(metadata.rows.map((row) => [`${row.bucket_id}\0${row.name}`, row]));
  const fileMap = new Map(files.map((file) => [`${file.bucket}\0${file.name}`, file]));
  const missingFiles: StorageConsistencyReport["missingFiles"] = [];
  const orphanFiles: StorageConsistencyReport["orphanFiles"] = [];
  const temporaryFiles: StorageConsistencyReport["temporaryFiles"] = [];
  const sizeMismatches: StorageConsistencyReport["sizeMismatches"] = [];
  const repairTargets: ListedObject[] = [];

  for (const [key, row] of metadataMap) {
    const file = fileMap.get(key);
    if (file === undefined) {
      missingFiles.push({ bucket: row.bucket_id, name: row.name });
    } else if (row.size !== null && row.size !== file.size) {
      sizeMismatches.push({
        bucket: row.bucket_id,
        name: row.name,
        metadataSize: row.size,
        actualSize: file.size,
      });
    }
  }
  for (const [key, file] of fileMap) {
    if (file.kind === "control") continue;
    if (
      file.kind === "temporary" || file.name.includes(".minibase-upload-") ||
      file.backendKey?.startsWith(".minibase-tmp/") === true
    ) {
      temporaryFiles.push(publicFile(file));
      repairTargets.push(file);
    } else if (!metadataMap.has(key)) {
      orphanFiles.push(publicFile(file));
      repairTargets.push(file);
    }
  }

  if (options.repair) {
    await engine.transaction(async (session) => {
      for (const item of missingFiles) {
        await session.query("delete from storage.objects where bucket_id = $1 and name = $2", [
          item.bucket,
          item.name,
        ]);
      }
      for (const item of sizeMismatches) {
        await session.query(
          `update storage.objects
           set metadata = jsonb_set(metadata, '{size}', to_jsonb($3::bigint)), updated_at = now()
           where bucket_id = $1 and name = $2`,
          [item.bucket, item.name, item.actualSize],
        );
      }
    });
    for (const item of repairTargets) {
      if (store.removeListed !== undefined) await store.removeListed(item);
      else await store.remove(item.bucket, item.name);
    }
  }

  return {
    ok: missingFiles.length === 0 && orphanFiles.length === 0 &&
      temporaryFiles.length === 0 && sizeMismatches.length === 0,
    missingFiles,
    orphanFiles,
    temporaryFiles,
    sizeMismatches,
    repaired: options.repair === true,
  };
}

function publicFile(file: ListedObject): { bucket: string; name: string; size: number } {
  return { bucket: file.bucket, name: file.name, size: file.size };
}
