import "@supabase/server";
import { join } from "@std/path";
import { loadOrCreateAuthSecrets, publicAuthJwks } from "../src/auth/secrets.ts";
import { AuthService } from "../src/auth/service.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { createAppHandler } from "../src/server/app.ts";
import { LocalObjectStore } from "../src/storage/local.ts";
import {
  assertSupabaseServerWorkerContract,
  installSupabaseServerContextFixture,
  seedSupabaseServerFunctionCache,
} from "../scripts/supabase_server_context_fixture.ts";

Deno.test("real @supabase/server Context runs inside an isolated Function worker", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-functions-worker-context-test-" });
  const root = join(temp, "project");
  const port = availablePort();
  let manager: FunctionManager | null = null;
  let engine: PGliteEngine | null = null;
  const abortController = new AbortController();
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    await installSupabaseServerContextFixture(root);
    const project = await discoverProject(root);
    const config = await loadConfig(project, { port, storagePath: join(temp, "storage") }, {});
    await seedSupabaseServerFunctionCache(join(config.project.cacheDir, "deno"));
    engine = new PGliteEngine(join(temp, "pglite"));
    await engine.start();
    await applyMigrations(engine, project);
    const secrets = await loadOrCreateAuthSecrets(join(temp, "auth-secrets.json"));
    const auth = new AuthService(engine, secrets);
    const anonKey = await auth.createRoleToken("anon");
    const serviceRoleKey = await auth.createRoleToken("service_role");
    manager = new FunctionManager({
      config,
      secrets: {
        anonKey,
        serviceRoleKey,
        jwks: JSON.stringify(publicAuthJwks(secrets)),
      },
    });
    await manager.prepare();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port, signal: abortController.signal },
      createAppHandler({
        config,
        engine,
        authService: auth,
        functionManager: manager,
        objectStore: new LocalObjectStore(config.storage.path),
        resolveRequestContext: (request) => auth.resolveRequestContext(request),
      }),
    );
    await assertSupabaseServerWorkerContract({
      apiUrl: config.server.publicUrl,
      anonKey,
      serviceRoleKey,
      prefix: "isolated",
    });
    abortController.abort();
    await server.finished;
  } finally {
    abortController.abort();
    await manager?.close();
    await engine?.close();
    await Deno.remove(temp, { recursive: true });
  }
});

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile) await Deno.copyFile(sourcePath, destinationPath);
  }
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
