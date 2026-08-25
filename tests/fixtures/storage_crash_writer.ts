import { LocalObjectStore } from "../../src/storage/local.ts";

const [root, bucket, name, body, mode = "after-switch"] = Deno.args;
if (root === undefined || bucket === undefined || name === undefined || body === undefined) {
  throw new Error("Expected storage root, bucket, name and body");
}

const stream = mode === "during-write" ? interruptedStream(body) : new Blob([body]).stream();
const write = await new LocalObjectStore(root).write(bucket, name, stream);
await write.commit();
console.log(JSON.stringify({ writeId: write.writeId }));
Deno.exit(91);

function interruptedStream(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
        return;
      }
      Deno.exit(92);
    },
  });
}
