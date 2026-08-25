import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import type { DatabaseEngine } from "../src/database/contract.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import type { HttpRequestLog } from "../src/server/app.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import { MINIBASE_VERSION } from "../src/version.ts";

Deno.test("health endpoints report the actual database readiness", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-app-test-" });
  await copyTree(
    join(Deno.cwd(), "fixtures", "supabase-basic", "supabase"),
    join(temp, "supabase"),
  );
  const project = await discoverProject(temp);
  const config = await loadConfig(project, { storagePath: join(temp, "storage") }, {
    MINIBASE_CORS_ALLOWED_ORIGINS: "https://app.example",
    MINIBASE_REQUEST_MAX_BODY_BYTES: "1024",
  });
  const engine = new PGliteEngine(join(temp, "pglite"));
  let manager: FunctionManager | null = null;
  try {
    await engine.start();
    await applyMigrations(engine, project);
    const auth = new AuthService(engine, {
      jwtSecret: "test-secret-with-at-least-32-characters",
    });
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey: await auth.createRoleToken("anon"),
        serviceRoleKey: await auth.createRoleToken("service_role"),
      },
    });
    await manager.prepare();
    const objectStore = new LocalObjectStore(config.storage.path);
    const requestLogs: HttpRequestLog[] = [];
    const handler = createAppHandler({
      config,
      engine,
      authService: auth,
      functionManager: manager,
      objectStore,
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
      resolveRequestContext: (request) => auth.resolveRequestContext(request),
      logRequest: (event) => requestLogs.push(event),
    });

    const live = await handler(new Request("http://localhost/health/live"));
    assertEquals(live.status, 200);
    assertEquals((await live.json()).status, "live");

    const ready = await handler(new Request("http://localhost/health/ready"));
    assertEquals(ready.status, 200);
    assertEquals(await ready.json(), {
      status: "ready",
      version: MINIBASE_VERSION,
      engine: "pglite",
      checks: {
        database: { ready: true },
        migrations: { ready: true },
        storage: { ready: true, driver: "local" },
        functions: { ready: true },
      },
    });

    const pendingMigration = join(project.migrationsDir, "20260805999999_pending.sql");
    await Deno.writeTextFile(pendingMigration, "create table public.pending_health(id int);\n");
    const pending = await handler(new Request("http://localhost/health/ready"));
    assertEquals(pending.status, 503);
    assertEquals((await pending.json()).checks.migrations.ready, false);
    await Deno.remove(pendingMigration);

    const functionEntry = join(project.functionsDir, "echo", "index.ts");
    const disabledFunctionEntry = `${functionEntry}.disabled`;
    await Deno.rename(functionEntry, disabledFunctionEntry);
    const missingFunction = await handler(new Request("http://localhost/health/ready"));
    assertEquals(missingFunction.status, 503);
    assertEquals((await missingFunction.json()).checks.functions.ready, false);
    await Deno.rename(disabledFunctionEntry, functionEntry);

    const storageUnavailable = createAppHandler({
      config,
      engine,
      authService: auth,
      functionManager: manager,
      objectStore: new UnhealthyLocalObjectStore(config.storage.path),
    });
    const failedStorage = await storageUnavailable(
      new Request("http://localhost/health/ready"),
    );
    assertEquals(failedStorage.status, 503);
    assertEquals((await failedStorage.json()).checks.storage, {
      ready: false,
      driver: "local",
    });

    const databaseUnavailable = createAppHandler({
      config,
      engine: withFailedHealth(engine),
      authService: auth,
      functionManager: manager,
      objectStore,
    });
    const failedDatabase = await databaseUnavailable(
      new Request("http://localhost/health/ready"),
    );
    assertEquals(failedDatabase.status, 503);
    assertEquals((await failedDatabase.json()).checks.database.ready, false);

    const capabilities = await handler(
      new Request("http://localhost/_minibase/capabilities"),
    );
    assertEquals(capabilities.status, 200);
    const capabilityBody = await capabilities.json();
    assertEquals(capabilityBody.engine, "pglite");
    assertEquals(typeof capabilityBody.postgresVersion, "string");
    assert(capabilityBody.postgresVersion.length > 0);
    assertEquals(capabilityBody.externalConnections, false);
    assertEquals(capabilityBody.concurrentConnections, false);
    assertEquals(capabilityBody.logicalReplication, "unavailable");
    assertEquals(capabilityBody.extensions, ["plpgsql"]);
    assertEquals(
      capabilityBody.limitations.externalConnections.code,
      "database.external_connections.unavailable",
    );
    assertEquals(
      capabilityBody.limitations.logicalReplication.code,
      "database.logical_replication.unavailable",
    );

    const missing = await handler(new Request("http://localhost/missing"));
    assertEquals(missing.status, 404);
    assertEquals(typeof missing.headers.get("x-request-id"), "string");

    const tooLarge = await handler(
      new Request("http://localhost/rest/v1/notes", {
        method: "POST",
        headers: {
          "content-length": "1025",
          origin: "https://app.example",
          "x-request-id": "request-limit-probe",
        },
        body: new Uint8Array(1_025),
      }),
    );
    assertEquals(tooLarge.status, 413);
    assertEquals(tooLarge.headers.get("x-request-id"), "request-limit-probe");
    assertEquals(tooLarge.headers.get("access-control-allow-origin"), "https://app.example");
    assertEquals((await tooLarge.json()).code, "request_too_large");

    const sensitive = "request-secret-never-log";
    const authResponse = await handler(
      new Request("http://localhost/auth/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: `${sensitive}@example.test`, password: sensitive }),
      }),
    );
    await authResponse.text();
    const storage = await handler(
      new Request(`http://localhost/storage/v1/object/bucket/${sensitive}`),
    );
    await storage.text();

    assert(requestLogs.some((event) => event.module === "auth"));
    assert(requestLogs.some((event) => event.module === "storage"));
    assert(
      requestLogs.every((event) =>
        event.requestId.length > 0 && event.durationMs >= 0 && Number.isInteger(event.status)
      ),
    );
    assertEquals(JSON.stringify(requestLogs).includes(sensitive), false);
  } finally {
    await manager?.close();
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

class UnhealthyLocalObjectStore extends LocalObjectStore {
  override health(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function withFailedHealth(engine: DatabaseEngine): DatabaseEngine {
  return new Proxy(engine, {
    get(target, property) {
      if (property === "health") return () => Promise.resolve(false);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}
