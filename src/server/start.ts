import type { MinibaseConfig } from "../config/types.ts";
import { AnonymousCleanupScheduler, AuditLogCleanupScheduler } from "../auth/cleanup.ts";
import { AuthService } from "../auth/service.ts";
import {
  authSecretValues,
  loadOrCreateAuthSecrets,
  normalizeAuthSecrets,
  publicAuthJwks,
} from "../auth/secrets.ts";
import { startConfiguredDatabase } from "../database/factory.ts";
import { applySeed } from "../migrations/runner.ts";
import { prepareProject } from "../project/state.ts";
import { removeRuntimeState, writeRuntimeState } from "../project/runtime.ts";
import { FunctionManager } from "../functions/manager.ts";
import { loadFunctionEnvironment } from "../functions/environment.ts";
import { FunctionLogStore } from "../functions/log_store.ts";
import { type LogLevel, RuntimeLogger } from "../logging/logger.ts";
import type { ObjectStore } from "../storage/contract.ts";
import { LocalObjectStore } from "../storage/local.ts";
import { S3ObjectStore } from "../storage/s3.ts";
import { createAppHandler } from "./app.ts";
import {
  createTrustedProxyMatcher,
  normalizeProxyRequest,
  ProxyHeaderError,
} from "./trusted_proxy.ts";

export interface StartResult {
  url: string;
  engine: string;
  storage: string;
  logsDir: string;
  databaseMode: "embedded" | "managed" | "external";
  databaseRuntime?: {
    initialized: boolean;
    initializeMs: number;
    startMs: number;
    version: string;
  };
  appliedMigrations: string[];
  seedApplied: boolean;
  configuration: MinibaseConfig["metadata"];
}

