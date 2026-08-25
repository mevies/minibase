import type { MinibaseConfig } from "../config/types.ts";
import { createAuthHandler } from "../auth/handler.ts";
import type { AuthService } from "../auth/service.ts";
import type { DatabaseEngine } from "../database/contract.ts";
import type { RequestDatabaseContext } from "../database/contract.ts";
import { createRestHandler, type RequestContextResolver } from "../rest/handler.ts";
import { createFunctionsHandler } from "../functions/handler.ts";
import { createFunctionDocsHandler } from "../functions/docs.ts";
import type { FunctionManager } from "../functions/manager.ts";
import { migrationsReady } from "../migrations/runner.ts";
import { createStorageHandler } from "../storage/handler.ts";
import type { ObjectStore } from "../storage/contract.ts";
import { MINIBASE_VERSION } from "../version.ts";
import { RequestGuard } from "./request_guard.ts";

export interface AppDependencies {
  config: MinibaseConfig;
  engine: DatabaseEngine;
  startedAt?: Date;
  resolveRequestContext?: RequestContextResolver;
  authService?: AuthService;
  functionManager?: FunctionManager;
  objectStore?: ObjectStore;
  logRequest?: (event: HttpRequestLog) => void;
}

export interface HttpRequestLog {
  module: "auth" | "functions" | "rest" | "server" | "storage";
  requestId: string;
  durationMs: number;
  method: string;
  status: number;
}

interface ReadinessCheck {
  ready: boolean;
}

