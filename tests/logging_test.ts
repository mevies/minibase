import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { RuntimeLogger } from "../src/logging/logger.ts";

Deno.test("runtime logs support JSON/human output, redaction and bounded rotation", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-logging-test-" });
  const secret = "runtime-logging-secret-never-appear";
  try {
    const jsonStdout: string[] = [];
    const jsonStderr: string[] = [];
    const jsonLogger = new RuntimeLogger(join(root, "json"), {
      format: "json",
      maxBytes: 1_024,
      retentionFiles: 1,
      secrets: [secret],
      stdout: (line) => jsonStdout.push(line),
      stderr: (line) => jsonStderr.push(line),
    });
    await jsonLogger.prepare();
    jsonLogger.info("server", "server_started", { engine: "pglite" });
    jsonLogger.warning("auth", "auth_probe", { message: `credential=${secret}` });
    for (let index = 0; index < 30; index++) {
      jsonLogger.info("rest", "http_request", {
        requestId: `request-${index}`,
        durationMs: index + 0.125,
        method: "GET",
        status: 200,
        padding: "x".repeat(80),
      });
    }
    await jsonLogger.close();

    assert(jsonStdout.length > 0);
    assert(jsonStderr.length > 0);
    for (const line of [...jsonStdout, ...jsonStderr]) {
      const record = JSON.parse(line) as Record<string, unknown>;
      assertEquals(typeof record.timestamp, "string");
      assertEquals(typeof record.level, "string");
      assertEquals(typeof record.module, "string");
      assertEquals(typeof record.event, "string");
      assertEquals(line.includes(secret), false);
    }
    assertEquals(jsonStderr.some((line) => line.includes("[REDACTED]")), true);
    assertEquals(await fileExists(`${jsonLogger.path}.1`), true);
    assertEquals(await fileExists(`${jsonLogger.path}.2`), false);
    const persistedJson = await readLogFamily(jsonLogger.path, 1);
    assertEquals(persistedJson.includes(secret), false);
    for (const line of persistedJson.trim().split(/\r?\n/u)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      assertEquals(typeof record.timestamp, "string");
      assertEquals(typeof record.level, "string");
      assertEquals(typeof record.module, "string");
      assertEquals(typeof record.event, "string");
    }

    const humanStdout: string[] = [];
    const humanLogger = new RuntimeLogger(join(root, "human"), {
      format: "human",
      maxBytes: 4_096,
      retentionFiles: 1,
      secrets: [secret],
      stdout: (line) => humanStdout.push(line),
      stderr: (line) => humanStdout.push(line),
    });
    await humanLogger.prepare();
    humanLogger.info("auth", "http_request", {
      requestId: "human-request",
      durationMs: 4.567,
      method: "POST",
      status: 200,
      message: secret,
    });
    await humanLogger.close();

    assertEquals(humanStdout.length, 1);
    assertMatch(humanStdout[0]!, / INFO \[auth\] http_request /u);
    assertMatch(humanStdout[0]!, /requestId=human-request/u);
    assertMatch(humanStdout[0]!, /durationMs=4\.57/u);
    assertEquals(humanStdout[0]!.includes(secret), false);
    const humanPersisted = await Deno.readTextFile(humanLogger.path);
    const humanRecord = JSON.parse(humanPersisted) as Record<string, unknown>;
    assertEquals(humanRecord.module, "auth");
    assertEquals(humanRecord.message, "[REDACTED]");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function readLogFamily(path: string, retentionFiles: number): Promise<string> {
  const contents: string[] = [];
  for (let index = retentionFiles; index >= 1; index--) {
    try {
      contents.push(await Deno.readTextFile(`${path}.${index}`));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  contents.push(await Deno.readTextFile(path));
  return contents.join("");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
