import type { MinibaseConfig } from "../config/types.ts";
import type { DatabaseEngine } from "./contract.ts";
import { PGliteEngine, type PGliteLongTransactionEvent } from "./pglite.ts";
import { PostgresEngine } from "./postgres.ts";
import { PostgresRuntime, type PostgresRuntimeMetrics } from "./postgres_runtime.ts";
import { resolvePostgresRuntimePath } from "./postgres_bundled.ts";

export interface StartedDatabase {
  engine: DatabaseEngine;
  mode: "embedded" | "managed" | "external";
  runtimeMetrics?: PostgresRuntimeMetrics;
  close(): Promise<void>;
}

export interface StartDatabaseOptions {
  onLongTransaction?: (event: PGliteLongTransactionEvent) => void;
}

export async function startConfiguredDatabase(
  config: MinibaseConfig,
  options: StartDatabaseOptions = {},
): Promise<StartedDatabase> {
  if (config.database.engine === "pglite") {
    const engine = new PGliteEngine(config.project.pgliteDataDir, {
      transactionTimeoutMs: config.database.transactionTimeoutMs,
      longTransactionWarningMs: config.database.longTransactionWarningMs,
      onLongTransaction: options.onLongTransaction,
    });
    await engine.start();
    return {
      engine,
      mode: "embedded",
      close: () => engine.close(),
    };
  }

  let runtime: PostgresRuntime | null = null;
  let runtimeMetrics: PostgresRuntimeMetrics | undefined;
  let connectionUrl = config.database.url;
  if (config.database.managed) {
    const runtimePath = await resolvePostgresRuntimePath(config.database.runtimePath);
    if (runtimePath === null) {
      throw new Error(
        "Managed PostgreSQL requires the Minibase Server edition, " +
          "MINIBASE_POSTGRES_RUNTIME_DIR or database.runtime_path",
      );
    }
    runtime = new PostgresRuntime({
      runtimeDir: runtimePath,
      dataDir: config.project.postgresDataDir,
      port: config.database.port,
      logsDir: config.project.logsDir,
    });
    runtimeMetrics = await runtime.start();
    connectionUrl = `postgres://postgres@127.0.0.1:${config.database.port}/postgres`;
  } else if (connectionUrl === undefined) {
    throw new Error("External PostgreSQL mode requires MINIBASE_DATABASE_URL or database.url");
  }

  const engine = new PostgresEngine(connectionUrl!, {
    min: config.database.poolMin,
    max: config.database.poolMax,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  try {
    await engine.start();
    await engine.acquireInstanceOwnership();
  } catch (error) {
    await engine.close().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    throw error;
  }
  return {
    engine,
    mode: runtime === null ? "external" : "managed",
    runtimeMetrics,
    close: async () => {
      await engine.close();
      await runtime?.stop();
    },
  };
}
