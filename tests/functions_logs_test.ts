import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionLogStore, readFunctionLogs } from "../src/functions/log_store.ts";

Deno.test("Function logs rotate within bounds and filter by function and tail", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-logs-test-" });
  try {
    await Deno.writeTextFile(join(root, "functions.jsonl.3"), "stale archive\n");
    const store = new FunctionLogStore(root, { maxBytes: 1_024, retentionFiles: 2 });
    await store.prepare();
    await assertMissing(join(root, "functions.jsonl.3"));
    for (let index = 0; index < 40; index++) {
      store.append(JSON.stringify({
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        level: "info",
        module: "functions",
        function: index % 2 === 0 ? "alpha" : "beta",
        requestId: `request-${index}`,
        status: 200,
        payload: "x".repeat(96),
      }));
    }
    await store.close();

    const current = join(root, "functions.jsonl");
    for (const path of [current, `${current}.1`, `${current}.2`]) {
      const stat = await Deno.stat(path);
      assert(stat.isFile);
      assert(stat.size <= 1_024);
    }
    await assertMissing(`${current}.3`);

    const report = await readFunctionLogs(root, 2, { functionName: "alpha", tail: 3 });
    assertEquals(report.path, current);
    assertEquals(report.entries.length, 3);
    assert(report.entries.every((entry) => entry.function === "alpha"));
    assertEquals(report.entries.at(-1)?.requestId, "request-38");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Function logs bound oversized and malformed records without retaining archives", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-logs-bounds-test-" });
  try {
    const store = new FunctionLogStore(root, { maxBytes: 1_024, retentionFiles: 0 });
    store.append(JSON.stringify({ function: "alpha", payload: "secret-like-value".repeat(200) }));
    store.append(JSON.stringify({ function: "beta", status: 204 }));
    await store.close();

    const current = join(root, "functions.jsonl");
    assert((await Deno.stat(current)).size <= 1_024);
    await assertMissing(`${current}.1`);
    let report = await readFunctionLogs(root, 0);
    assertEquals(report.entries.length, 2);
    assertEquals(report.entries[0]?.event, "function_log_line_truncated");
    assertEquals(JSON.stringify(report).includes("secret-like-value"), false);

    await Deno.writeTextFile(current, `${await Deno.readTextFile(current)}not-json\n`);
    report = await readFunctionLogs(root, 0, { tail: 1 });
    assertEquals(report.entries.length, 1);
    assertEquals(report.entries[0]?.event, "malformed_function_log_line");
    assertEquals(report.entries[0]?.preview, "not-json");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new Error(`Expected ${path} to be absent`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}
