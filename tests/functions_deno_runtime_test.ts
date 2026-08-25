import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import {
  ensureBundledDenoRuntime,
  ensureBundledRuntimeFile,
} from "../src/functions/deno_runtime.ts";

Deno.test("bundled Function Deno Runtime extracts once and rejects cache tampering", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-function-deno-runtime-test-" });
  const source = new TextEncoder().encode("controlled-deno-runtime-bytes");
  const archive = join(temp, "deno.exe.gz");
  const compressed = new Response(
    new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  await Deno.writeFile(archive, new Uint8Array(await compressed.arrayBuffer()));
  const expectedSha256 = createHash("sha256").update(source).digest("hex");
  const options = {
    cacheRoot: join(temp, "cache"),
    compressedRuntime: archive,
    expectedSha256,
    version: "2.9.2",
    executableName: "deno.exe",
  };
  try {
    const [first, concurrent] = await Promise.all([
      ensureBundledDenoRuntime(options),
      ensureBundledDenoRuntime(options),
    ]);
    assertEquals(first, concurrent);
    assertEquals(await Deno.readFile(first), source);
    await Deno.remove(archive);
    assertEquals(await ensureBundledDenoRuntime(options), first);

    await Deno.writeTextFile(first, "tampered");
    await assertRejects(
      () => ensureBundledDenoRuntime(options),
      Error,
      "integrity check failed",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("bundled Function worker uses content-addressed files and rejects tampering", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-function-worker-runtime-test-" });
  const source = join(temp, "worker_entry.ts");
  await Deno.writeTextFile(source, "Deno.serve(() => new Response('ok'));\n");
  const options = {
    runtimeDir: join(temp, "runtime"),
    source,
    fileStem: "minibase-function-worker",
    extension: ".ts",
  };
  try {
    const [first, concurrent] = await Promise.all([
      ensureBundledRuntimeFile(options),
      ensureBundledRuntimeFile(options),
    ]);
    assertEquals(first, concurrent);
    assertEquals(await Deno.readTextFile(first), await Deno.readTextFile(source));

    await Deno.writeTextFile(first, "tampered");
    await assertRejects(
      () => ensureBundledRuntimeFile(options),
      Error,
      "Function worker integrity check failed",
    );

    await Deno.writeTextFile(source, "Deno.serve(() => new Response('updated'));\n");
    const updated = await ensureBundledRuntimeFile(options);
    assertEquals(updated === first, false);
    assertEquals(await Deno.readTextFile(updated), await Deno.readTextFile(source));
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
