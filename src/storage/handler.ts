import type { AuthService } from "../auth/service.ts";
import type { DatabaseEngine, QueryRow, RequestDatabaseContext } from "../database/contract.ts";
import { type ObjectStore, ObjectStoreError } from "./contract.ts";
import { parseMultipartFile } from "./multipart.ts";

interface StorageObjectRow extends QueryRow {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  metadata: {
    mimetype?: string;
    size?: number;
    cacheControl?: string;
  };
  user_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface StorageBucketRow extends QueryRow {
  file_size_limit: number | string | null;
  allowed_mime_types: string[] | null;
}

class StorageRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

class ObjectMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(bucket: string, name: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([bucket, name]);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.then(() => release.promise);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release.resolve();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  async runMany<T>(
    objects: Array<{ bucket: string; name: string }>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const unique = new Map(
      objects.map((object) => [JSON.stringify([object.bucket, object.name]), object]),
    );
    const ordered = [...unique.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ).map(([, object]) => object);
    const runAt = (index: number): Promise<T> => {
      const object = ordered[index];
      return object === undefined
        ? operation()
        : this.run(object.bucket, object.name, () => runAt(index + 1));
    };
    return await runAt(0);
  }
}

function storageError(error: unknown, status = 400): Response {
  const candidate = error as { code?: string; message?: string };
  return Response.json(
    {
      statusCode: String(status),
      error: candidate.code ?? "StorageError",
      message: candidate.message ?? String(error),
    },
    { status },
  );
}

function objectPath(pathname: string, prefix: string): { bucket: string; name: string } | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const suffix = pathname.slice(prefix.length);
  if (suffix.startsWith("list/") || suffix.startsWith("sign/")) {
    return null;
  }
  const parts = suffix.split("/").map(decodeURIComponent);
  const bucket = parts.shift();
  if (bucket === undefined || bucket.length === 0 || parts.length === 0) {
    return null;
  }
  return { bucket, name: parts.join("/") };
}

function specialObjectPath(
  pathname: string,
  prefix: string,
): { bucket: string; name: string } | null {
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/").map(decodeURIComponent);
  const bucket = parts.shift();
  if (bucket === undefined || bucket.length === 0 || parts.length === 0) return null;
  return { bucket, name: parts.join("/") };
}

async function context(auth: AuthService, request: Request): Promise<RequestDatabaseContext> {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    throw new Error("Missing authorization header");
  }
  return await auth.resolveRequestContext(request);
}

