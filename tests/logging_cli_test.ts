import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";

Deno.test("CLI server emits human logs while persisting structured request records", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-logging-cli-test-" });
  let server: Deno.ChildProcess | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      `format_version = 1
[logging]
format = "human"
max_bytes = 4096
retention_files = 2
`,
    );
    const port = availablePort();
    server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(Deno.cwd(), "src", "main.ts"),
        "start",
        "--project",
        root,
        "--port",
        String(port),
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stdout = new Response(server.stdout).text();
    const stderr = new Response(server.stderr).text();
    const apiUrl = await waitForApi(join(root, ".minibase", "runtime.json"));
    const response = await fetch(new URL("/health/live", apiUrl), {
      headers: { "x-request-id": "logging-cli-request" },
    });
    assertEquals(response.status, 200);
    await response.body?.cancel();

    const stopped = await runCliProcess(["stop", "--project", root, "--json"], root);
    assertEquals(stopped.code, 0, stopped.stderr);
    assertEquals((await server.status).success, true);
    server = null;

    const serverStdout = await stdout;
    await stderr;
    assertMatch(serverStdout, / INFO \[server\] server_started /u);
    assertMatch(
      serverStdout,
      / INFO \[server\] http_request .*requestId=logging-cli-request.*durationMs=/u,
    );
    const logPath = join(root, ".minibase", "logs", "minibase.jsonl");
    const records = (await Deno.readTextFile(logPath)).trim().split(/\r?\n/u).map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );
    assert(records.some((record) => record.event === "server_started"));
    const request = records.find((record) => record.requestId === "logging-cli-request");
    assert(request !== undefined);
    assertEquals(request.level, "info");
    assertEquals(request.module, "server");
    assertEquals(request.event, "http_request");
    assertEquals(request.status, 200);
    assertEquals(typeof request.durationMs, "number");
  } finally {
    if (server !== null) {
      try {
        server.kill("SIGTERM");
      } catch {
        // The server may already have stopped.
      }
      await server.status.catch(() => undefined);
    }
    await Deno.remove(root, { recursive: true });
  }
});

async function waitForApi(runtimePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const runtime = JSON.parse(await Deno.readTextFile(runtimePath)) as { apiUrl?: unknown };
      if (typeof runtime.apiUrl === "string") {
        const response = await fetch(new URL("/health/ready", runtime.apiUrl));
        if (response.ok) {
          await response.body?.cancel();
          return runtime.apiUrl;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && !(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Minibase API");
}

async function runCliProcess(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
