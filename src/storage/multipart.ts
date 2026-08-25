const MAX_HEADER_BYTES = 16 * 1024;
const MAX_SKIPPED_FIELD_BYTES = 64 * 1024;

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer:
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

export interface MultipartFile {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  fields: Readonly<Record<string, string>>;
}

export async function parseMultipartFile(
  request: Request,
  contentType: string,
): Promise<MultipartFile> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (
    boundary === undefined || boundary.length === 0 || boundary.length > 200 ||
    /[\r\n]/u.test(boundary)
  ) {
    throw new Error("Multipart boundary is missing or invalid");
  }
  if (request.body === null) throw new Error("Multipart request body is missing");

  const encoder = new TextEncoder();
  const boundaryBytes = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const headerSeparator = encoder.encode("\r\n\r\n");
  const reader = new BufferedReader(request.body.getReader());
  const fields: Record<string, string> = {};

  try {
    if (!(await reader.startsWith(boundaryBytes))) {
      throw new Error("Multipart body does not start with its declared boundary");
    }
    reader.consume(boundaryBytes.length);

    while (await consumeBoundarySuffix(reader)) {
      const headerBytes = await reader.takeUntil(headerSeparator, MAX_HEADER_BYTES);
      const headers = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
      if (/^content-disposition:[^\r\n]*(?:filename|filename\*)=/imu.test(headers)) {
        const partContentType = /^content-type:\s*([^\r\n]+)/imu.exec(headers)?.[1]?.trim() ??
          "application/octet-stream";
        return {
          body: reader.bodyUntil(delimiter),
          contentType: partContentType,
          fields,
        };
      }
      const fieldName = /^content-disposition:[^\r\n]*\bname="([^"]*)"/imu.exec(headers)?.[1];
      if (fieldName === "cacheControl" || fieldName === "metadata") {
        if (fields[fieldName] !== undefined) {
          throw new Error(`Multipart field ${fieldName} must not be repeated`);
        }
        const value = await reader.takeUntil(delimiter, MAX_SKIPPED_FIELD_BYTES);
        fields[fieldName] = new TextDecoder("utf-8", { fatal: true }).decode(value);
        continue;
      }
      await reader.discardUntil(delimiter, MAX_SKIPPED_FIELD_BYTES);
    }
    throw new Error("Multipart upload does not contain a file");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

class BufferedReader {
  #buffer = new Uint8Array();
  #done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async startsWith(expected: Uint8Array): Promise<boolean> {
    if (!(await this.ensure(expected.length))) return false;
    for (let index = 0; index < expected.length; index++) {
      if (this.#buffer[index] !== expected[index]) return false;
    }
    return true;
  }

  consume(length: number): void {
    this.#buffer = this.#buffer.slice(length);
  }

  async takeUntil(marker: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
    while (true) {
      const index = indexOfBytes(this.#buffer, marker);
      if (index >= 0) {
        if (index > maximumBytes) throw new Error("Multipart part headers are too large");
        const value = this.#buffer.slice(0, index);
        this.consume(index + marker.length);
        return value;
      }
      if (this.#buffer.length > maximumBytes) {
        throw new Error("Multipart part headers are too large");
      }
      if (!(await this.readMore())) throw new Error("Multipart part headers are truncated");
    }
  }

  async discardUntil(marker: Uint8Array, maximumBytes: number): Promise<void> {
    let discarded = 0;
    while (true) {
      const index = indexOfBytes(this.#buffer, marker);
      if (index >= 0) {
        discarded += index;
        if (discarded > maximumBytes) throw new Error("Multipart field is too large");
        this.consume(index + marker.length);
        return;
      }
      const retained = Math.min(this.#buffer.length, marker.length - 1);
      const discardLength = this.#buffer.length - retained;
      discarded += discardLength;
      if (discarded > maximumBytes) throw new Error("Multipart field is too large");
      this.consume(discardLength);
      if (!(await this.readMore())) throw new Error("Multipart field is truncated");
    }
  }

  bodyUntil(marker: Uint8Array): ReadableStream<Uint8Array> {
    let closed = false;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (closed) return;
        try {
          while (true) {
            const index = indexOfBytes(this.#buffer, marker);
            if (index >= 0) {
              const finalChunk = this.#buffer.slice(0, index);
              this.consume(index + marker.length);
              closed = true;
              if (finalChunk.length > 0) controller.enqueue(finalChunk);
              controller.close();
              await this.cancel().catch(() => undefined);
              return;
            }
            if (this.#done) throw new Error("Multipart file body is truncated");
            if (this.#buffer.length >= marker.length) {
              const emitLength = this.#buffer.length - marker.length + 1;
              const chunk = this.#buffer.slice(0, emitLength);
              this.consume(emitLength);
              controller.enqueue(chunk);
              return;
            }
            await this.readMore();
          }
        } catch (error) {
          closed = true;
          controller.error(error);
          await this.cancel(error).catch(() => undefined);
        }
      },
      cancel: async (reason) => {
        closed = true;
        await this.cancel(reason);
      },
    });
  }

  async cancel(reason?: unknown): Promise<void> {
    this.#done = true;
    await this.reader.cancel(reason);
  }

  private async ensure(length: number): Promise<boolean> {
    while (this.#buffer.length < length && await this.readMore()) {
      // Continue until enough bytes are buffered or the source ends.
    }
    return this.#buffer.length >= length;
  }

  private async readMore(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.reader.read();
    if (next.done) {
      this.#done = true;
      return false;
    }
    const combined = new Uint8Array(this.#buffer.length + next.value.length);
    combined.set(this.#buffer);
    combined.set(next.value, this.#buffer.length);
    this.#buffer = combined;
    return true;
  }
}

async function consumeBoundarySuffix(reader: BufferedReader): Promise<boolean> {
  const final = new Uint8Array([45, 45]);
  const nextPart = new Uint8Array([13, 10]);
  if (await reader.startsWith(final)) {
    reader.consume(final.length);
    return false;
  }
  if (await reader.startsWith(nextPart)) {
    reader.consume(nextPart.length);
    return true;
  }
  throw new Error("Multipart boundary has an invalid suffix");
}