export function createStorageHandler(
  engine: DatabaseEngine,
  auth: AuthService,
  store: ObjectStore,
) {
  const objectMutations = new ObjectMutationQueue();
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/storage/v1/")) {
      return null;
    }

    try {
      if (request.method === "POST" && url.pathname === "/storage/v1/bucket") {
        const requestContext = await context(auth, request);
        if (requestContext.role !== "service_role") {
          return storageError(new Error("Only service_role can create buckets"), 403);
        }
        const input = await request.json() as {
          id?: string;
          name?: string;
          public?: boolean;
          file_size_limit?: number | null;
          allowed_mime_types?: string[] | null;
        };
        const id = input.id ?? input.name;
        const name = input.name ?? input.id;
        if (id === undefined || name === undefined) {
          throw new Error("Bucket id and name are required");
        }
        await engine.withRequestContext(requestContext, (session) =>
          session.query(
            `insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
             values ($1, $2, $3, $4, $5)
             on conflict (id) do update set
               name = excluded.name,
               public = excluded.public,
               file_size_limit = excluded.file_size_limit,
               allowed_mime_types = excluded.allowed_mime_types,
               updated_at = now()`,
            [
              id,
              name,
              input.public ?? false,
              input.file_size_limit ?? null,
              input.allowed_mime_types ?? null,
            ],
          ));
        return Response.json({ name }, { status: 200 });
      }

      const signedObject = specialObjectPath(url.pathname, "/storage/v1/object/sign/");
      if (signedObject !== null && request.method === "POST") {
        const requestContext = await context(auth, request);
        const input = await request.json() as { expiresIn?: number };
        await objectMetadata(engine, requestContext, signedObject.bucket, signedObject.name);
        const token = await auth.createSignedObjectToken(
          signedObject.bucket,
          signedObject.name,
          input.expiresIn ?? 60,
        );
        return Response.json({
          signedURL: `/object/sign/${encodeURIComponent(signedObject.bucket)}/${
            signedObject.name.split("/").map(encodeURIComponent).join("/")
          }?token=${encodeURIComponent(token)}`,
        });
      }

      if (signedObject !== null && request.method === "GET") {
        const token = url.searchParams.get("token");
        if (token === null) return storageError(new Error("Signed URL token is required"), 401);
        await auth.verifySignedObjectToken(token, signedObject.bucket, signedObject.name);
        return await downloadObject(
          engine,
          store,
          { role: "service_role", claims: { role: "service_role" } },
          signedObject.bucket,
          signedObject.name,
        );
      }

      const publicObject = specialObjectPath(url.pathname, "/storage/v1/object/public/");
      if (publicObject !== null && request.method === "GET") {
        const bucket = await engine.query<{ public: boolean }>(
          "select public from storage.buckets where id = $1",
          [publicObject.bucket],
        );
        if (bucket.rows[0]?.public !== true) {
          return storageError(new Error("Bucket is not public"), 404);
        }
        return await downloadObject(
          engine,
          store,
          { role: "service_role", claims: { role: "service_role" } },
          publicObject.bucket,
          publicObject.name,
        );
      }

      const object = objectPath(url.pathname, "/storage/v1/object/");
      if (object !== null && (request.method === "POST" || request.method === "PUT")) {
        const requestContext = await context(auth, request);
        const owner = typeof requestContext.claims.sub === "string"
          ? requestContext.claims.sub
          : null;
        const requestContentType = request.headers.get("content-type") ??
          "application/octet-stream";
        let objectContentType = requestContentType;
        let objectBody: ReadableStream<Uint8Array> | null = request.body;
        let cacheControl = normalizeCacheControl(request.headers.get("cache-control"));
        let userMetadata = parseUserMetadataHeader(request.headers.get("x-metadata"));
        if (requestContentType.toLowerCase().startsWith("multipart/form-data")) {
          const file = await parseMultipartFile(request, requestContentType);
          objectContentType = file.contentType;
          objectBody = file.body;
          cacheControl = normalizeCacheControl(file.fields.cacheControl ?? null, true);
          userMetadata = parseUserMetadata(file.fields.metadata ?? null);
        }
        const bucket = await storageBucket(engine, object.bucket);
        if (!mimeTypeAllowed(objectContentType, bucket.allowed_mime_types)) {
          throw new StorageRequestError(
            `MIME type ${objectContentType} is not allowed for bucket ${object.bucket}`,
            415,
            "InvalidMimeType",
          );
        }
        const maximumSize = fileSizeLimit(bucket.file_size_limit);
        if (maximumSize !== null && objectBody !== null) {
          objectBody = limitBody(objectBody, maximumSize);
        }
        return await objectMutations.run(object.bucket, object.name, async () => {
          const upload = await store.write(object.bucket, object.name, objectBody);
          try {
            await engine.withRequestContext(requestContext, async (session) => {
              const upsert = request.method === "PUT" ||
                request.headers.get("x-upsert")?.toLowerCase() === "true";
              const metadata = JSON.stringify({
                mimetype: objectContentType,
                size: upload.size,
                ...(cacheControl === undefined ? {} : { cacheControl }),
              });
              const userMetadataJson = JSON.stringify(userMetadata);
              const statement = upsert
                ? `insert into storage.objects(
                     id, bucket_id, name, owner, metadata, user_metadata, version
                   )
                   values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7)
                   on conflict (bucket_id, name) do update set
                     owner = excluded.owner,
                     metadata = excluded.metadata,
                     user_metadata = excluded.user_metadata,
                     version = excluded.version,
                     updated_at = now()`
                : `insert into storage.objects(
                     id, bucket_id, name, owner, metadata, user_metadata, version
                   )
                   values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7)`;
              await session.query(
                statement,
                [
                  crypto.randomUUID(),
                  object.bucket,
                  object.name,
                  owner,
                  metadata,
                  userMetadataJson,
                  upload.writeId,
                ],
              );
              await upload.commit();
            });
          } catch (error) {
            await upload.rollback();
            throw error;
          }
          await upload.finalize();
          return Response.json({ Key: `${object.bucket}/${object.name}` });
        });
      }

      if (object !== null && request.method === "GET") {
        const requestContext = await context(auth, request);
        return await downloadObject(engine, store, requestContext, object.bucket, object.name);
      }

      const listPrefix = "/storage/v1/object/list/";
      if (request.method === "POST" && url.pathname.startsWith(listPrefix)) {
        const bucket = decodeURIComponent(url.pathname.slice(listPrefix.length));
        const requestContext = await context(auth, request);
        const input = await request.json() as {
          prefix?: string;
          limit?: number;
          offset?: number;
          search?: string;
        };
        const prefix = input.prefix ?? "";
        const search = input.search ?? "";
        const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000);
        const offset = Math.max(input.offset ?? 0, 0);
        const result = await engine.withRequestContext(
          requestContext,
          (session) =>
            session.query<StorageObjectRow>(
              `select id, bucket_id, name, owner, metadata, user_metadata, created_at, updated_at
             from storage.objects
             where bucket_id = $1 and name like $2 and name like $3
             order by name asc limit $4 offset $5`,
              [bucket, `${prefix}%`, `%${search}%`, limit, offset],
            ),
        );
        return Response.json(result.rows);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/storage/v1/object/")) {
        const bucket = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
        const requestContext = await context(auth, request);
        const input = await request.json() as { prefixes?: string[] };
        const names = input.prefixes ?? [];
        return await objectMutations.runMany(
          names.map((name) => ({ bucket, name })),
          async () => {
            const removed = await engine.withRequestContext(requestContext, async (session) => {
              const rows: StorageObjectRow[] = [];
              for (const name of names) {
                const result = await session.query<StorageObjectRow>(
                  `delete from storage.objects
               where bucket_id = $1 and name = $2
               returning id, bucket_id, name, owner, metadata, user_metadata, created_at, updated_at`,
                  [bucket, name],
                );
                rows.push(...result.rows);
              }
              return rows;
            });
            for (const row of removed) {
              try {
                await store.remove(row.bucket_id, row.name);
              } catch (error) {
                if (
                  error instanceof ObjectStoreError &&
                  error.code.startsWith("StorageOwnership")
                ) {
                  throw error;
                }
              }
            }
            return Response.json(removed);
          },
        );
      }

      return storageError(new Error(`No Storage route for ${request.method} ${url.pathname}`), 404);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = error instanceof StorageRequestError || error instanceof ObjectStoreError
        ? error.status
        : code === "42501"
        ? 403
        : 400;
      return storageError(error, status);
    }
  };
}

