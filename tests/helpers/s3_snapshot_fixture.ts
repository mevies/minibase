import { assertStringIncludes } from "@std/assert";

const S3_BUCKET = "reset-snapshot-root";

export interface S3SnapshotFixture {
  port: Promise<number>;
  put(key: string, value: string, contentType?: string): void;
  snapshot(): Array<[string, string, string | undefined]>;
  failDelete(number: number): void;
  putBeforeList(number: number, key: string, value: string, contentType?: string): void;
  close(): Promise<void>;
}

export function s3SnapshotEnvironment(endpoint: string): Record<string, string> {
  return {
    MINIBASE_STORAGE_DRIVER: "s3",
    MINIBASE_S3_ENDPOINT: endpoint,
    MINIBASE_S3_REGION: "us-east-1",
    MINIBASE_S3_BUCKET: S3_BUCKET,
    MINIBASE_S3_ACCESS_KEY_ID: "reset-access",
    MINIBASE_S3_SECRET_ACCESS_KEY: "reset-secret",
    MINIBASE_S3_PATH_STYLE: "true",
  };
}

export function startS3SnapshotFixture(): S3SnapshotFixture {
  const objects = new Map<
    string,
    { bytes: Uint8Array; etag: string; contentType?: string }
  >();
  let revision = 0;
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  let deleteCount = 0;
  let failedDelete: number | null = null;
  let listCount = 0;
  let pendingListPut:
    | { number: number; key: string; bytes: Uint8Array; contentType?: string }
    | null = null;
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    async (request) => {
      assertStringIncludes(
        request.headers.get("authorization") ?? "",
        "AWS4-HMAC-SHA256 Credential=reset-access/",
      );
      const url = new URL(request.url);
      const target = decodeURIComponent(url.pathname.replace(/^\//u, ""));
      const separator = target.indexOf("/");
      const root = separator < 0 ? target : target.slice(0, separator);
      const key = separator < 0 ? "" : target.slice(separator + 1);
      const fullKey = `${root}/${key}`;

      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        listCount++;
        if (pendingListPut?.number === listCount) {
          setObject(
            `${S3_BUCKET}/${pendingListPut.key}`,
            pendingListPut.bytes,
            pendingListPut.contentType,
          );
          pendingListPut = null;
        }
        const prefix = `${root}/`;
        const contents = [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([name, value]) => {
            const relative = name.slice(prefix.length);
            return `<Contents><Key>${
              escapeXml(encodeURIComponent(relative))
            }</Key><Size>${value.bytes.byteLength}</Size></Contents>`;
          })
          .join("");
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }

      if (request.method === "PUT") {
        const current = objects.get(fullKey);
        if (request.headers.get("if-none-match") === "*" && current !== undefined) {
          return new Response("precondition failed", { status: 412 });
        }
        const ifMatch = request.headers.get("if-match");
        if (ifMatch !== null && current?.etag !== ifMatch) {
          return new Response("precondition failed", { status: 412 });
        }
        const etag = setObject(
          fullKey,
          new Uint8Array(await request.arrayBuffer()),
          request.headers.get("content-type") ?? undefined,
        );
        return new Response(null, { status: 200, headers: { etag } });
      }

      if (request.method === "GET") {
        const value = objects.get(fullKey);
        return value === undefined
          ? new Response("missing", { status: 404 })
          : new Response(value.bytes.slice(), {
            headers: {
              "content-length": String(value.bytes.byteLength),
              etag: value.etag,
              ...(value.contentType === undefined ? {} : { "content-type": value.contentType }),
            },
          });
      }

      if (request.method === "DELETE") {
        deleteCount++;
        if (failedDelete === deleteCount) {
          failedDelete = null;
          return new Response("injected delete failure", { status: 500 });
        }
        objects.delete(fullKey);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );

  function setObject(key: string, bytes: Uint8Array, contentType?: string): string {
    const etag = `"revision-${++revision}"`;
    objects.set(key, {
      bytes,
      etag,
      ...(contentType === undefined ? {} : { contentType }),
    });
    return etag;
  }

  return {
    port: listening.promise,
    put: (key, value, contentType) => {
      setObject(`${S3_BUCKET}/${key}`, new TextEncoder().encode(value), contentType);
    },
    snapshot: () =>
      [...objects.entries()]
        .filter(([key]) =>
          key.startsWith(`${S3_BUCKET}/`) &&
          key !== `${S3_BUCKET}/.minibase/ownership-v1.json`
        )
        .map(([key, value]): [string, string, string | undefined] => [
          key.slice(S3_BUCKET.length + 1),
          new TextDecoder().decode(value.bytes),
          value.contentType,
        ])
        .sort(([left], [right]) => left.localeCompare(right, "en")),
    failDelete: (number) => {
      deleteCount = 0;
      failedDelete = number;
    },
    putBeforeList: (number, key, value, contentType) => {
      listCount = 0;
      pendingListPut = {
        number,
        key,
        bytes: new TextEncoder().encode(value),
        ...(contentType === undefined ? {} : { contentType }),
      };
    },
    close: async () => {
      abort.abort();
      await server.finished;
    },
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
