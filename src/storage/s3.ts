import type { MinibaseConfig } from "../config/types.ts";
import {
  type ListedObject,
  type ObjectStore,
  ObjectStoreError,
  type PendingObjectWrite,
  type StoredObject,
} from "./contract.ts";

type S3Config = NonNullable<MinibaseConfig["storage"]["s3"]>;
const MAX_COPY_RESPONSE_BYTES = 64 * 1_024;
const MAX_LIST_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_OWNERSHIP_RESPONSE_BYTES = 16 * 1_024;
const HEALTH_TIMEOUT_MS = 2_000;
const OWNERSHIP_HEARTBEAT_MS = 5_000;
const OWNERSHIP_KEY = ".minibase/ownership-v1.json";

export interface S3ObjectStoreOptions {
  ownershipRequired?: boolean;
  ownershipHeartbeatMs?: number;
}

export interface ForcedOwnershipRelease {
  released: boolean;
  previousState: "missing" | "released" | "active";
}

interface OwnershipRecord {
  formatVersion: 1;
  state: "active" | "released";
  instanceId: string;
  projectId: string;
  processId: number;
  acquiredAt: string;
  observedAt: string;
  releasedAt?: string;
  releasedByProjectId?: string;
}

interface ActiveOwnership {
  record: OwnershipRecord;
  etag: string;
}

interface StoredOwnership {
  record: OwnershipRecord;
  etag: string;
}

export class S3ObjectStore implements ObjectStore {
  readonly driver = "s3" as const;
  readonly #ownershipRequired: boolean;
  readonly #ownershipHeartbeatMs: number;
  #ownership: ActiveOwnership | null = null;
  #ownershipFailure: ObjectStoreError | null = null;
  #ownershipHeartbeat: ReturnType<typeof setInterval> | null = null;
  #ownershipControl: Promise<void> = Promise.resolve();

