import { join } from "@std/path";
import type { DatabaseEngineName, MinibaseConfig } from "../config/types.ts";
import type { DatabaseEngine } from "../database/contract.ts";
import { PGliteEngine } from "../database/pglite.ts";
import { PostgresEngine } from "../database/postgres.ts";
import { resolvePostgresRuntimePath } from "../database/postgres_bundled.ts";
import { PostgresRuntime } from "../database/postgres_runtime.ts";
import type { DiagnosticResult } from "../diagnostics/types.ts";
import type { ProjectPaths } from "../project/types.ts";
import { offlineMigrationCapabilities, scanMigrationCompatibility } from "./compatibility.ts";
import { MigrationExecutionError } from "./runner.ts";

export interface EngineMigrationCheckResult {
  engine: DatabaseEngineName;
  compatible: boolean | null;
  executed: boolean;
  postgresVersion?: string;
  appliedMigrations: string[];
  diagnostics: DiagnosticResult[];
}

export interface MigrationCheckReport {
  ok: boolean;
  complete: boolean;
  projectRoot: string;
  engines: [EngineMigrationCheckResult, EngineMigrationCheckResult];
}

export async function runMigrationCheck(config: MinibaseConfig): Promise<MigrationCheckReport> {
  const pglite = await checkPGlite(config);
  const postgres = await checkPostgres(config);
  const engines: [EngineMigrationCheckResult, EngineMigrationCheckResult] = [pglite, postgres];
  return {
    ok: engines.every((result) =>
      !result.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ),
    complete: engines.every((result) => result.executed),
    projectRoot: config.project.root,
    engines,
  };
}

async function checkPGlite(config: MinibaseConfig): Promise<EngineMigrationCheckResult> {
  const temporary = await Deno.makeTempDir({ prefix: "minibase-migration-check-pglite-" });
  const configuredTimeout = config.database.transactionTimeoutMs;
  const migrationTimeoutMs = configuredTimeout === 0 ? 0 : Math.max(configuredTimeout, 120_000);
  const engine = new PGliteEngine(join(temporary, "data"), {
    queryTimeoutMs: migrationTimeoutMs,
    transactionTimeoutMs: migrationTimeoutMs,
  });
  try {
    await engine.start();
    return await verifyMigrations(engine, config.project);
  } catch (error) {
    return failedEngine("pglite", error);
  } finally {
    await engine.close().catch(() => undefined);
    await Deno.remove(temporary, { recursive: true }).catch(() => undefined);
  }
}

async function checkPostgres(config: MinibaseConfig): Promise<EngineMigrationCheckResult> {
  let runtimePath: string | null;
  try {
    runtimePath = await resolvePostgresRuntimePath(config.database.runtimePath);
  } catch (error) {
    return failedEngine("postgres", error);
  }
  if (runtimePath === null) {
    return {
      engine: "postgres",
      compatible: null,
      executed: false,
      appliedMigrations: [],
      diagnostics: await scanMigrationCompatibility(
        config.project,
        offlineMigrationCapabilities("postgres"),
      ).then((items) => [
        ...items,
        {
          code: "migration.server.unavailable",
          severity: "warning" as const,
          message:
            "Server migrations were not executed because no managed PostgreSQL runtime is configured.",
          fix: "Set MINIBASE_POSTGRES_RUNTIME_DIR and rerun migration check for full verification.",
        },
      ]),
    };
  }

  const temporary = await Deno.makeTempDir({ prefix: "minibase-migration-check-postgres-" });
  let runtime: PostgresRuntime | null = null;
  let engine: PostgresEngine | null = null;
  try {
    ({ runtime, engine } = await startTemporaryPostgres(runtimePath, temporary));
    return await verifyMigrations(engine, config.project);
  } catch (error) {
    return failedEngine("postgres", error);
  } finally {
    await engine?.close().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    await Deno.remove(temporary, { recursive: true }).catch(() => undefined);
  }
}

async function startTemporaryPostgres(
  runtimeDir: string,
  temporary: string,
): Promise<{ runtime: PostgresRuntime; engine: PostgresEngine }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = availablePort();
    const runtime = new PostgresRuntime({
      runtimeDir,
      dataDir: join(temporary, "data"),
      port,
      logsDir: join(temporary, "logs"),
    });
    const engine = new PostgresEngine(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      max: 4,
    });
    try {
      await runtime.start();
      await engine.start();
      return { runtime, engine };
    } catch (error) {
      lastError = error;
      await engine.close().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
    }
  }
  throw new Error("Temporary PostgreSQL failed to start after 3 isolated attempts", {
    cause: lastError,
  });
}

async function verifyMigrations(
  engine: DatabaseEngine,
  project: ProjectPaths,
): Promise<EngineMigrationCheckResult> {
  const capabilities = await engine.capabilities();
  const diagnostics = await scanMigrationCompatibility(project, capabilities);
  const appliedMigrations: string[] = [];
  const preflightFailed = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (!preflightFailed) {
    try {
      appliedMigrations.push(
        ...(await engine.applyMigrations(project)).map((item) => item.version),
      );
    } catch (error) {
      diagnostics.push(executionDiagnostic(error));
    }
  }
  return {
    engine: engine.name,
    compatible: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    executed: !preflightFailed,
    postgresVersion: capabilities.postgresVersion,
    appliedMigrations,
    diagnostics,
  };
}

function failedEngine(
  engine: DatabaseEngineName,
  error: unknown,
): EngineMigrationCheckResult {
  return {
    engine,
    compatible: false,
    executed: false,
    appliedMigrations: [],
    diagnostics: [executionDiagnostic(error)],
  };
}

function executionDiagnostic(error: unknown): DiagnosticResult {
  if (error instanceof MigrationExecutionError) {
    return {
      code: error.databaseCode === undefined
        ? "migration.execution"
        : `migration.execution.${error.databaseCode}`,
      severity: "error",
      message: error.message,
      file: error.file,
      line: error.line,
      column: error.column,
    };
  }
  return {
    code: "migration.execution",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
