import type { AuthService } from "../auth/service.ts";
import type { MinibaseConfig } from "../config/types.ts";
import type { RequestDatabaseContext } from "../database/contract.ts";
import type { FunctionManager } from "./manager.ts";
import {
  functionRateLimitClientIp,
  FunctionRateLimiter,
  type FunctionRateLimitExceeded,
  functionRateLimitIdentity,
} from "./rate_limit.ts";

function functionName(pathname: string): string | null {
  const prefix = "/functions/v1/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const [name] = pathname.slice(prefix.length).split("/");
  return name === undefined || name.length === 0 ? null : name;
}

export function createFunctionsHandler(
  manager: FunctionManager,
  auth: AuthService,
  config: MinibaseConfig,
) {
  const rateLimiter = new FunctionRateLimiter(config.functions);
  return async (request: Request): Promise<Response | null> => {
    const name = functionName(new URL(request.url).pathname);
    if (name === null) {
      return null;
    }
    const ingressLimit = rateLimiter.checkIngress(name, functionRateLimitClientIp(request));
    if (!ingressLimit.allowed) return rateLimitResponse(ingressLimit);

    const verifyJwt = config.functions.definitions[name]?.verifyJwt ?? true;
    let requestContext: RequestDatabaseContext = { role: "anon", claims: { role: "anon" } };
    if (verifyJwt) {
      const authorization = request.headers.get("authorization");
      if (authorization === null) {
        return Response.json({ code: 401, message: "Missing authorization header" }, {
          status: 401,
        });
      }
      try {
        requestContext = await auth.resolveRequestContext(request);
      } catch (error) {
        return Response.json(
          { code: 401, message: error instanceof Error ? error.message : String(error) },
          { status: 401 },
        );
      }
    } else if (rateLimiter.requiresIdentity(name) && request.headers.has("authorization")) {
      try {
        requestContext = await auth.resolveRequestContext(request);
      } catch {
        requestContext = { role: "anon", claims: { role: "anon" } };
      }
    }
    if (rateLimiter.requiresIdentity(name)) {
      const identityLimit = rateLimiter.checkIdentity(
        name,
        functionRateLimitIdentity(requestContext),
      );
      if (!identityLimit.allowed) return rateLimitResponse(identityLimit);
    }
    try {
      return await manager.invoke(
        name,
        request,
        requestContext.role === "service_role" ? "secret" : "publishable",
      );
    } catch (error) {
      return Response.json(
        {
          code: "function_runtime_error",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  };
}

function rateLimitResponse(limit: FunctionRateLimitExceeded): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1_000));
  return Response.json(
    {
      code: "function_rate_limit_exceeded",
      message: `Function ${limit.scope} rate limit exceeded`,
      scope: limit.scope,
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfterSeconds),
        "x-ratelimit-limit": String(limit.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil(limit.resetAt / 1_000)),
      },
    },
  );
}
