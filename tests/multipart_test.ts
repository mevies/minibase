import { assert, assertEquals } from "@std/assert";
import { parseMultipartFile } from "../src/storage/multipart.ts";

Deno.test("multipart parsing returns a bounded stream before the file body is fully pulled", async () => {
  const boundary = "minibase-stream-boundary";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="cacheControl"\r\n\r\n' +
      `3600\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="metadata"\r\n\r\n' +
      `{"source":"multipart"}\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name=""; filename="large.bin"\r\n' +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const fileChunks = Array.from({ length: 8 }, (_, index) => {
    const chunk = new Uint8Array(256 * 1024);
    chunk.fill(index + 1);
    return chunk;
  });
  const suffixPrefix = `\r\n--${boundary.slice(0, 9)}`;
  const chunks = [
    prefix,
    ...fileChunks,
    encoder.encode(suffixPrefix),
    encoder.encode(`${boundary.slice(9)}--\r\n`),
  ];
  let pulls = 0;
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
  });

  const file = await parseMultipartFile(request, request.headers.get("content-type")!);
  assertEquals(file.contentType, "application/octet-stream");
  assertEquals(file.fields, {
    cacheControl: "3600",
    metadata: '{"source":"multipart"}',
  });
  assert(pulls < chunks.length, "parser consumed the complete multipart request before returning");

  let size = 0;
  let checksum = 0;
  for await (const chunk of file.body) {
    size += chunk.byteLength;
    for (const byte of chunk) checksum += byte;
  }
  assertEquals(size, fileChunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  assertEquals(
    checksum,
    fileChunks.reduce((total, chunk, index) => total + chunk.length * (index + 1), 0),
  );
});
