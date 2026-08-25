import { assert, assertEquals } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";
import { runCli } from "../src/cli/run.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import type { ProjectPaths } from "../src/project/types.ts";
import { prepareProject } from "../src/project/state.ts";
import { LocalObjectStore } from "../src/storage/local.ts";

const crashWriter = fromFileUrl(new URL("./fixtures/storage_crash_writer.ts", import.meta.url));

Deno.test("Minibase startup recovers local Storage crashes on both sides of database commit", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-storage-recovery-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
  const project = await discoverProject(temp);
  await prepareProject(project, "pglite");
  const engine = new PGliteEngine(project.pgliteDataDir);
  try {
    await engine.start();
    await applyMigrations(engine, project);
    await engine.query("insert into storage.buckets(id, name) values ('avatars', 'avatars')");
    const store = new LocalObjectStore(project.storageDir);
    const original = await store.write(
      "avatars",
      "profile/recover.txt",
      new Blob(["original body"]).stream(),
    );
    await original.commit();
    await engine.query(
      `insert into storage.objects(id, bucket_id, name, metadata, version)
       values ($1, 'avatars', 'profile/recover.txt', '{"size":13}'::jsonb, $2)`,
      [crypto.randomUUID(), original.writeId],
    );
    await original.finalize();
    await engine.close();

    const interrupted = await crashDuringWrite(project.storageDir, "partial body");
    assertEquals(interrupted.code, 92);
    const interruptedRecovery = await restartAndStop(temp, project, availablePort());
    assertRecoveryEvent(interruptedRecovery.stdout, { rolledBack: 1, finalized: 0 });
    assertEquals(await readObject(project.storageDir), "original body");
    assertEquals(await storageJournalEntries(project.storageDir), []);

    const uncommitted = await crashAfterSwitch(project.storageDir, "uncommitted body");
    assertEquals(uncommitted.code, 91);
    const rolledBack = await restartAndStop(temp, project, availablePort());
    assertRecoveryEvent(rolledBack.stdout, { rolledBack: 1, finalized: 0 });
    assertEquals(await readObject(project.storageDir), "original body");
    assertEquals(await storageJournalEntries(project.storageDir), []);

    const committed = await crashAfterSwitch(project.storageDir, "committed body");
    assertEquals(committed.code, 91);
    const committedWriteId = JSON.parse(committed.stdout.trim()).writeId as string;
    await engine.start();
    await engine.query(
      `update storage.objects set metadata = '{"size":14}'::jsonb, version = $1
       where bucket_id = 'avatars' and name = 'profile/recover.txt'`,
      [committedWriteId],
    );
    await engine.close();
    const finalized = await restartAndStop(temp, project, availablePort());
    assertRecoveryEvent(finalized.stdout, { rolledBack: 0, finalized: 1 });
    assertEquals(await readObject(project.storageDir), "committed body");
    assertEquals(await storageJournalEntries(project.storageDir), []);
    assertEquals(
      await new LocalObjectStore(project.storageDir).list(),
      [{ bucket: "avatars", name: "profile/recover.txt", size: 14 }],
    );
  } finally {
    await engine.close().catch(() => {});
    await Deno.remove(temp, { recursive: true });
  }
});

async function crashAfterSwitch(
  storageRoot: string,
  body: string,
): Promise<{ code: number; stdout: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      crashWriter,
      storageRoot,
      "avatars",
      "profile/recover.txt",
      body,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: output.code, stdout: new TextDecoder().decode(output.stdout) };
}

async function crashDuringWrite(
  storageRoot: string,
  body: string,
): Promise<{ code: number }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      crashWriter,
      storageRoot,
      "avatars",
      "profile/recover.txt",
      body,
      "during-write",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: output.code };
}

async function restartAndStop(
  root: string,
  project: ProjectPaths,
  port: number,
): Promise<{ stdout: string }> {
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
    assertEquals(await runCli(["stop", "--project", root, "--json"]), 0);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return { stdout: new TextDecoder().decode(output.stdout) };
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal stop path already reaped the process.
    }
  }
}

async function readObject(storageRoot: string): Promise<string> {
  const object = await new LocalObjectStore(storageRoot).read("avatars", "profile/recover.txt");
  return await new Response(object.body).text();
}

async function storageJournalEntries(storageRoot: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(join(storageRoot, ".minibase-internal", "writes"))
    ) {
      entries.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return entries.sort();
}

function recoveryEvents(stdout: string): Record<string, unknown>[] {
  return stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "storage_recovery");
}

function assertRecoveryEvent(
  stdout: string,
  expected: { rolledBack: number; finalized: number },
): void {
  const events = recoveryEvents(stdout);
  assertEquals(events.length, 1);
  const event = events[0]!;
  assertEquals(event.level, "info");
  assertEquals(event.module, "storage");
  assertEquals(event.event, "storage_recovery");
  assertEquals(event.rolledBack, expected.rolledBack);
  assertEquals(event.finalized, expected.finalized);
  assert(typeof event.timestamp === "string" && event.timestamp.length > 0);
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
  throw new Error("Timed out waiting for Minibase startup");
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
