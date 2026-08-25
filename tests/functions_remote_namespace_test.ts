import { assert, assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";

Deno.test({
  name: "WSL2 network namespace remotely invokes a Windows-hosted Edge Function",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    const distribution = await findWslDistribution();
    assert(distribution !== null, "A non-Docker WSL2 distribution is required");
    const gateway = await wslGateway(distribution);
    const root = await Deno.makeTempDir({ prefix: "minibase-functions-wsl-test-" });
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const functionDir = join(root, "supabase", "functions", "namespace");
    await Deno.mkdir(functionDir, { recursive: true });
    await Deno.writeTextFile(
      join(functionDir, "index.ts"),
      `Deno.serve(async (request) => Response.json({
        method: request.method,
        namespace: request.headers.get("x-network-namespace"),
        body: await request.json(),
      }));\n`,
    );
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      `format_version = 1
[functions.namespace]
verify_jwt = false
`,
    );
    const port = availablePort();
    const project = await discoverProject(root);
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(Deno.cwd(), "src", "main.ts"),
        "start",
        "--project",
        root,
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    try {
      await waitForRuntime(project.runtimeFile);
      const invoked = await new Deno.Command("wsl.exe", {
        args: [
          "-d",
          distribution,
          "--",
          "curl",
          "--fail-with-body",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "5",
          "--request",
          "POST",
          "--header",
          "content-type: application/json",
          "--header",
          "x-network-namespace: wsl2",
          "--data-binary",
          '{"remote":true}',
          `http://${gateway}:${port}/functions/v1/namespace`,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(invoked.code, 0, decode(invoked.stderr));
      assertEquals(JSON.parse(decode(invoked.stdout)), {
        method: "POST",
        namespace: "wsl2",
        body: { remote: true },
      });

      const runtime = await readRuntimeState(project);
      assert(runtime);
      const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
        method: "POST",
        headers: { "x-minibase-control-token": runtime.controlToken },
      });
      assertEquals(stopped.status, 202);
      const output = await child.output();
      assertEquals(output.code, 0, decode(output.stderr));
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // The normal shutdown path already reaped the process.
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

async function findWslDistribution(): Promise<string | null> {
  try {
    const output = await new Deno.Command("wsl.exe", {
      args: ["--list", "--quiet"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) return null;
    return decode(output.stdout, true).split(/\r?\n/u).map((name) => name.trim()).find((name) =>
      name.length > 0 && name !== "docker-desktop"
    ) ?? null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function wslGateway(distribution: string): Promise<string> {
  const output = await new Deno.Command("wsl.exe", {
    args: ["-d", distribution, "--", "ip", "route", "show", "default"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(output.code, 0, decode(output.stderr));
  const gateway = /\bdefault\s+via\s+(\d+\.\d+\.\d+\.\d+)\b/u.exec(decode(output.stdout))?.[1];
  assert(gateway !== undefined, "WSL2 did not report a default IPv4 gateway");
  return gateway;
}

function decode(value: Uint8Array, utf16 = false): string {
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(value).replace(/^\uFEFF/u, "").trim();
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for WSL remote Functions server");
}

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Fixture contains unsupported entry: ${basename(sourcePath)}`);
    }
  }
}
