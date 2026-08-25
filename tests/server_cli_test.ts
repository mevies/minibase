import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { runCli } from "../src/cli/run.ts";
import { loadConfig } from "../src/config/load.ts";
import { runDoctor } from "../src/diagnostics/doctor.ts";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";
import { assertSupabaseRestContract } from "./helpers/supabase_rest_contract.ts";

const postgresRuntime = await findPostgresRuntime();

Deno.test({
  name: "Server CLI exposes the API without exposing PostgreSQL and survives managed reset",
  ignore: postgresRuntime === null,
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: "minibase-server-cli-test-" });
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    const apiPort = availablePort();
    const databasePort = availablePort();
    const children: Deno.ChildProcess[] = [];
    const child = startServer(temp, apiPort, databasePort, postgresRuntime!);
    children.push(child);
    try {
      const project = await discoverProject(temp);
      const runtime = await waitForRuntime(project.runtimeFile);
      assertEquals(runtime.engine, "postgres");
      assertEquals(runtime.apiUrl, `http://127.0.0.1:${apiPort}`);
      const externalAddress = Deno.networkInterfaces().find((networkInterface) =>
        networkInterface.family === "IPv4" && !networkInterface.address.startsWith("127.")
      )?.address;
      assert(externalAddress !== undefined, "A non-loopback IPv4 interface is required");
      const externalApiUrl = `http://${externalAddress}:${apiPort}`;
      const externalHealth = await fetch(new URL("/health/live", externalApiUrl));
      assertEquals(externalHealth.status, 200);
      const externalReadiness = await fetch(new URL("/health/ready", externalApiUrl));
      assertEquals(externalReadiness.status, 200);
      const readiness = await externalReadiness.json();
      assertEquals(readiness.engine, "postgres");
      assertEquals(readiness.checks, {
        database: { ready: true },
        migrations: { ready: true },
        storage: { ready: true, driver: "local" },
        functions: { ready: true },
      });
      assertEquals(await tcpConnects(externalAddress, databasePort), false);
      const database = postgres(
        `postgres://postgres@127.0.0.1:${databasePort}/postgres`,
        { max: 1, connect_timeout: 5, onnotice: () => {} },
      );
      try {
        const settings = await database.unsafe<{ listen_addresses: string }[]>(
          "select current_setting('listen_addresses') as listen_addresses",
        );
        assertEquals(settings[0]?.listen_addresses, "127.0.0.1");
      } finally {
        await database.end({ timeout: 1 });
      }
      const capabilitiesResponse = await fetch(
        new URL("/_minibase/capabilities", runtime.apiUrl),
      );
      assertEquals(capabilitiesResponse.status, 200);
      const capabilities = await capabilitiesResponse.json();
      assertEquals(capabilities.engine, "postgres");
      assertEquals(capabilities.externalConnections, true);
      assertEquals(capabilities.concurrentConnections, true);
      assertEquals(capabilities.logicalReplication, "configurable");
      assert(Array.isArray(capabilities.extensions));
      assertEquals(capabilities.limitations.externalConnections, null);
      assertEquals(
        capabilities.limitations.logicalReplication.code,
        "database.logical_replication.requires_configuration",
      );
      const doctor = await runDoctor(
        await loadConfig(
          project,
          { engine: "postgres" },
          { MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime! },
        ),
      );
      assertEquals(
        doctor.checks.find((check) => check.code === "database.extension.pgcrypto")?.severity,
        "info",
      );
      assertEquals(
        doctor.checks.find((check) => check.code === "database.extension.uuid-ossp")?.severity,
        "info",
      );
      const client = createClient(runtime.apiUrl, "server-test-anon-placeholder", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const signup = await client.auth.signUp({
        email: "server-cli@example.com",
        password: "correct horse battery staple",
        options: { data: { display_name: "Server CLI" } },
      });
      assertEquals(signup.error, null);
      assert(signup.data.user !== null);
      assert(signup.data.session !== null);
      const functionResponse = await fetch(new URL("/functions/v1/echo", externalApiUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${signup.data.session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ publicApi: true, privateDatabase: true }),
      });
      assertEquals(functionResponse.status, 200);
      assertEquals((await functionResponse.json()).body, {
        publicApi: true,
        privateDatabase: true,
      });
      const restContract = await assertSupabaseRestContract(
        client,
        signup.data.user.id,
        "Server CLI",
        "server",
      );
      await Deno.writeTextFile(join(project.storageDir, "original-object.txt"), "original");

      assertEquals(await runCli(["stop", "--project", temp, "--json"]), 0);
      const output = await child.output();
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      assertEquals(await readRuntimeState(project), null);
      assertEquals(await fileExists(join(project.postgresDataDir, "postmaster.pid")), false);

      const storageCheck = await runCliProcess(
        ["storage", "check", "--project", temp, "--engine", "postgres", "--json"],
        temp,
        databasePort,
        postgresRuntime!,
      );
      assertEquals(storageCheck.code, 0, storageCheck.stderr);
      assertEquals(storageCheck.stderr, "");
      assertEquals((JSON.parse(storageCheck.stdout) as { ok: boolean }).ok, true);

      const reset = await runCliProcess(
        ["reset", "--project", temp, "--engine", "postgres", "--force", "--json"],
        temp,
        databasePort,
        postgresRuntime!,
      );
      assertEquals(reset.code, 0, reset.stderr);
      assertEquals(reset.stderr, "");
      const resetResult = JSON.parse(reset.stdout) as {
        backupDir: string | null;
        migrations: string[];
        seedApplied: boolean;
      };
      assert(resetResult.backupDir !== null);
      assertEquals(resetResult.migrations, [
        "20260803000100",
        "20260803000200",
        "20260803000300",
      ]);
      assertEquals(resetResult.seedApplied, true);
      const backupDir = resetResult.backupDir;
      const manifest = JSON.parse(
        await Deno.readTextFile(join(backupDir, "manifest.json")),
      ) as {
        formatVersion: number;
        reason: string;
        engine: string;
        databaseMode: string;
        entries: Array<{ kind: string; sourcePath: string; backupPath: string }>;
      };
      assertEquals(manifest.formatVersion, 1);
      assertEquals(manifest.reason, "reset");
      assertEquals(manifest.engine, "postgres");
      assertEquals(manifest.databaseMode, "managed");
      assertEquals(manifest.entries, [
        { kind: "database", sourcePath: "data/postgres", backupPath: "postgres" },
        { kind: "storage", sourcePath: "storage", backupPath: "storage" },
      ]);
      assertEquals(await fileExists(join(backupDir, "postgres", "PG_VERSION")), true);
      assertEquals(
        await Deno.readTextFile(join(backupDir, "storage", "original-object.txt")),
        "original",
      );

      const resetChild = startServer(temp, apiPort, databasePort, postgresRuntime!);
      children.push(resetChild);
      const resetRuntime = await waitForRuntime(project.runtimeFile);
      const resetClient = createClient(resetRuntime.apiUrl, "server-test-anon-placeholder", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const signupAfterReset = await resetClient.auth.signUp({
        email: "server-cli@example.com",
        password: "correct horse battery staple",
      });
      assertEquals(signupAfterReset.error, null);
      assert(signupAfterReset.data.user !== null);
      const notesAfterReset = await resetClient.from("notes").select("body");
      assertEquals(notesAfterReset.error, null);
      assertEquals(notesAfterReset.data, []);
      assertEquals(await runCli(["stop", "--project", temp, "--json"]), 0);
      const resetOutput = await resetChild.output();
      assertEquals(resetOutput.code, 0, new TextDecoder().decode(resetOutput.stderr));

      await Deno.remove(project.postgresDataDir, { recursive: true });
      await Deno.remove(project.storageDir, { recursive: true });
      await Deno.rename(join(backupDir, "postgres"), project.postgresDataDir);
      await Deno.rename(join(backupDir, "storage"), project.storageDir);

      const restoredChild = startServer(temp, apiPort, databasePort, postgresRuntime!);
      children.push(restoredChild);
      const restoredRuntime = await waitForRuntime(project.runtimeFile);
      const restoredClient = createClient(restoredRuntime.apiUrl, "server-test-anon-placeholder", {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const restoredLogin = await restoredClient.auth.signInWithPassword({
        email: "server-cli@example.com",
        password: "correct horse battery staple",
      });
      assertEquals(restoredLogin.error, null);
      const restoredNote = await restoredClient.from("notes").select("body").eq(
        "body",
        restContract.retainedBody,
      ).single();
      assertEquals(restoredNote.error, null);
      assertEquals(restoredNote.data?.body, restContract.retainedBody);
      assertEquals(
        await Deno.readTextFile(join(project.storageDir, "original-object.txt")),
        "original",
      );
      assertEquals(await runCli(["stop", "--project", temp, "--json"]), 0);
      const restoredOutput = await restoredChild.output();
      assertEquals(restoredOutput.code, 0, new TextDecoder().decode(restoredOutput.stderr));
    } finally {
      for (const process of children) {
        try {
          process.kill("SIGKILL");
        } catch {
          // Normal stop already reaped it.
        }
      }
      await Deno.remove(temp, { recursive: true });
    }
  },
});

function startServer(
  project: string,
  apiPort: number,
  databasePort: number,
  runtimeDir: string,
): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      project,
      "--engine",
      "postgres",
      "--host",
      "0.0.0.0",
      "--port",
      String(apiPort),
    ],
    cwd: project,
    env: {
      MINIBASE_POSTGRES_RUNTIME_DIR: runtimeDir,
      MINIBASE_POSTGRES_PORT: String(databasePort),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function runCliProcess(
  args: string[],
  project: string,
  databasePort: number,
  runtimeDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd: project,
    env: {
      MINIBASE_POSTGRES_RUNTIME_DIR: runtimeDir,
      MINIBASE_POSTGRES_PORT: String(databasePort),
    },
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

async function findPostgresRuntime(): Promise<string | null> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (await fileExists(join(candidate, "bin", "postgres.exe"))) return candidate;
  }
  return null;
}

async function waitForRuntime(path: string): Promise<{
  engine: string;
  apiUrl: string;
}> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server runtime.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function tcpConnects(hostname: string, port: number): Promise<boolean> {
  try {
    const connection = await Deno.connect({ hostname, port });
    connection.close();
    return true;
  } catch {
    return false;
  }
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
