import { createHash } from "node:crypto";
import { join } from "@std/path";
import type { ListedObject, ObjectStore, StoredObject } from "./contract.ts";

export interface ObjectSnapshotEntry {
  bucket: string;
  name: string;
  backendKey: string;
  size: number;
  sha256: string;
  path: string;
  contentType?: string;
}

export async function createObjectSnapshot(
  store: ObjectStore,
  outputDir: string,
): Promise<ObjectSnapshotEntry[]> {
  const methods = snapshotMethods(store);
  const listed = sortListed(await snapshotObjects(methods.list));
  await Deno.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const snapshot: ObjectSnapshotEntry[] = [];
  for (const [index, object] of listed.entries()) {
    const backendKey = requiredBackendKey(object);
    const stored = await methods.readListed(object);
    const path = `${String(index).padStart(6, "0")}.bin`;
    const copied = await copyBodyToFile(stored, join(outputDir, path));
    assertObjectSize(object, stored, copied.bytes);
    snapshot.push({
      bucket: object.bucket,
      name: object.name,
      backendKey,
      size: copied.bytes,
      sha256: copied.sha256,
      path,
      ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }),
    });
  }
  return snapshot;
}

export async function clearObjectStore(
  store: ObjectStore,
  snapshot: ObjectSnapshotEntry[],
  onMutationStart: () => void = () => {},
): Promise<void> {
  const methods = snapshotMethods(store);
  const listed = sortListed(await snapshotObjects(methods.list));
  assertInventory(snapshot, listed);
  if (listed.length > 0) onMutationStart();
  for (const object of listed) await methods.removeListed(object);
  const remaining = await snapshotObjects(methods.list);
  if (remaining.length !== 0) {
    throw new Error(`Storage reset left ${remaining.length} remote object(s)`);
  }
}

export async function restoreObjectSnapshot(
  store: ObjectStore,
  inputDir: string,
  snapshot: ObjectSnapshotEntry[],
): Promise<void> {
  const methods = snapshotMethods(store);
  for (const object of await snapshotObjects(methods.list)) await methods.removeListed(object);
  for (const entry of snapshot) {
    const file = await Deno.open(join(inputDir, entry.path), { read: true });
    await methods.restoreListed(snapshotObject(entry), file.readable, entry.contentType);
  }
  await verifyObjectSnapshot(store, snapshot);
}

export async function verifyObjectSnapshot(
  store: ObjectStore,
  snapshot: ObjectSnapshotEntry[],
): Promise<void> {
  const methods = snapshotMethods(store);
  const listed = sortListed(await snapshotObjects(methods.list));
  assertInventory(snapshot, listed);
  for (const entry of snapshot) {
    const stored = await methods.readListed(snapshotObject(entry));
    const hashed = await hashBody(stored.body);
    assertObjectSize(snapshotObject(entry), stored, hashed.bytes);
    if (hashed.sha256 !== entry.sha256) {
      throw new Error(`Storage rollback checksum mismatch for ${entry.backendKey}`);
    }
  }
}

function snapshotMethods(store: ObjectStore): {
  list: NonNullable<ObjectStore["list"]>;
  readListed: NonNullable<ObjectStore["readListed"]>;
  removeListed: NonNullable<ObjectStore["removeListed"]>;
  restoreListed: NonNullable<ObjectStore["restoreListed"]>;
} {
  if (
    store.list === undefined || store.readListed === undefined ||
    store.removeListed === undefined || store.restoreListed === undefined
  ) {
    throw new Error(`${store.driver} Storage does not support complete object snapshots`);
  }
  return {
    list: store.list.bind(store),
    readListed: store.readListed.bind(store),
    removeListed: store.removeListed.bind(store),
    restoreListed: store.restoreListed.bind(store),
  };
}

function sortListed(objects: ListedObject[]): ListedObject[] {
  return objects.toSorted((left, right) =>
    requiredBackendKey(left).localeCompare(requiredBackendKey(right), "en")
  );
}

async function snapshotObjects(
  list: NonNullable<ObjectStore["list"]>,
): Promise<ListedObject[]> {
  return (await list()).filter((object) => object.kind !== "control");
}

function assertInventory(snapshot: ObjectSnapshotEntry[], listed: ListedObject[]): void {
  const expected = snapshot.map((entry) => ({ key: entry.backendKey, size: entry.size }));
  const actual = listed.map((object) => ({
    key: requiredBackendKey(object),
    size: object.size,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Remote Storage changed while the reset snapshot was being applied");
  }
}

function requiredBackendKey(object: ListedObject): string {
  if (object.backendKey === undefined || object.backendKey.length === 0) {
    throw new Error("Listed Storage object is missing its backend key");
  }
  return object.backendKey;
}

function snapshotObject(entry: ObjectSnapshotEntry): ListedObject {
  return {
    bucket: entry.bucket,
    name: entry.name,
    backendKey: entry.backendKey,
    size: entry.size,
  };
}

async function copyBodyToFile(
  stored: StoredObject,
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const output = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
  try {
    return await hashBody(stored.body, async (chunk) => {
      let offset = 0;
      while (offset < chunk.byteLength) offset += await output.write(chunk.subarray(offset));
    });
  } finally {
    try {
      await output.syncData();
    } finally {
      output.close();
    }
  }
}

async function hashBody(
  body: ReadableStream<Uint8Array> | null,
  consume: (chunk: Uint8Array) => Promise<void> = () => Promise.resolve(),
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  if (body !== null) {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        hash.update(result.value);
        bytes += result.value.byteLength;
        await consume(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

function assertObjectSize(object: ListedObject, stored: StoredObject, actual: number): void {
  if (stored.size !== undefined && stored.size !== actual) {
    throw new Error(`Storage object Content-Length changed for ${requiredBackendKey(object)}`);
  }
  if (object.size !== actual) {
    throw new Error(`Storage object size changed for ${requiredBackendKey(object)}`);
  }
}