interface StorageReadinessCheck extends ReadinessCheck {
  driver: ObjectStore["driver"];
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_CORS_HEADERS = "authorization, apikey, content-type, x-client-info, x-request-id";

function allowedCorsOrigin(config: MinibaseConfig, request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const allowed = config.server.cors.allowedOrigins;
  return allowed.includes("*") || allowed.includes(origin) ? origin : null;
}

function appendVary(headers: Headers, value: string): void {
  const values = new Set(
    (headers.get("vary") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function applyCors(response: Response, request: Request, origin: string): void {
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-credentials", "true");
  response.headers.set("access-control-expose-headers", "content-range, x-request-id");
  appendVary(response.headers, "Origin");
  if (request.method === "OPTIONS") {
    response.headers.set("access-control-allow-methods", CORS_METHODS);
    response.headers.set(
      "access-control-allow-headers",
      request.headers.get("access-control-request-headers") ?? DEFAULT_CORS_HEADERS,
    );
    response.headers.set("access-control-max-age", "600");
    appendVary(response.headers, "Access-Control-Request-Method");
    appendVary(response.headers, "Access-Control-Request-Headers");
  }
}

export function createAppHandler(
  dependencies: AppDependencies,
): (request: Request) => Promise<Response> {
  const startedAt = dependencies.startedAt ?? new Date();
  const resolveRequestContext = dependencies.resolveRequestContext ??
    ((_request: Request): RequestDatabaseContext => ({ role: "anon", claims: { role: "anon" } }));
  const restHandler = createRestHandler({
    engine: dependencies.engine,
    resolveContext: resolveRequestContext,
  });
  const authHandler = dependencies.authService === undefined
    ? null
    : createAuthHandler(dependencies.authService, dependencies.config.auth);
  const functionsHandler = dependencies.authService === undefined ||
      dependencies.functionManager === undefined
    ? null
    : createFunctionsHandler(
      dependencies.functionManager,
      dependencies.authService,
      dependencies.config,
    );
  const functionDocsHandler = createFunctionDocsHandler(dependencies.config);
  const storageHandler = dependencies.authService === undefined ||
      dependencies.objectStore === undefined
    ? null
    : createStorageHandler(
      dependencies.engine,
      dependencies.authService,
      dependencies.objectStore,
    );
  const requestGuard = new RequestGuard(dependencies.config.server.request);

  const routeHandler = async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const url = new URL(request.url);
    let response: Response;
    const corsOrigin = allowedCorsOrigin(dependencies.config, request);
    const isCorsPreflight = request.method === "OPTIONS" &&
      request.headers.has("origin") && request.headers.has("access-control-request-method");

    if (isCorsPreflight) {
      response = corsOrigin === null
        ? jsonResponse({ code: "cors_origin_denied", message: "Origin is not allowed" }, 403)
        : new Response(null, { status: 204 });
      if (corsOrigin !== null) applyCors(response, request, corsOrigin);
      response.headers.set("x-request-id", requestId);
      return response;
    }

    const functionDocsResponse = await functionDocsHandler(request);
    const authResponse = functionDocsResponse === null
      ? await authHandler?.(request) ?? null
      : null;
    const functionResponse = functionDocsResponse === null && authResponse === null
      ? await functionsHandler?.(request) ?? null
      : null;
    const storageResponse = functionDocsResponse === null && authResponse === null &&
        functionResponse === null
      ? await storageHandler?.(request) ?? null
      : null;
    const restResponse = functionDocsResponse === null && authResponse === null &&
        functionResponse === null &&
        storageResponse === null
      ? await restHandler(request)
      : null;
    if (functionDocsResponse !== null) {
      response = functionDocsResponse;
    } else if (authResponse !== null) {
      response = authResponse;
    } else if (functionResponse !== null) {
      response = functionResponse;
    } else if (storageResponse !== null) {
      response = storageResponse;
    } else if (restResponse !== null) {
      response = restResponse;
    } else if (request.method === "GET" && url.pathname === "/health/live") {
      response = jsonResponse({
        status: "live",
        version: MINIBASE_VERSION,
        engine: dependencies.engine.name,
      });
    } else if (request.method === "GET" && url.pathname === "/health/ready") {
      const [databaseReady, migrationReady, storageReady, functionsReady] = await Promise.all([
        probeReadiness(() => dependencies.engine.health()),
        probeReadiness(() => migrationsReady(dependencies.engine, dependencies.config.project)),
        probeReadiness(() => dependencies.objectStore?.health() ?? Promise.resolve(false)),
        probeReadiness(() => dependencies.functionManager?.health() ?? Promise.resolve(false)),
      ]);
      const ready = databaseReady && migrationReady && storageReady && functionsReady;
      response = jsonResponse(
        {
          status: ready ? "ready" : "not_ready",
          version: MINIBASE_VERSION,
          engine: dependencies.engine.name,
          checks: {
            database: { ready: databaseReady } satisfies ReadinessCheck,
            migrations: { ready: migrationReady } satisfies ReadinessCheck,
            storage: {
              ready: storageReady,
              driver: dependencies.objectStore?.driver ?? dependencies.config.storage.driver,
            } satisfies StorageReadinessCheck,
            functions: { ready: functionsReady } satisfies ReadinessCheck,
          },
        },
        ready ? 200 : 503,
      );
    } else if (request.method === "GET" && url.pathname === "/_minibase/capabilities") {
      const capabilities = await dependencies.engine.capabilities();
      response = jsonResponse({
        ...capabilities,
        limitations: {
          externalConnections: capabilities.externalConnections ? null : {
            code: "database.external_connections.unavailable",
            message: "This engine does not accept direct external PostgreSQL connections.",
          },
          concurrentConnections: capabilities.concurrentConnections ? null : {
            code: "database.concurrent_connections.serialized",
            message: "This engine serializes database transactions through its local worker.",
          },
          logicalReplication: capabilities.logicalReplication === "configurable"
            ? {
              code: "database.logical_replication.requires_configuration",
              message: "Logical replication requires explicit runtime and topology configuration.",
            }
            : {
              code: "database.logical_replication.unavailable",
              message: "This engine does not support logical replication.",
            },
        },
      });
    } else if (request.method === "GET" && url.pathname === "/") {
      response = jsonResponse({
        name: "minibase",
        version: MINIBASE_VERSION,
        projectId: dependencies.config.projectId,
        engine: dependencies.engine.name,
        startedAt: startedAt.toISOString(),
        endpoints: {
          live: "/health/live",
          ready: "/health/ready",
          capabilities: "/_minibase/capabilities",
          rest: "/rest/v1",
          auth: "/auth/v1",
          storage: "/storage/v1",
          functions: "/functions/v1",
        },
      });
    } else {
      response = jsonResponse(
        {
          code: "not_found",
          message: `No route for ${request.method} ${url.pathname}`,
        },
        404,
      );
    }

    response.headers.set("x-request-id", requestId);
    if (corsOrigin !== null) applyCors(response, request, corsOrigin);
    return response;
  };

  return async (request: Request): Promise<Response> => {
    const requestStartedAt = performance.now();
    let requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    let status = 500;
    try {
      const response = await requestGuard.handle(request, routeHandler);
      if (!response.headers.has("x-request-id")) response.headers.set("x-request-id", requestId);
      requestId = response.headers.get("x-request-id") ?? requestId;
      status = response.status;
      const corsOrigin = allowedCorsOrigin(dependencies.config, request);
      if (corsOrigin !== null) applyCors(response, request, corsOrigin);
      return response;
    } finally {
      try {
        dependencies.logRequest?.({
          module: requestModule(new URL(request.url).pathname),
          requestId,
          durationMs: performance.now() - requestStartedAt,
          method: request.method,
          status,
        });
      } catch {
        // Logging is observational and must never replace an HTTP response.
      }
    }
  };
}

async function probeReadiness(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

function requestModule(pathname: string): HttpRequestLog["module"] {
  if (pathname.startsWith("/auth/v1/")) return "auth";
  if (pathname.startsWith("/functions/v1/")) return "functions";
  if (pathname.startsWith("/rest/v1/")) return "rest";
  if (pathname.startsWith("/storage/v1/")) return "storage";
  return "server";
}
