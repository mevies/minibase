import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("Function pool caches dependencies, reloads, limits, times out and reaps idle workers", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-function-runtime-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
  const functionsDir = join(temp, "supabase", "functions");
  const localDependenciesDir = join(temp, "supabase", "local-dependencies");
  await Deno.mkdir(join(functionsDir, "_shared"), { recursive: true });
  await Deno.mkdir(localDependenciesDir, { recursive: true });
  await Deno.mkdir(join(functionsDir, "version"), { recursive: true });
  await Deno.mkdir(join(functionsDir, "limited"), { recursive: true });
  await Deno.mkdir(join(functionsDir, "crash"), { recursive: true });
  await Deno.mkdir(join(functionsDir, "escape"), { recursive: true });
  await Deno.mkdir(join(functionsDir, "missing-entry"), { recursive: true });
  await Deno.writeTextFile(
    join(functionsDir, "_shared", "version.ts"),
    'export const sharedVersion = "shared-one";\n',
  );
  await Deno.writeTextFile(
    join(localDependenciesDir, "version.ts"),
    'export const localVersion = "outside-one";\n',
  );
  await Deno.writeTextFile(
    join(functionsDir, "version", "index.ts"),
    'import { sharedVersion } from "../_shared/version.ts";\n' +
      'import { localVersion } from "../../local-dependencies/version.ts";\n' +
      "Deno.serve(() => new Response(`version-one:${sharedVersion}:${localVersion}`));\n",
  );
  await Deno.writeTextFile(
    join(functionsDir, "limited", "index.ts"),
    `Deno.serve(async (request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("state")) return Response.json({ pid: Deno.pid });
      const milliseconds = Number(url.searchParams.get("ms") ?? 0);
      if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return new Response(await request.text() || "ok");
    });
`,
  );
  await Deno.writeTextFile(
    join(functionsDir, "crash", "index.ts"),
    `let requests = 0;
Deno.serve((request) => {
  if (new URL(request.url).searchParams.has("crash")) Deno.exit(42);
  requests++;
  return Response.json({ pid: Deno.pid, requests });
});
`,
  );
  await Deno.writeTextFile(
    join(temp, "outside-function-root.ts"),
    'export const outside = "must-not-load";\n',
  );
  await Deno.writeTextFile(
    join(functionsDir, "escape", "index.ts"),
    'import { outside } from "../../../outside-function-root.ts";\n' +
      "Deno.serve(() => new Response(outside));\n",
  );
  const project = await discoverProject(temp);
  const config = await loadConfig(project, {}, {});
  const database = new PGliteEngine(join(temp, "database-stability"));
  const startupMetrics: Array<{
    phase: string;
    durationMs: number;
    functionName?: string;
  }> = [];
  const manager = new FunctionManager({
    config,
    secrets: { anonKey: "anon-test", serviceRoleKey: "service-test" },
    requestTimeoutMs: 80,
    maxRequestBytes: 16,
    concurrencyPerFunction: 1,
    idleTimeoutMs: 100,
    hotReload: true,
    onStartupMetric: (metric) => startupMetrics.push(metric),
  });
  try {
    await database.start();
    await database.exec("create table worker_pool_probe(value integer not null)");
    await database.exec("insert into worker_pool_probe(value) values (42)");
    const cached = await manager.prepare();
    assert(cached.some((item) => item.name === "version" && item.cached));
    assertEquals(startupMetrics[0]?.phase, "dependency_cache");
    assert((startupMetrics[0]?.durationMs ?? -1) >= 0);

    const brokenDirectory = join(functionsDir, "broken");
    await Deno.mkdir(brokenDirectory, { recursive: true });
    await Deno.writeTextFile(
      join(brokenDirectory, "index.ts"),
      'const value: number = "service-test";\nDeno.serve(() => new Response(String(value)));\n',
    );
    const typeError = await assertRejects(
      () => manager.invoke("broken", new Request("http://localhost/functions/v1/broken")),
      Error,
      "index.ts:1",
    );
    assertStringIncludes(typeError.message, "TS2322");
    assertStringIncludes(typeError.message, "[REDACTED]");
    assertEquals(typeError.message.includes("service-test"), false);
    assertEquals(typeError.message.includes("\u001b"), false);

    await assertRejects(
      () => manager.invoke("escape", new Request("http://localhost/functions/v1/escape")),
      Error,
      "Function local dependency escapes the permitted project roots",
    );

    await assertRejects(
      () =>
        manager.invoke(
          "missing-entry",
          new Request("http://localhost/functions/v1/missing-entry"),
        ),
      Error,
      `Edge Function entrypoint is missing: ${join(functionsDir, "missing-entry", "index.ts")}`,
    );

    const first = await manager.invoke(
      "version",
      new Request("http://localhost/functions/v1/version"),
    );
    assertEquals(await first.text(), "version-one:shared-one:outside-one");
    assertEquals(manager.workerCountForTest(), 1);
    assert(
      startupMetrics.some((metric) =>
        metric.phase === "type_check" && metric.functionName === "version" &&
        metric.durationMs >= 0
      ),
    );
    assert(
      startupMetrics.some((metric) =>
        metric.phase === "worker_ready" && metric.functionName === "version" &&
        metric.durationMs >= 0
      ),
    );

    await Deno.writeTextFile(
      join(functionsDir, "_shared", "version.ts"),
      'export const sharedVersion: number = "shared-type-error";\n',
    );
    const sharedTypeError = await assertRejects(
      () => manager.invoke("version", new Request("http://localhost/functions/v1/version")),
      Error,
      "TS2322",
    );
    assertStringIncludes(sharedTypeError.message, "_shared/version.ts:1");

    await Deno.writeTextFile(
      join(functionsDir, "_shared", "version.ts"),
      'export const sharedVersion = "shared-version-two";\n',
    );
    const sharedReloaded = await manager.invoke(
      "version",
      new Request("http://localhost/functions/v1/version"),
    );
    assertEquals(
      await sharedReloaded.text(),
      "version-one:shared-version-two:outside-one",
    );

    await Deno.writeTextFile(
      join(localDependenciesDir, "version.ts"),
      'export const localVersion: number = "outside-type-error";\n',
    );
    const localDependencyTypeError = await assertRejects(
      () => manager.invoke("version", new Request("http://localhost/functions/v1/version")),
      Error,
      "TS2322",
    );
    assertStringIncludes(localDependencyTypeError.message, "local-dependencies/version.ts:1");

    await Deno.writeTextFile(
      join(localDependenciesDir, "version.ts"),
      'export const localVersion = "outside-two";\n',
    );
    const localDependencyReloaded = await manager.invoke(
      "version",
      new Request("http://localhost/functions/v1/version"),
    );
    assertEquals(
      await localDependencyReloaded.text(),
      "version-one:shared-version-two:outside-two",
    );

    await Deno.writeTextFile(
      join(functionsDir, "version", "index.ts"),
      'Deno.serve(() => new Response("version-two-with-reload"));\n',
    );
    const reloaded = await manager.invoke(
      "version",
      new Request("http://localhost/functions/v1/version"),
    );
    assertEquals(await reloaded.text(), "version-two-with-reload");

    const oversized = await manager.invoke(
      "limited",
      new Request("http://localhost/functions/v1/limited", {
        method: "POST",
        body: "this body is definitely larger than sixteen bytes",
      }),
    );
    assertEquals(oversized.status, 413);

    const limitedBefore = await invokeJson(manager, "limited", "?state=1");
    await assertRejects(
      () =>
        manager.invoke(
          "limited",
          new Request("http://localhost/functions/v1/limited?ms=200"),
        ),
      Error,
      "exceeded its 80 ms timeout",
    );
    const limitedAfter = await invokeJson(manager, "limited", "?state=1");
    assert(limitedAfter.pid !== limitedBefore.pid);

    const crashBefore = await invokeJson(manager, "crash");
    assertEquals(crashBefore.requests, 1);
    await assertRejects(
      () =>
        manager.invoke(
          "crash",
          new Request("http://localhost/functions/v1/crash?crash=1"),
        ),
      Error,
    );
    const crashAfter = await invokeJson(manager, "crash");
    assertEquals(crashAfter.requests, 1);
    assert(crashAfter.pid !== crashBefore.pid);
    const stable = await database.query<{ value: number }>("select value from worker_pool_probe");
    assertEquals(stable.rows, [{ value: 42 }]);

    const concurrencyStarted = performance.now();
    await Promise.all([1, 2].map(async () => {
      const response = await manager.invoke(
        "limited",
        new Request("http://localhost/functions/v1/limited?ms=55"),
      );
      await response.text();
    }));
    assert(performance.now() - concurrencyStarted >= 100);

    await new Promise((resolve) => setTimeout(resolve, 350));
    assertEquals(manager.workerCountForTest(), 0);
  } finally {
    await manager.close();
    await database.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Function process pools isolate timeout and crash recycling within one function", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-function-process-pool-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
  const functionDir = join(temp, "supabase", "functions", "pool-probe");
  await Deno.mkdir(functionDir, { recursive: true });
  await Deno.writeTextFile(
    join(functionDir, "index.ts"),
    `Deno.serve(async (request) => {
  const url = new URL(request.url);
  const milliseconds = Number(url.searchParams.get("ms") ?? 0);
  if (milliseconds > 0) await new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (url.searchParams.has("crash")) Deno.exit(42);
  return Response.json({ pid: Deno.pid, label: url.searchParams.get("label") });
});
`,
  );
  const project = await discoverProject(temp);
  const config = await loadConfig(project, {}, {});
  const manager = new FunctionManager({
    config,
    secrets: { anonKey: "anon-test", serviceRoleKey: "service-test" },
    requestTimeoutMs: 180,
    concurrencyPerFunction: 2,
    workersPerFunction: 2,
    idleTimeoutMs: 2_000,
    hotReload: false,
  });
  try {
    await manager.prepare();

    const [first, second] = await Promise.all([
      invokeJson(manager, "pool-probe", "?ms=40&label=first"),
      invokeJson(manager, "pool-probe", "?ms=40&label=second"),
    ]);
    const initialPids = new Set([first.pid, second.pid]);
    assertEquals(initialPids.size, 2);
    assertEquals(manager.workerCountForTest(), 2);

    const limitedStartedAt = performance.now();
    await Promise.all(
      [1, 2, 3].map((index) => invokeJson(manager, "pool-probe", `?ms=120&label=limited-${index}`)),
    );
    assert(performance.now() - limitedStartedAt >= 200);

    const timeoutStable = invokeJson(manager, "pool-probe", "?ms=120&label=timeout-stable");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await assertRejects(
      () =>
        manager.invoke(
          "pool-probe",
          new Request("http://localhost/functions/v1/pool-probe?ms=400&label=timeout"),
        ),
      Error,
      "exceeded its 180 ms timeout",
    );
    const timeoutStableResult = await timeoutStable;
    assertEquals(timeoutStableResult.label, "timeout-stable");
    assert(initialPids.has(timeoutStableResult.pid));

    const [timeoutRecoveryOne, timeoutRecoveryTwo] = await Promise.all([
      invokeJson(manager, "pool-probe", "?ms=40&label=timeout-recovery-one"),
      invokeJson(manager, "pool-probe", "?ms=40&label=timeout-recovery-two"),
    ]);
    assertEquals(new Set([timeoutRecoveryOne.pid, timeoutRecoveryTwo.pid]).size, 2);
    assert(
      timeoutRecoveryOne.pid === timeoutStableResult.pid ||
        timeoutRecoveryTwo.pid === timeoutStableResult.pid,
    );

    const crashStable = invokeJson(manager, "pool-probe", "?ms=120&label=crash-stable");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await assertRejects(
      () =>
        manager.invoke(
          "pool-probe",
          new Request("http://localhost/functions/v1/pool-probe?crash=1"),
        ),
      Error,
    );
    const crashStableResult = await crashStable;
    assertEquals(crashStableResult.label, "crash-stable");

    const [crashRecoveryOne, crashRecoveryTwo] = await Promise.all([
      invokeJson(manager, "pool-probe", "?ms=40&label=crash-recovery-one"),
      invokeJson(manager, "pool-probe", "?ms=40&label=crash-recovery-two"),
    ]);
    assertEquals(new Set([crashRecoveryOne.pid, crashRecoveryTwo.pid]).size, 2);
    assert(
      crashRecoveryOne.pid === crashStableResult.pid ||
        crashRecoveryTwo.pid === crashStableResult.pid,
    );
    assertEquals(manager.workerCountForTest(), 2);
  } finally {
    await manager.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("Function manager close terminates workers that are still starting", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-function-startup-close-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), temp);
  const functionDir = join(temp, "supabase", "functions", "slow-start");
  await Deno.mkdir(functionDir, { recursive: true });
  await Deno.writeTextFile(
    join(functionDir, "index.ts"),
    `await new Promise((resolve) => setTimeout(resolve, 10_000));
Deno.serve(() => new Response("ready"));
`,
  );
  const project = await discoverProject(temp);
  const config = await loadConfig(project, {}, {});
  const manager = new FunctionManager({
    config,
    secrets: { anonKey: "anon-test", serviceRoleKey: "service-test" },
    hotReload: false,
  });
  try {
    await manager.prepare();
    const invocation = manager.invoke(
      "slow-start",
      new Request("http://localhost/functions/v1/slow-start"),
    );
    const rejection = assertRejects(() => invocation, Error, "exited before becoming ready");
    const startupDeadline = Date.now() + 3_000;
    while (manager.startingWorkerCountForTest() === 0 && Date.now() < startupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(manager.startingWorkerCountForTest(), 1);
    const closeStartedAt = performance.now();
    await manager.close();
    assert(performance.now() - closeStartedAt < 3_000);
    await rejection;
    assertEquals(manager.workerCountForTest(), 0);
  } finally {
    await manager.close();
    await Deno.remove(temp, { recursive: true });
  }
});

async function invokeJson(
  manager: FunctionManager,
  name: string,
  search = "",
): Promise<Record<string, unknown>> {
  const response = await manager.invoke(
    name,
    new Request(`http://localhost/functions/v1/${name}${search}`),
  );
  assertEquals(response.status, 200);
  return await response.json();
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
