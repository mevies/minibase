import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("CLI exports and force-restores a logical backup without overwriting silently", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-backup-cli-test-" });
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const backupDir = join(root, "backup");
  const children: Deno.ChildProcess[] = [];
  try {
    await Deno.mkdir(sourceRoot);
    await Deno.mkdir(targetRoot);
    const fixture = join(Deno.cwd(), "fixtures", "supabase-basic");
    await copyTree(fixture, sourceRoot);
    await copyTree(fixture, targetRoot);

    const sourcePort = availablePort();
    const sourceChild = startServer(sourceRoot, sourcePort);
    children.push(sourceChild);
    const sourceProject = await discoverProject(sourceRoot);
    const sourceRuntime = await waitForRuntime(sourceProject.runtimeFile);
    const sourceClient = createClient(sourceRuntime.apiUrl, "backup-cli-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const signup = await sourceClient.auth.signUp({
      email: "backup-cli@example.com",
      password: "correct horse battery staple",
    });
    assertEquals(signup.error, null);
    assert(signup.data.user !== null);
    const inserted = await sourceClient.from("notes").insert({
      owner_id: signup.data.user.id,
      body: "CLI backup note",
    });
    assertEquals(inserted.error, null);
    assertEquals((await runCliProcess(["stop", "--project", sourceRoot, "--json"])).code, 0);
    assertEquals((await sourceChild.output()).code, 0);

    const exported = await runCliProcess([
      "backup",
      "export",
      "--project",
      sourceRoot,
      "--output",
      backupDir,
      "--json",
    ]);
    assertEquals(exported.code, 0, exported.stderr);
    assertEquals(exported.stderr, "");
    const exportResult = JSON.parse(exported.stdout) as {
      outputDir: string;
      tables: Array<{ schema: string; name: string }>;
      secretsIncluded: boolean;
    };
    assertEquals(exportResult.outputDir, backupDir);
    assertEquals(exportResult.secretsIncluded, false);
    assert(exportResult.tables.some((table) => table.schema === "auth" && table.name === "users"));

    const targetPort = availablePort();
    const targetChild = startServer(targetRoot, targetPort);
    children.push(targetChild);
    const targetProject = await discoverProject(targetRoot);
    await waitForRuntime(targetProject.runtimeFile);
    assertEquals((await runCliProcess(["stop", "--project", targetRoot, "--json"])).code, 0);
    assertEquals((await targetChild.output()).code, 0);

    const refused = await runCliProcess([
      "backup",
      "restore",
      "--project",
      targetRoot,
      "--input",
      backupDir,
      "--json",
    ]);
    assertEquals(refused.code, 1);
    assert(refused.stderr.includes("Restore target is not empty"));

    const restored = await runCliProcess([
      "backup",
      "restore",
      "--project",
      targetRoot,
      "--input",
      backupDir,
      "--force",
      "--json",
    ]);
    assertEquals(restored.code, 0, restored.stderr);
    assertEquals(restored.stderr, "");
    const restoreResult = JSON.parse(restored.stdout) as {
      sourceEngine: string;
      targetEngine: string;
      safetyBackupDir: string | null;
    };
    assertEquals(restoreResult.sourceEngine, "pglite");
    assertEquals(restoreResult.targetEngine, "pglite");
    assert(restoreResult.safetyBackupDir !== null);
    assertEquals(
      (await Deno.stat(join(restoreResult.safetyBackupDir, "manifest.json"))).isFile,
      true,
    );

    const restoredChild = startServer(targetRoot, targetPort);
    children.push(restoredChild);
    const restoredRuntime = await waitForRuntime(targetProject.runtimeFile);
    const restoredClient = createClient(restoredRuntime.apiUrl, "backup-cli-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const login = await restoredClient.auth.signInWithPassword({
      email: "backup-cli@example.com",
      password: "correct horse battery staple",
    });
    assertEquals(login.error, null);
    const note = await restoredClient.from("notes").select("body").eq(
      "body",
      "CLI backup note",
    ).single();
    assertEquals(note.error, null);
    assertEquals(note.data?.body, "CLI backup note");
    assertEquals((await runCliProcess(["stop", "--project", targetRoot, "--json"])).code, 0);
    assertEquals((await restoredChild.output()).code, 0);
  } finally {
    for (const process of children) {
      try {
        process.kill("SIGKILL");
      } catch {
        // Normal stop already reaped it.
      }
    }
    await Deno.remove(root, { recursive: true });
  }
});

function startServer(project: string, port: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      project,
      "--port",
      String(port),
    ],
    cwd: project,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function runCliProcess(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
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

async function waitForRuntime(path: string): Promise<{ apiUrl: string }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for backup CLI runtime.json");
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
    }
  }
}
