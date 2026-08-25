import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runCli } from "../src/cli/run.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { inspectMigrationAttempts } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";

const VERSION = "20260805000300";

Deno.test("a killed transactional migration is identified and safely retried", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-migration-crash-test-" });
  const migrationsDir = join(temp, "supabase", "migrations");
  await Deno.mkdir(migrationsDir, { recursive: true });
  await Deno.writeTextFile(
    join(migrationsDir, `${VERSION}_crash_recovery.sql`),
    `create table public.migration_recovery_probe(id integer primary key);
do $$
begin
  if (select attempt = 1 from minibase_meta.migration_attempts where version = '${VERSION}') then
    perform pg_sleep(30);
  end if;
end
$$;
insert into public.migration_recovery_probe(id) values (1);
`,
  );
  const project = await discoverProject(temp);
  const first = startServer(temp, availablePort());
  const firstStdout = new Response(first.stdout).text();
  const firstStderr = new Response(first.stderr).text();
  try {
    await waitForFile(join(project.pgliteDataDir, "global", "pg_control"));
    await delay(4_000);
    first.kill("SIGKILL");
    const firstStatus = await first.status;
    assertEquals(firstStatus.success, false);
    await firstStdout;
    await firstStderr;

    const interrupted = new PGliteEngine(project.pgliteDataDir);
    await interrupted.start();
    try {
      const attempt = (await inspectMigrationAttempts(interrupted))[0];
      assertEquals(attempt?.version, VERSION);
      assertEquals(attempt?.state, "running");
      assertEquals(attempt?.attempt, 1);
      assertEquals(
        (await interrupted.query<{ count: number }>(
          "select count(*)::int as count from supabase_migrations.schema_migrations where version = $1",
          [VERSION],
        )).rows,
        [{ count: 0 }],
      );
      assertEquals(
        (await interrupted.query<{ table_name: string | null }>(
          "select to_regclass('public.migration_recovery_probe')::text as table_name",
        )).rows,
        [{ table_name: null }],
      );
    } finally {
      await interrupted.close();
    }

    const second = startServer(temp, availablePort());
    const secondStdout = new Response(second.stdout).text();
    const secondStderr = new Response(second.stderr).text();
    try {
      await waitForFile(project.runtimeFile);
      assertEquals(await runCli(["stop", "--project", temp, "--json"]), 0);
      const status = await second.status;
      assertEquals(status.success, true, await secondStderr);
      await secondStdout;
    } finally {
      try {
        second.kill("SIGKILL");
      } catch {
        // The normal stop path already reaped the process.
      }
    }

    const recovered = new PGliteEngine(project.pgliteDataDir);
    await recovered.start();
    try {
      const attempt = (await inspectMigrationAttempts(recovered))[0];
      assertEquals(attempt?.state, "applied");
      assertEquals(attempt?.attempt, 2);
      assertEquals(
        (await recovered.query<{ id: number }>(
          "select id from public.migration_recovery_probe",
        )).rows,
        [{ id: 1 }],
      );
    } finally {
      await recovered.close();
    }
  } finally {
    try {
      first.kill("SIGKILL");
    } catch {
      // The crash path already reaped the process.
    }
    await Deno.remove(temp, { recursive: true });
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

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await Deno.stat(path)).isFile) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