export async function startServer(config: MinibaseConfig): Promise<StartResult> {
  await prepareProject(config.project, config.database.engine);
  const logger = new RuntimeLogger(config.project.logsDir, {
    ...config.logging,
    secrets: configuredSecretValues(config),
    onError: (error) => {
      console.error(`Minibase runtime log write failed: ${safeErrorMessage(error)}`);
    },
  });
  await logger.prepare();
  let database: Awaited<ReturnType<typeof startConfiguredDatabase>>;
  let objectStore: ObjectStore | null = null;
  try {
    database = await startConfiguredDatabase(config, {
      onLongTransaction: (event) => logger.warning("database", event.event, { ...event }),
    });
  } catch (error) {
    logger.error("server", "server_start_failed", { message: safeErrorMessage(error) });
    await logger.close();
    throw error;
  }
  const engine = database.engine;

  try {
    const migrations = await engine.applyMigrations(config.project);
    objectStore = config.storage.driver === "s3"
      ? new S3ObjectStore(config.storage.s3!, { ownershipRequired: true })
      : new LocalObjectStore(config.storage.path);
    await objectStore.acquireOwnership?.(config.projectId);
    const storageRecovery = await objectStore.recoverPendingWrites?.(async (write) => {
      const result = await engine.query<{ committed: boolean }>(
        `select exists(
           select 1 from storage.objects
           where bucket_id = $1 and name = $2 and version = $3
         ) as committed`,
        [write.bucket, write.name, write.writeId],
      );
      return result.rows[0]?.committed === true;
    });
    if (
      storageRecovery !== undefined &&
      (storageRecovery.rolledBack > 0 || storageRecovery.finalized > 0)
    ) {
      logger.info("storage", "storage_recovery", { ...storageRecovery });
    }
    const seedApplied = config.seed.enabled ? await applySeed(engine, config.project) : false;
    const authSecrets = config.auth.jwtSecret === undefined
      ? await loadOrCreateAuthSecrets(config.project.secretsFile)
      : normalizeAuthSecrets({ jwtSecret: config.auth.jwtSecret });
    logger.addSecrets(authSecretValues(authSecrets));
    const authService = new AuthService(
      engine,
      authSecrets,
      config.auth,
    );
    const functionEnvironment = await loadFunctionEnvironment(config.project);
    logger.addSecrets(functionEnvironment.secretValues);
    if (functionEnvironment.ignoredReserved.length > 0) {
      logger.warning("functions", "function_environment_reserved_ignored", {
        names: functionEnvironment.ignoredReserved,
      });
    }
    const functionLogStore = new FunctionLogStore(config.project.logsDir, {
      ...config.functions.logs,
      onError: (error) => {
        logger.error("functions", "function_log_write_error", {
          message: safeErrorMessage(error),
        });
      },
    });
    await functionLogStore.prepare();
    const anonymousCleanup = config.auth.anonymousCleanup.enabled
      ? new AnonymousCleanupScheduler(authService, {
        retentionMs: config.auth.anonymousCleanup.retentionHours * 60 * 60 * 1_000,
        intervalMs: config.auth.anonymousCleanup.intervalMinutes * 60 * 1_000,
        batchSize: config.auth.anonymousCleanup.batchSize,
        onResult: (result) => {
          if (result.deleted > 0) {
            logger.info("auth", "auth_anonymous_cleanup", { ...result });
          }
        },
        onError: (error) => {
          logger.error("auth", "auth_anonymous_cleanup_error", {
            message: safeErrorMessage(error),
          });
        },
      })
      : null;
    const auditLogCleanup = config.auth.auditLog.cleanupEnabled
      ? new AuditLogCleanupScheduler(authService, {
        retentionMs: config.auth.auditLog.retentionDays * 24 * 60 * 60 * 1_000,
        intervalMs: config.auth.auditLog.intervalMinutes * 60 * 1_000,
        batchSize: config.auth.auditLog.batchSize,
        onResult: (result) => {
          if (result.deleted > 0) {
            logger.info("auth", "auth_audit_log_cleanup", { ...result });
          }
        },
        onError: (error) => {
          logger.error("auth", "auth_audit_log_cleanup_error", {
            message: safeErrorMessage(error),
          });
        },
      })
      : null;
    const publicJwks = publicAuthJwks(authSecrets);
    const functionSecrets = {
      anonKey: await authService.createRoleToken("anon"),
      serviceRoleKey: await authService.createRoleToken("service_role"),
      ...(publicJwks.keys.length === 0 ? {} : { jwks: JSON.stringify(publicJwks) }),
    };
    logger.addSecrets([functionSecrets.anonKey, functionSecrets.serviceRoleKey]);
    const functionManager = new FunctionManager({
      config,
      secrets: functionSecrets,
      environment: functionEnvironment.values,
      secretValues: functionEnvironment.secretValues,
      log: (stream, line) => {
        functionLogStore.append(line);
        logFunctionLine(logger, stream, line);
      },
      onStartupMetric: (metric) => {
        logger.info("functions", "function_startup_metric", { ...metric });
      },
    });
    await functionManager.prepare();
    const appHandler = createAppHandler({
      config,
      engine,
      authService,
      functionManager,
      objectStore,
      resolveRequestContext: (request) => authService.resolveRequestContext(request),
      logRequest: (event) => {
        logger.info(event.module, "http_request", {
          requestId: event.requestId,
          durationMs: event.durationMs,
          method: event.method,
          status: event.status,
        });
      },
    });
    const abortController = new AbortController();
    const trustedProxies = createTrustedProxyMatcher(config.server.trustedProxies);
    let server: Deno.HttpServer<Deno.NetAddr> | null = null;
    let shutdownRequested = false;
    const controlToken = crypto.randomUUID();
    const controlHost = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
    const controlUrl = `${
      config.server.tls === undefined ? "http" : "https"
    }://${controlHost}:${config.server.port}`;
    const handler: Deno.ServeHandler<Deno.NetAddr> = async (request, info): Promise<Response> => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/_minibase/shutdown") {
        if (request.headers.get("x-minibase-control-token") !== controlToken) {
          return Response.json({ code: "forbidden", message: "Invalid control token" }, {
            status: 403,
          });
        }
        if (!shutdownRequested) {
          shutdownRequested = true;
          void info.completed.finally(async () => {
            try {
              await server?.shutdown();
            } catch {
              abortController.abort();
            }
          }).catch(() => undefined);
        }
        return Response.json({ status: "stopping" }, { status: 202 });
      }
      try {
        const requestSignal = Deno.build.standalone
          ? completedRequestSignal(info.completed)
          : request.signal;
        return await appHandler(
          normalizeProxyRequest(
            request,
            info.remoteAddr.hostname,
            trustedProxies,
            requestSignal,
          ),
        );
      } catch (error) {
        if (error instanceof ProxyHeaderError) {
          return Response.json({ code: "invalid_proxy_headers", message: error.message }, {
            status: 400,
          });
        }
        throw error;
      }
    };
    if (!isLoopbackHost(config.server.host)) {
      logger.warning("server", "public_listen_warning", {
        host: config.server.host,
        message: "Minibase API is listening beyond loopback; configure HTTPS and CORS explicitly.",
      });
    }
    server = Deno.serve(
      {
        hostname: config.server.host,
        port: config.server.port,
        ...(config.server.tls === undefined ? {} : {
          cert: await Deno.readTextFile(config.server.tls.certFile),
          key: await Deno.readTextFile(config.server.tls.keyFile),
        }),
        signal: abortController.signal,
        onListen: () => {},
      },
      handler,
    );

    await writeRuntimeState(config.project, {
      formatVersion: 1,
      pid: Deno.pid,
      startedAt: new Date().toISOString(),
      apiUrl: config.server.publicUrl,
      controlUrl,
      controlToken,
      engine: config.database.engine,
      storage: config.storage.driver,
      logsDir: config.project.logsDir,
      databaseMode: database.mode,
      databaseRuntime: database.runtimeMetrics,
    });
    anonymousCleanup?.start();
    auditLogCleanup?.start();

    const result: StartResult = {
      url: config.server.publicUrl,
      engine: engine.name,
      storage: config.storage.driver,
      logsDir: config.project.logsDir,
      databaseMode: database.mode,
      databaseRuntime: database.runtimeMetrics,
      appliedMigrations: migrations.map((migration) => migration.version),
      seedApplied,
      configuration: config.metadata,
    };
    logger.info("server", "server_started", { ...result });

    let signalHandler: (() => void) | null = null;
    try {
      signalHandler = () => abortController.abort();
      Deno.addSignalListener("SIGINT", signalHandler);
    } catch {
      signalHandler = null;
    }

    try {
      await server.finished;
    } finally {
      await anonymousCleanup?.close();
      await auditLogCleanup?.close();
      await functionManager.close();
      await functionLogStore.close();
      await removeRuntimeState(config.project, Deno.pid);
      if (signalHandler !== null) {
        Deno.removeSignalListener("SIGINT", signalHandler);
      }
    }
    return result;
  } catch (error) {
    logger.error("server", "server_failed", { message: safeErrorMessage(error) });
    throw error;
  } finally {
    try {
      await objectStore?.releaseOwnership?.();
    } finally {
      try {
        await database.close();
      } finally {
        logger.info("server", "server_stopped", { engine: config.database.engine });
        await logger.close();
      }
    }
  }
}

function completedRequestSignal(completed: Promise<void>): AbortSignal {
  const controller = new AbortController();
  void completed.finally(() => controller.abort()).catch(() => undefined);
  return controller.signal;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function configuredSecretValues(config: MinibaseConfig): string[] {
  const values = [
    config.database.url,
    config.auth.jwtSecret,
    config.storage.s3?.accessKeyId,
    config.storage.s3?.secretAccessKey,
    config.storage.s3?.sessionToken,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  if (config.database.url !== undefined) {
    try {
      const parsed = new URL(config.database.url);
      if (parsed.password.length > 0) values.push(parsed.password);
    } catch {
      // Configuration validation reports malformed URLs before the server starts.
    }
  }
  return values;
}

function logFunctionLine(
  logger: RuntimeLogger,
  stream: "stdout" | "stderr",
  line: string,
): void {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = { line };
  }
  const level: LogLevel = parsed.level === "error" || stream === "stderr" ? "error" : "info";
  logger.write({
    ...parsed,
    level,
    module: "functions",
    event: typeof parsed.event === "string" ? parsed.event : "function_output",
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
