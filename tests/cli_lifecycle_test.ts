import { assert, assertEquals, assertRejects } from "@std/assert";
import { basename, join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { resetProject } from "../src/cli/lifecycle.ts";
import { runCli } from "../src/cli/run.ts";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";
import { prepareProject } from "../src/project/state.ts";

Deno.test("CLI start, status, doctor, stop and recoverable reset lifecycle", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-cli-test-" });
  const source = join(Deno.cwd(), "fixtures", "supabase-basic");
  await copyTree(source, temp);
  const port = availablePort();
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      temp,
      "--port",
      String(port),
    ],
    cwd: temp,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  try {
    const project = await discoverProject(temp);
    const runtime = await waitForRuntime(project.runtimeFile);
    assertEquals(runtime.engine, "pglite");
    assertEquals(runtime.storage, "local");

    assertEquals(await runCli(["status", "--project", temp, "--json"]), 0);
    assertEquals(await runCli(["doctor", "--project", temp, "--json"]), 0);
    assertEquals(await runCli(["stop", "--project", temp, "--json"]), 0);

    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const started = new TextDecoder().decode(output.stdout).split(/\r?\n/u)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "server_started") as {
        url?: string;
        engine?: string;
        storage?: string;
        logsDir?: string;
        databaseMode?: string;
        configuration?: {
          formatVersion: number;
          sources: Record<string, string>;
        };
      } | undefined;
    assertEquals(started?.url, `http://127.0.0.1:${port}`);
    assertEquals(started?.engine, "pglite");
    assertEquals(started?.storage, "local");
    assertEquals(started?.logsDir, project.logsDir);
    assertEquals(started?.databaseMode, "embedded");
    assertEquals(started?.configuration?.formatVersion, 1);
    assertEquals(started?.configuration?.sources["server.port"], "cli");
    assertEquals(await readRuntimeState(project), null);
    const reopened = new PGliteEngine(project.pgliteDataDir);
    await reopened.start();
    await reopened.close();

    assertEquals(await runCli(["version", "--json"]), 0);
    assertEquals(await runCli(["reset", "--project", temp, "--json"]), 1);
    assertEquals(await runCli(["reset", "--project", temp, "--force", "--json"]), 0);
    const backups = [...Deno.readDirSync(project.backupsDir)];
    assert(backups.some((entry) => entry.isDirectory && entry.name.startsWith("reset-")));
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal stop path already reaped the process.
    }
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("reset rejects overlapping database, Storage and backup paths before moving data", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-reset-path-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    const project = await discoverProject(temp);
    await prepareProject(project, "pglite");
    const marker = join(project.pgliteDataDir, "must-remain.txt");
    await Deno.writeTextFile(marker, "preserved");
    const config = await loadConfig(project, {
      storagePath: join(project.minibaseDir, "data"),
    });

    await assertRejects(
      () => resetProject(config, true),
      Error,
      "Database directory",
    );
    assertEquals(await Deno.readTextFile(marker), "preserved");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("a failed local reset rebuild restores the original database and Storage", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-reset-rollback-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    const project = await discoverProject(temp);
    const config = await loadConfig(project);
    await prepareProject(project, "pglite");
    const databaseMarker = join(project.pgliteDataDir, "must-return.txt");
    const storageMarker = join(config.storage.path, "avatars", "must-return.txt");
    await Deno.writeTextFile(databaseMarker, "database-before");
    await Deno.mkdir(join(config.storage.path, "avatars"), { recursive: true });
    await Deno.writeTextFile(storageMarker, "storage-before");
    await Deno.writeTextFile(
      join(project.migrationsDir, "20260805999999_break_reset.sql"),
      "this is not valid sql;\n",
    );

    await assertRejects(
      () => resetProject(config, true),
      Error,
      "Reset failed and was rolled back",
    );
    assertEquals(await Deno.readTextFile(databaseMarker), "database-before");
    assertEquals(await Deno.readTextFile(storageMarker), "storage-before");
    const backups = await directoryNames(project.backupsDir);
    assertEquals(backups.filter((name) => name.startsWith("reset-")).length, 0);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<{
  engine: string;
  storage: string;
}> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for runtime.json");
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

async function directoryNames(path: string): Promise<string[]> {
  try {
    const names = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}