async function storageBucket(engine: DatabaseEngine, bucket: string): Promise<StorageBucketRow> {
  const result = await engine.query<StorageBucketRow>(
    `select file_size_limit, allowed_mime_types from storage.buckets where id = $1`,
    [bucket],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new StorageRequestError(`Bucket ${bucket} was not found`, 404, "NoSuchBucket");
  }
  return row;
}

function fileSizeLimit(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Bucket file_size_limit is outside the supported safe integer range");
  }
  return parsed;
}

function mimeTypeAllowed(contentType: string, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  const actual = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return allowed.some((entry) => {
    const expected = entry.trim().toLowerCase();
    return expected === actual ||
      (expected.endsWith("/*") && actual.startsWith(expected.slice(0, -1)));
  });
}

function normalizeCacheControl(value: string | null, secondsOnly = false): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 1_024 || /[\r\n]/u.test(trimmed)) {
    throw new StorageRequestError("cacheControl is invalid", 400, "InvalidCacheControl");
  }
  if (/^\d+$/u.test(trimmed)) return `max-age=${trimmed}`;
  if (secondsOnly) {
    throw new StorageRequestError(
      "Multipart cacheControl must be a non-negative integer number of seconds",
      400,
      "InvalidCacheControl",
    );
  }
  return trimmed;
}

function parseUserMetadataHeader(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return parseUserMetadata(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof StorageRequestError) throw error;
    throw new StorageRequestError("x-metadata is not valid base64 UTF-8", 400, "InvalidMetadata");
  }
}

function parseUserMetadata(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  if (new TextEncoder().encode(value).byteLength > 64 * 1_024) {
    throw new StorageRequestError("User metadata exceeds 65536 bytes", 400, "InvalidMetadata");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StorageRequestError("User metadata must be valid JSON", 400, "InvalidMetadata");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new StorageRequestError("User metadata must be a JSON object", 400, "InvalidMetadata");
  }
  return parsed as Record<string, unknown>;
}

function limitBody(
  body: ReadableStream<Uint8Array>,
  maximumSize: number,
): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maximumSize) {
          throw new StorageRequestError(
            `Object exceeds the bucket file size limit of ${maximumSize} bytes`,
            413,
            "EntityTooLarge",
          );
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function objectMetadata(
  engine: DatabaseEngine,
  requestContext: RequestDatabaseContext,
  bucket: string,
  name: string,
): Promise<StorageObjectRow> {
  const metadata = await engine.withRequestContext(
    requestContext,
    (session) =>
      session.query<StorageObjectRow>(
        `select id, bucket_id, name, owner, metadata, user_metadata, created_at, updated_at
         from storage.objects where bucket_id = $1 and name = $2`,
        [bucket, name],
      ),
  );
  const row = metadata.rows[0];
  if (row === undefined) throw new Error("Object not found");
  return row;
}

async function downloadObject(
  engine: DatabaseEngine,
  store: ObjectStore,
  requestContext: RequestDatabaseContext,
  bucket: string,
  name: string,
): Promise<Response> {
  let row: StorageObjectRow;
  try {
    row = await objectMetadata(engine, requestContext, bucket, name);
  } catch (error) {
    if (error instanceof Error && error.message === "Object not found") {
      return storageError(error, 404);
    }
    throw error;
  }
  try {
    const file = await store.read(bucket, name);
    const headers = new Headers({
      "content-type": row.metadata.mimetype ?? file.contentType ?? "application/octet-stream",
      "content-length": String(row.metadata.size ?? file.size ?? 0),
    });
    if (row.metadata.cacheControl !== undefined) {
      headers.set("cache-control", row.metadata.cacheControl);
    }
    return new Response(file.body, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return storageError(new Error("Object not found"), 404);
    }
    throw error;
  }
}