  constructor(private readonly config: S3Config, options: S3ObjectStoreOptions = {}) {
    this.#ownershipRequired = options.ownershipRequired ?? false;
    this.#ownershipHeartbeatMs = options.ownershipHeartbeatMs ?? OWNERSHIP_HEARTBEAT_MS;
    if (
      !Number.isSafeInteger(this.#ownershipHeartbeatMs) || this.#ownershipHeartbeatMs < 10 ||
      this.#ownershipHeartbeatMs > 60_000
    ) {
      throw new Error("S3 ownership heartbeat must be between 10 and 60000 milliseconds");
    }
  }

  async acquireOwnership(projectId: string): Promise<void> {
    validateProjectId(projectId);
    if (this.#ownership !== null) {
      throw new ObjectStoreError(
        "S3 bucket ownership is already held by this Minibase instance",
        "StorageOwnershipConflict",
        409,
      );
    }
    this.#ownershipFailure = null;
    const acquiredAt = new Date().toISOString();
    const record: OwnershipRecord = {
      formatVersion: 1,
      state: "active",
      instanceId: crypto.randomUUID(),
      projectId,
      processId: Deno.pid,
      acquiredAt,
      observedAt: acquiredAt,
    };

    await this.#withOwnershipControl(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const created = await this.#putOwnership(record, { "if-none-match": "*" }, [412]);
        if (created.status !== 412) {
          this.#ownership = { record, etag: ownershipEtag(created) };
          await created.body?.cancel().catch(() => undefined);
          this.#startOwnershipHeartbeat();
          return;
        }
        await created.body?.cancel().catch(() => undefined);
        const current = await this.#readOwnership();
        if (current === null) continue;
        if (current.record.state === "active") {
          throw new ObjectStoreError(
            "S3 bucket is already owned by another Minibase writer; stop it before sharing this root bucket",
            "StorageOwnershipConflict",
            409,
          );
        }
        const replaced = await this.#putOwnership(record, { "if-match": current.etag }, [412]);
        if (replaced.status === 412) {
          await replaced.body?.cancel().catch(() => undefined);
          continue;
        }
        this.#ownership = { record, etag: ownershipEtag(replaced) };
        await replaced.body?.cancel().catch(() => undefined);
        this.#startOwnershipHeartbeat();
        return;
      }
      throw new ObjectStoreError(
        "S3 bucket ownership changed while Minibase was acquiring it",
        "StorageOwnershipConflict",
        409,
      );
    });
  }

  async releaseOwnership(): Promise<void> {
    this.#stopOwnershipHeartbeat();
    await this.#withOwnershipControl(async () => {
      const ownership = this.#ownership;
      if (ownership === null) return;
      const releasedAt = new Date().toISOString();
      const released: OwnershipRecord = {
        ...ownership.record,
        state: "released",
        observedAt: releasedAt,
        releasedAt,
      };
      const response = await this.#putOwnership(
        released,
        { "if-match": ownership.etag },
        [412],
      );
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined);
        this.#ownership = null;
        const error = new ObjectStoreError(
          "S3 bucket ownership changed while Minibase was releasing it",
          "StorageOwnershipConflict",
          409,
        );
        this.#ownershipFailure = error;
        throw error;
      }
      await response.body?.cancel().catch(() => undefined);
      this.#ownership = null;
    });
  }

  async forceReleaseOwnership(projectId: string): Promise<ForcedOwnershipRelease> {
    validateProjectId(projectId);
    return await this.#withOwnershipControl(async () => {
      const current = await this.#readOwnership({ allowMalformed: true });
      if (current === null) return { released: false, previousState: "missing" };
      if (current.record.state === "released") {
        return { released: false, previousState: "released" };
      }
      const releasedAt = new Date().toISOString();
      const released: OwnershipRecord = {
        ...current.record,
        state: "released",
        observedAt: releasedAt,
        releasedAt,
        releasedByProjectId: projectId,
      };
      const response = await this.#putOwnership(
        released,
        { "if-match": current.etag },
        [412],
      );
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined);
        throw new ObjectStoreError(
          "S3 bucket ownership changed while it was being force-released",
          "StorageOwnershipConflict",
          409,
        );
      }
      await response.body?.cancel().catch(() => undefined);
      return { released: true, previousState: "active" };
    });
  }

  async health(): Promise<boolean> {
    try {
      if (this.#ownershipRequired || this.#ownership !== null) {
        await this.#refreshOwnership();
      }
      const response = await this.request("GET", "", {
        query: { "list-type": "2", "max-keys": "1", "encoding-type": "url" },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      parseListObjectsPage(
        await readBoundedText(response, MAX_LIST_RESPONSE_BYTES, "S3 health response"),
      );
      return true;
    } catch {
      return false;
    }
  }

  async write(
    bucket: string,
    name: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PendingObjectWrite> {
    validate(bucket, name);
    await this.#assertWritable();
    const writeId = crypto.randomUUID();
    const temporaryKey = `.minibase-tmp/${writeId}/${bucket}/${name}`;
    const backupKey = `.minibase-tmp/${writeId}/previous/${bucket}/${name}`;
    let size = 0;
    const counted = body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    ) ?? null;
    try {
      await this.request("PUT", temporaryKey, { body: counted });
    } catch (error) {
      await this.request("DELETE", temporaryKey).catch(() => {});
      throw new ObjectStoreError(
        "S3 rejected the object before it could be staged",
        "StorageBackendError",
        502,
        { cause: error },
      );
    }
    let committed = false;
    let previousVersion = false;
    return {
      writeId,
      size,
      commit: async () => {
        await this.#assertWritable();
        previousVersion = await this.copy(`${bucket}/${name}`, backupKey, true);
        await this.copy(temporaryKey, `${bucket}/${name}`);
        committed = true;
        await this.request("DELETE", temporaryKey);
      },
      rollback: async () => {
        if (committed) {
          await this.#assertWritable();
          if (previousVersion) await this.copy(backupKey, `${bucket}/${name}`);
          else await this.request("DELETE", `${bucket}/${name}`).catch(() => {});
        }
        await this.request("DELETE", temporaryKey).catch(() => {});
        await this.request("DELETE", backupKey).catch(() => {});
        committed = false;
        previousVersion = false;
      },
      finalize: async () => {
        await this.request("DELETE", temporaryKey).catch(() => {});
        await this.request("DELETE", backupKey).catch(() => {});
        committed = false;
        previousVersion = false;
      },
    };
  }

  async read(bucket: string, name: string): Promise<StoredObject> {
    validate(bucket, name);
    const response = await this.request("GET", `${bucket}/${name}`);
    return {
      body: response.body,
      size: numberHeader(response.headers.get("content-length")),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async remove(bucket: string, name: string): Promise<void> {
    validate(bucket, name);
    await this.#assertWritable();
    await this.request("DELETE", `${bucket}/${name}`);
  }

  async list(): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    const tokens = new Set<string>();
    let continuationToken: string | undefined;
    while (true) {
      const response = await this.request("GET", "", {
        query: {
          "encoding-type": "url",
          "list-type": "2",
          ...(continuationToken === undefined ? {} : {
            "continuation-token": continuationToken,
          }),
        },
      });
      let page: ListObjectsPage;
      try {
        page = parseListObjectsPage(
          await readBoundedText(response, MAX_LIST_RESPONSE_BYTES, "S3 ListObjectsV2 response"),
        );
      } catch (error) {
        throw new ObjectStoreError(
          "S3 backend returned an invalid ListObjectsV2 response",
          "StorageBackendError",
          502,
          { cause: error },
        );
      }
      objects.push(
        ...page.objects
          .filter(({ key }) => key !== OWNERSHIP_KEY)
          .map(({ key, size }) => listedObject(key, size)),
      );
      if (!page.truncated) return objects;
      if (page.nextContinuationToken === undefined || tokens.has(page.nextContinuationToken)) {
        throw new ObjectStoreError(
          "S3 backend returned an invalid ListObjectsV2 continuation token",
          "StorageBackendError",
          502,
        );
      }
      tokens.add(page.nextContinuationToken);
      continuationToken = page.nextContinuationToken;
    }
  }

  async removeListed(object: ListedObject): Promise<void> {
    await this.#assertWritable();
    if (object.backendKey === undefined || object.backendKey.length === 0) {
      await this.remove(object.bucket, object.name);
      return;
    }
    await this.request("DELETE", object.backendKey);
  }

  async readListed(object: ListedObject): Promise<StoredObject> {
    const response = await this.request("GET", listedBackendKey(object));
    return {
      body: response.body,
      size: numberHeader(response.headers.get("content-length")),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async restoreListed(
    object: ListedObject,
    body: ReadableStream<Uint8Array> | null,
    contentType?: string,
  ): Promise<void> {
    await this.#assertWritable();
    await this.request("PUT", listedBackendKey(object), {
      body,
      headers: contentType === undefined ? undefined : { "content-type": contentType },
    });
  }

  async #assertWritable(): Promise<void> {
    if (!this.#ownershipRequired && this.#ownership === null) return;
    await this.#refreshOwnership();
  }

  async #refreshOwnership(): Promise<void> {
    if (this.#ownershipFailure !== null) throw this.#ownershipFailure;
    await this.#withOwnershipControl(async () => {
      if (this.#ownershipFailure !== null) throw this.#ownershipFailure;
      const ownership = this.#ownership;
      if (ownership === null) {
        const error = new ObjectStoreError(
          "S3 writes require active Minibase bucket ownership",
          "StorageOwnershipRequired",
          503,
        );
        if (this.#ownershipRequired) this.#ownershipFailure = error;
        throw error;
      }
      const observedAt = new Date().toISOString();
      const record: OwnershipRecord = { ...ownership.record, observedAt };
      const response = await this.#putOwnership(record, { "if-match": ownership.etag }, [412]);
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined);
        throw this.#loseOwnership(
          "S3 bucket ownership was replaced; this Minibase instance is no longer allowed to write",
        );
      }
      const etag = ownershipEtag(response);
      await response.body?.cancel().catch(() => undefined);
      this.#ownership = { record, etag };
    }).catch((error) => {
      if (error instanceof ObjectStoreError && error.code.startsWith("StorageOwnership")) {
        throw error;
      }
      throw this.#loseOwnership(
        "S3 bucket ownership could not be refreshed; writes are disabled until Minibase restarts",
        error,
      );
    });
  }

  #loseOwnership(message: string, cause?: unknown): ObjectStoreError {
    const error = new ObjectStoreError(message, "StorageOwnershipLost", 503, { cause });
    this.#ownershipFailure = error;
    this.#ownership = null;
    this.#stopOwnershipHeartbeat();
    return error;
  }

  #startOwnershipHeartbeat(): void {
    this.#stopOwnershipHeartbeat();
    this.#ownershipHeartbeat = setInterval(() => {
      void this.#refreshOwnership().catch(() => undefined);
    }, this.#ownershipHeartbeatMs);
  }

  #stopOwnershipHeartbeat(): void {
    if (this.#ownershipHeartbeat !== null) clearInterval(this.#ownershipHeartbeat);
    this.#ownershipHeartbeat = null;
  }

  async #withOwnershipControl<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#ownershipControl;
    const release = Promise.withResolvers<void>();
    this.#ownershipControl = previous.catch(() => undefined).then(() => release.promise);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release.resolve();
    }
  }

  async #putOwnership(
    record: OwnershipRecord,
    headers: Record<string, string>,
    allowedErrorStatuses: readonly number[] = [],
  ): Promise<Response> {
    return await this.request("PUT", OWNERSHIP_KEY, {
      headers: { ...headers, "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(record)),
    }, allowedErrorStatuses);
  }

  async #readOwnership(
    options: { allowMalformed?: boolean } = {},
  ): Promise<StoredOwnership | null> {
    const response = await this.request("GET", OWNERSHIP_KEY, {}, [404]);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const etag = ownershipEtag(response);
    let text: string;
    try {
      text = await readBoundedText(
        response,
        MAX_OWNERSHIP_RESPONSE_BYTES,
        "S3 ownership response",
      );
      return { record: parseOwnershipRecord(text), etag };
    } catch (error) {
      if (options.allowMalformed) {
        const now = new Date().toISOString();
        return {
          etag,
          record: {
            formatVersion: 1,
            state: "active",
            instanceId: "malformed",
            projectId: "unknown",
            processId: 0,
            acquiredAt: now,
            observedAt: now,
          },
        };
      }
      throw new ObjectStoreError(
        "S3 bucket ownership record is invalid; refuse to guess whether another writer is active",
        "StorageOwnershipInvalid",
        503,
        { cause: error },
      );
    }
  }

  private async copy(sourceKey: string, targetKey: string, allowMissing = false): Promise<boolean> {
    const source = `/${this.config.bucket}/${encodeKey(sourceKey)}`;
    const response = await this.request(
      "PUT",
      targetKey,
      { headers: { "x-amz-copy-source": source }, body: new Uint8Array() },
      allowMissing ? [404] : [],
    );
    if (response.status === 404) {
      await response.body?.cancel("S3 copy source is missing").catch(() => undefined);
      return false;
    }
    let responseBody: string;
    try {
      responseBody = await readBoundedText(response, MAX_COPY_RESPONSE_BYTES);
    } catch (error) {
      throw new ObjectStoreError(
        "S3 backend returned an invalid CopyObject response",
        "StorageBackendError",
        502,
        { cause: error },
      );
    }
    const embeddedError = copyObjectError(responseBody);
    if (embeddedError !== null) {
      throw new ObjectStoreError(
        "S3 backend returned an embedded CopyObject error",
        "StorageBackendError",
        502,
      );
    }
    return true;
  }

  private async request(
    method: string,
    key: string,
    init: {
      headers?: Record<string, string>;
      body?: BodyInit | null;
      query?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
    allowedErrorStatuses: readonly number[] = [],
  ): Promise<Response> {
    const url = this.objectUrl(key, init.query);
    const now = new Date();
    const amzDate = now.toISOString().replaceAll(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = "UNSIGNED-PAYLOAD";
    const signedHeaders: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...lowercaseHeaders(init.headers ?? {}),
    };
    if (this.config.sessionToken !== undefined) {
      signedHeaders["x-amz-security-token"] = this.config.sessionToken;
    }
    const headerNames = Object.keys(signedHeaders).sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${signedHeaders[name]!.trim()}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      headerNames.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = await hmac(
      await hmac(
        await hmac(
          await hmac(new TextEncoder().encode(`AWS4${this.config.secretAccessKey}`), date),
          this.config.region,
        ),
        "s3",
      ),
      "aws4_request",
    );
    const signature = bytesToHex(await hmac(signingKey, stringToSign));
    const headers = new Headers(init.headers);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", amzDate);
    if (this.config.sessionToken !== undefined) {
      headers.set("x-amz-security-token", this.config.sessionToken);
    }
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${
        headerNames.join(";")
      }, Signature=${signature}`,
    );
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: init.body, signal: init.signal });
    } catch (error) {
      throw new ObjectStoreError(
        `S3 backend request failed for ${method}`,
        "StorageBackendError",
        502,
        { cause: error },
      );
    }
    if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
      await response.body?.cancel("S3 backend returned an error").catch(() => undefined);
      throw new ObjectStoreError(
        `S3 backend rejected ${method} with HTTP ${response.status}`,
        "StorageBackendError",
        502,
      );
    }
    return response;
  }

  private objectUrl(key: string, query: Record<string, string> = {}): URL {
    const endpoint = new URL(
      this.config.endpoint.endsWith("/") ? this.config.endpoint : `${this.config.endpoint}/`,
    );
    if (this.config.pathStyle) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/${
        encodeSegment(this.config.bucket)
      }/${encodeKey(key)}`;
    } else {
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/${encodeKey(key)}`;
    }
    endpoint.search = canonicalQuery(query);
    return endpoint;
  }
}

interface ListObjectsPage {
  objects: Array<{ key: string; size: number }>;
  truncated: boolean;
  nextContinuationToken?: string;
}

function validate(bucket: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(bucket)) {
    throw new Error("Invalid storage bucket name");
  }
  if (
    name.length === 0 || name.startsWith("/") || name.includes("\0") ||
    name.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new Error("Invalid storage object name");
  }
}

function validateProjectId(projectId: string): void {
  if (
    projectId.length === 0 || projectId.length > 256 ||
    [...projectId].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("S3 ownership project id must contain 1 to 256 printable characters");
  }
}

function ownershipEtag(response: Response): string {
  const etag = response.headers.get("etag")?.trim();
  if (etag === undefined || etag.length === 0 || etag.length > 1_024) {
    throw new ObjectStoreError(
      "S3 ownership response did not include a usable ETag",
      "StorageOwnershipInvalid",
      503,
    );
  }
  return etag;
}

function parseOwnershipRecord(text: string): OwnershipRecord {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (
    parsed.formatVersion !== 1 ||
    (parsed.state !== "active" && parsed.state !== "released") ||
    typeof parsed.instanceId !== "string" || parsed.instanceId.length === 0 ||
    typeof parsed.projectId !== "string" || parsed.projectId.length === 0 ||
    typeof parsed.processId !== "number" || !Number.isSafeInteger(parsed.processId) ||
    typeof parsed.acquiredAt !== "string" || !validTimestamp(parsed.acquiredAt) ||
    typeof parsed.observedAt !== "string" || !validTimestamp(parsed.observedAt) ||
    (parsed.releasedAt !== undefined &&
      (typeof parsed.releasedAt !== "string" || !validTimestamp(parsed.releasedAt))) ||
    (parsed.releasedByProjectId !== undefined &&
      typeof parsed.releasedByProjectId !== "string")
  ) {
    throw new Error("S3 ownership record does not match format version 1");
  }
  return parsed as unknown as OwnershipRecord;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      compareEncoded(leftName, rightName) || compareEncoded(leftValue, rightValue)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function compareEncoded(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(key.byteLength);
  keyBytes.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function numberHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  responseName = "S3 CopyObject response",
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel(`${responseName} is too large`).catch(() => undefined);
        throw new Error(`${responseName} exceeds ${maximumBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseListObjectsPage(xml: string): ListObjectsPage {
  if (!/<(?:[A-Za-z_][\w.-]*:)?ListBucketResult(?:\s[^>]*)?>/iu.test(xml)) {
    throw new Error("ListObjectsV2 root element is missing");
  }
  if (xmlElementText(xml, "EncodingType") !== "url") {
    throw new Error("ListObjectsV2 URL encoding acknowledgement is missing");
  }
  const truncatedText = xmlElementText(xml, "IsTruncated");
  if (truncatedText !== "true" && truncatedText !== "false") {
    throw new Error("ListObjectsV2 IsTruncated is missing or invalid");
  }
  const objects: ListObjectsPage["objects"] = [];
  const contentsPattern =
    /<(?:[A-Za-z_][\w.-]*:)?Contents(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Contents\s*>/giu;
  for (const match of xml.matchAll(contentsPattern)) {
    const encodedKey = xmlElementText(match[1]!, "Key");
    const sizeText = xmlElementText(match[1]!, "Size");
    if (
      encodedKey === null || encodedKey.length === 0 || sizeText === null ||
      !/^\d+$/u.test(sizeText)
    ) {
      throw new Error("ListObjectsV2 Contents is missing a valid Key or Size");
    }
    const key = decodeURIComponent(encodedKey);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) throw new Error("ListObjectsV2 object size is too large");
    objects.push({ key, size });
  }
  const truncated = truncatedText === "true";
  const nextContinuationToken = xmlElementText(xml, "NextContinuationToken") ?? undefined;
  if (truncated && (nextContinuationToken === undefined || nextContinuationToken.length === 0)) {
    throw new Error("ListObjectsV2 continuation token is missing");
  }
  return { objects, truncated, nextContinuationToken };
}

function listedObject(key: string, size: number): ListedObject {
  const separator = key.indexOf("/");
  return {
    bucket: separator < 0 ? "" : key.slice(0, separator),
    name: separator < 0 ? key : key.slice(separator + 1),
    size,
    backendKey: key,
    kind: key === OWNERSHIP_KEY
      ? "control"
      : key.startsWith(".minibase-tmp/")
      ? "temporary"
      : "data",
  };
}

function listedBackendKey(object: ListedObject): string {
  if (object.backendKey === undefined || object.backendKey.length === 0) {
    throw new Error("S3 listed object is missing its backend key");
  }
  return object.backendKey;
}

function copyObjectError(xml: string): { code: string; message: string } | null {
  if (!/<(?:[A-Za-z_][\w.-]*:)?Error(?:\s[^>]*)?>/iu.test(xml)) return null;
  return {
    code: xmlElementText(xml, "Code") ?? "UnknownError",
    message: xmlElementText(xml, "Message") ?? "S3 returned an embedded CopyObject error",
  };
}

function xmlElementText(xml: string, element: string): string | null {
  const match = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${element}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${element}\\s*>`,
    "iu",
  ).exec(xml);
  return match === null ? null : decodeXmlEntities(match[1]!.trim());
}

function decodeXmlEntities(value: string): string {
  return value.replaceAll(/&(amp|lt|gt|quot|apos);/gu, (entity, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return entity;
    }
  });
}
