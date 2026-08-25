import { assert, assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";

Deno.test("Function network failures and disconnects remain request-scoped", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-network-failure-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
  const upstreamAbort = new AbortController();
  const upstreamListening = Promise.withResolvers<number>();
  const outboundStarted = Promise.withResolvers<void>();
  const outboundAborted = Promise.withResolvers<void>();
  const upstream = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: upstreamAbort.signal,
      onListen: (address) => upstreamListening.resolve(address.port),
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/ok") return new Response("upstream-ok");
      if (path !== "/slow") return new Response("not-found", { status: 404 });
      outboundStarted.resolve();
      return await new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => {
          outboundAborted.resolve();
          resolve(new Response("client-disconnected", { status: 499 }));
        }, { once: true });
      });
    },
  );
  const upstreamPort = await upstreamListening.promise;
  const functionDir = join(root, "supabase", "functions", "network-probe");
  await Deno.mkdir(functionDir, { recursive: true });
  await Deno.writeTextFile(
    join(functionDir, "index.ts"),
    `Deno.serve(async (request) => {
      const url = new URL(request.url);
      const mode = url.searchParams.get("mode");
      const target = mode === "self"
        ? new URL("/health/live", Deno.env.get("SUPABASE_URL"))
        : new URL(url.searchParams.get("target") ?? "http://missing.invalid/");
      try {
        const response = await fetch(target, { signal: request.signal });
        return Response.json({ ok: true, status: response.status, body: await response.text() });
      } catch (error) {
        return Response.json({
          ok: false,
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
`,
  );
  await Deno.writeTextFile(
    join(root, "minibase.toml"),
    "format_version = 1\n[functions.network-probe]\nverify_jwt = false\n",
  );
  const apiPort = availablePort();
  const project = await discoverProject(root);
  const child = startServer(root, apiPort);
  try {
    await waitForRuntime(project.runtimeFile);
    assertEquals((await probe(apiPort, "dns", "http://missing.invalid/")).ok, false);
    assertEquals(
      (await probe(apiPort, "tls", `https://127.0.0.1:${upstreamPort}/tls`)).ok,
      false,
    );
    assertEquals(await probe(apiPort, "self"), {
      ok: true,
      status: 200,
      body: JSON.stringify({
        status: "live",
        version: "1.0.0",
        engine: "pglite",
      }),
    });

    const controller = new AbortController();
    const pending = fetch(functionUrl(apiPort, "slow", `http://127.0.0.1:${upstreamPort}/slow`), {
      signal: controller.signal,
    });
    await withTimeout(outboundStarted.promise, "outbound request did not start");
    controller.abort();
    await pending.catch((error) => {
      assert(error instanceof DOMException && error.name === "AbortError");
    });
    await withTimeout(outboundAborted.promise, "outbound request was not cancelled");

    assertEquals(
      (await probe(apiPort, "good", `http://127.0.0.1:${upstreamPort}/ok`)).body,
      "upstream-ok",
    );
    const runtime = await readRuntimeState(project);
    assert(runtime);
    const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
      method: "POST",
      headers: { "x-minibase-control-token": runtime.controlToken },
    });
    assertEquals(stopped.status, 202);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal shutdown path already reaped the process.
    }
    upstreamAbort.abort();
    await upstream.finished;
    await Deno.remove(root, { recursive: true });
  }
});

function functionUrl(port: number, mode: string, target?: string): string {
  const url = new URL(`http://127.0.0.1:${port}/functions/v1/network-probe`);
  url.searchParams.set("mode", mode);
  if (target !== undefined) url.searchParams.set("target", target);
  return url.href;
}

async function probe(
  port: number,
  mode: string,
  target?: string,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  const response = await fetch(functionUrl(port, mode, target));
  assertEquals(response.status, 200);
  return await response.json();
}

function startServer(root: string, port: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
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
  throw new Error("Timed out waiting for Functions network failure server");
}

async function withTimeout(promise: Promise<void>, message: string): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 5_000)),
  ]);
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
