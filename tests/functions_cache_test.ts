import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { runDoctor } from "../src/diagnostics/doctor.ts";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";
import type { ProjectPaths } from "../src/project/types.ts";

Deno.test("Functions CLI caches a locked remote dependency for offline startup", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-cache-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
  const dependencyAbort = new AbortController();
  const listening = Promise.withResolvers<number>();
  const dependencyServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: dependencyAbort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    (request) => {
      assertEquals(new URL(request.url).pathname, "/dependency.ts");
      return new Response('export const message = "cached remote dependency";\n', {
        headers: { "content-type": "application/typescript" },
      });
    },
  );
  try {
    const dependencyUrl = `http://127.0.0.1:${await listening.promise}/dependency.ts`;
    const supabaseDir = join(root, "supabase");
    const functionDir = join(supabaseDir, "functions", "cached-dependency");
    const entry = join(functionDir, "index.ts");
    const denoConfig = join(supabaseDir, "deno.json");
    const lockfile = join(supabaseDir, "deno.lock");
    await Deno.mkdir(functionDir, { recursive: true });
    await Deno.writeTextFile(
      denoConfig,
      JSON.stringify({ imports: { "remote-dependency": dependencyUrl } }, null, 2) + "\n",
    );
    await Deno.writeTextFile(
      entry,
      'import { message } from "remote-dependency";\n' +
        "Deno.serve(() => new Response(message));\n",
    );
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[functions.cached-dependency]\nverify_jwt = false\n",
    );

    const lockBuildCache = join(root, ".lock-build-cache");
    const lockResult = await new Deno.Command(Deno.execPath(), {
      args: [
        "cache",
        "--allow-import",
        `--config=${denoConfig}`,
        `--lock=${lockfile}`,
        "--frozen=false",
        entry,
      ],
      env: { DENO_DIR: lockBuildCache, DENO_NO_UPDATE_CHECK: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(lockResult.code, 0, new TextDecoder().decode(lockResult.stderr));
    await Deno.remove(lockBuildCache, { recursive: true });

    const project = await discoverProject(root);
    const uncachedDoctor = await runDoctor(
      await loadConfig(project, { port: availablePort() }),
    );
    assertEquals(
      uncachedDoctor.checks.find((check) => check.code === "functions.cache")?.severity,
      "warning",
    );
    assertEquals(
      await startInvokeAndStop(root, project, availablePort()),
      "cached remote dependency",
    );
    const cachedDoctor = await runDoctor(
      await loadConfig(project, { port: availablePort() }),
    );
    assertEquals(
      cachedDoctor.checks.find((check) => check.code === "functions.cache")?.severity,
      "info",
    );

    const cached = await runCliProcess([
      "functions",
      "cache",
      "--project",
      root,
      "--json",
    ], root);
    assertEquals(cached.code, 0, cached.stderr);
    const cacheResult = JSON.parse(cached.stdout) as {
      ok: boolean;
      functions: Array<{ name: string; cached: boolean }>;
    };
    assertEquals(cacheResult.ok, true);
    assert(
      cacheResult.functions.some((item) => item.name === "cached-dependency" && item.cached),
    );

    dependencyAbort.abort();
    await dependencyServer.finished;
    assertEquals(
      await startInvokeAndStop(root, project, availablePort()),
      "cached remote dependency",
    );

    const lock = JSON.parse(await Deno.readTextFile(lockfile)) as Record<string, unknown>;
    lock.remote = {};
    await Deno.writeTextFile(lockfile, JSON.stringify(lock, null, 2) + "\n");
    const refused = await runCliProcess([
      "functions",
      "cache",
      "--project",
      root,
      "--json",
    ], root);
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr.toLowerCase(), "lock");
  } finally {
    dependencyAbort.abort();
    await dependencyServer.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

async function startInvokeAndStop(
  root: string,
  project: ProjectPaths,
  port: number,
): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
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
  try {
    await waitForRuntime(project.runtimeFile);
    const runtime = await readRuntimeState(project);
    assert(runtime);
    const response = await fetch(
      `http://127.0.0.1:${port}/functions/v1/cached-dependency`,
    );
    const body = await response.text();
    assertEquals(response.status, 200, body);
    const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
      method: "POST",
      headers: { "x-minibase-control-token": runtime.controlToken },
    });
    assertEquals(stopped.status, 202);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return body;
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal shutdown path already reaped the process.
    }
  }
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
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
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
  throw new Error("Timed out waiting for Functions cache server");
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
