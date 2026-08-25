import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AnonymousCleanupScheduler, AuditLogCleanupScheduler } from "../src/auth/cleanup.ts";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { AuthService } from "../src/auth/service.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("anonymous cleanup deletes only expired anonymous users in bounded audited batches", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-cleanup-test-" });
  const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, {
      jwtSecret: "test-secret-with-at-least-32-characters",
    });
    const first = await auth.signUp({});
    const second = await auth.signUp({});
    const fresh = await auth.signUp({});
    const upgraded = await auth.signUp({});
    await auth.updateUser(upgraded.access_token, {
      email: "upgraded-cleanup@example.com",
      password: "correct horse battery staple",
    });
    await engine.query(
      `update auth.users set created_at = $1, updated_at = $1
       where id in ($2, $3, $4)`,
      ["2000-01-01T00:00:00.000Z", first.user.id, second.user.id, upgraded.user.id],
    );

    const firstBatch = await auth.cleanupAnonymousUsers(24 * 60 * 60 * 1_000, 1);
    assertEquals(firstBatch.deleted, 1);
    const secondBatch = await auth.cleanupAnonymousUsers(24 * 60 * 60 * 1_000, 1);
    assertEquals(secondBatch.deleted, 1);
    assertEquals(
      (await auth.cleanupAnonymousUsers(24 * 60 * 60 * 1_000, 1)).deleted,
      0,
    );

    const remaining = await engine.query<
      { id: string; email: string | null; is_anonymous: boolean }
    >(
      `select id, email, is_anonymous from auth.users order by email nulls first, id`,
    );
    assertEquals(remaining.rows.some((row) => row.id === fresh.user.id), true);
    assertEquals(
      remaining.rows.some((row) => row.id === upgraded.user.id && !row.is_anonymous),
      true,
    );
    assertEquals(remaining.rows.some((row) => row.id === first.user.id), false);
    assertEquals(remaining.rows.some((row) => row.id === second.user.id), false);

    const cascaded = await engine.query<{ sessions: number; refresh: number }>(
      `select
         (select count(*)::int from auth.sessions where user_id in ($1, $2)) as sessions,
         (select count(*)::int from auth.refresh_tokens where user_id in ($1, $2)) as refresh`,
      [first.user.id, second.user.id],
    );
    assertEquals(cascaded.rows, [{ sessions: 0, refresh: 0 }]);
    const audit = await engine.query<{ action: string; deleted: number }>(
      `select action, (metadata ->> 'deleted')::int as deleted
       from auth.audit_log where action = 'anonymous.cleanup' order by id`,
    );
    assertEquals(audit.rows, [
      { action: "anonymous.cleanup", deleted: 1 },
      { action: "anonymous.cleanup", deleted: 1 },
    ]);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("configured Minibase server cleans expired anonymous users on startup", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-auth-cleanup-server-test-" });
  let engine: PGliteEngine | null = null;
  let child: Deno.ChildProcess | null = null;
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
    await Deno.writeTextFile(
      join(temp, "minibase.toml"),
      "format_version = 1\n[auth.anonymous_cleanup]\n" +
        "enabled = true\nretention_hours = 1\ninterval_minutes = 60\nbatch_size = 10\n",
    );
    const project = await discoverProject(temp);
    engine = new PGliteEngine(project.pgliteDataDir);
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(
      engine,
      await loadOrCreateAuthSecrets(project.secretsFile),
    );
    const expired = await auth.signUp({});
    await engine.query(
      "update auth.users set created_at = $1, updated_at = $1 where id = $2",
      ["2000-01-01T00:00:00.000Z", expired.user.id],
    );
    await engine.query(
      `insert into auth.audit_log(actor_role, action, created_at)
       values ('system', 'startup.audit.expired', $1)`,
      ["2000-01-01T00:00:00.000Z"],
    );
    await engine.close();
    engine = null;

    const port = availablePort();
    child = startServer(temp, port);
    const runtime = await waitForRuntime(project.runtimeFile);
    let userStatus = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      userStatus = (await fetch(new URL("/auth/v1/user", runtime.apiUrl), {
        headers: { authorization: `Bearer ${expired.access_token}` },
      })).status;
      if (userStatus === 401) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(userStatus, 401);

    assertEquals((await runCliProcess(["stop", "--project", temp, "--json"])).code, 0);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertEquals(stdout.includes('"event":"auth_anonymous_cleanup"'), true);
    assertEquals(stdout.includes('"event":"auth_audit_log_cleanup"'), true);
    child = null;

    engine = new PGliteEngine(project.pgliteDataDir);
    await engine.start();
    const audit = await engine.query<{ action: string }>(
      `select action from auth.audit_log
       where action in ('startup.audit.expired', 'audit.cleanup') order by action`,
    );
    assertEquals(audit.rows, [{ action: "audit.cleanup" }]);
    await engine.close();
    engine = null;
  } finally {
    try {
      child?.kill("SIGKILL");
    } catch {
      // Normal stop already reaped it.
    }
    await engine?.close().catch(() => undefined);
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("anonymous cleanup scheduler runs immediately, periodically and without overlap", async () => {
  let calls = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const firstResult = Promise.withResolvers<void>();
  const scheduler = new AnonymousCleanupScheduler(
    {
      cleanupAnonymousUsers: async () => {
        calls++;
        concurrent++;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        firstResult.resolve();
        return { deleted: 0, cutoff: new Date().toISOString(), batchSize: 1 };
      },
    },
    { retentionMs: 1, intervalMs: 5, batchSize: 1 },
  );
  scheduler.start();
  await firstResult.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await scheduler.close();
  const callsAfterClose = calls;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assertEquals(calls > 1, true);
  assertEquals(calls, callsAfterClose);
  assertEquals(maximumConcurrent, 1);
});

Deno.test("audit log cleanup scheduler runs immediately, periodically and without overlap", async () => {
  let calls = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const firstResult = Promise.withResolvers<void>();
  const scheduler = new AuditLogCleanupScheduler(
    {
      cleanupAuditLog: async () => {
        calls++;
        concurrent++;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        firstResult.resolve();
        return { deleted: 0, cutoff: new Date().toISOString(), batchSize: 1 };
      },
    },
    { retentionMs: 1, intervalMs: 5, batchSize: 1 },
  );
  scheduler.start();
  await firstResult.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await scheduler.close();
  const callsAfterClose = calls;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assertEquals(calls > 1, true);
  assertEquals(calls, callsAfterClose);
  assertEquals(maximumConcurrent, 1);
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

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<{ apiUrl: string }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(path)) as { apiUrl: string };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for anonymous cleanup runtime.json");
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
