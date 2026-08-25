import type { MinibaseConfig } from "../config/types.ts";
import {
  authRateLimitClientIp,
  AuthRateLimiter,
  type AuthRateLimitExceeded,
  authRateLimitIdentity,
  type AuthRateLimitRoute,
} from "./rate_limit.ts";
import type { AuthService, UpdateUserInput } from "./service.ts";

function errorResponse(error: unknown, status = 400, errorCode = "auth_error"): Response {
  return Response.json(
    {
      code: status,
      error_code: errorCode,
      msg: error instanceof Error ? error.message : String(error),
    },
    { status },
  );
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.toLowerCase().startsWith("bearer ")) {
    throw new Error("Missing bearer token");
  }
  return authorization.slice(7).trim();
}

export function createAuthHandler(service: AuthService, config: MinibaseConfig["auth"]) {
  const rateLimiter = new AuthRateLimiter(config.rateLimit);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/auth/v1/")) {
      return null;
    }

    try {
      if (request.method === "POST" && url.pathname === "/auth/v1/signup") {
        const limited = checkIpLimit(rateLimiter, "signup", request);
        if (limited !== null) return limited;
        const input = await request.json() as {
          email?: string;
          password?: string;
          data?: Record<string, unknown>;
        };
        return Response.json(await service.signUp(input));
      }

      if (request.method === "POST" && url.pathname === "/auth/v1/token") {
        const grantType = url.searchParams.get("grant_type");
        if (grantType === "password" || grantType === "refresh_token") {
          const limited = checkIpLimit(
            rateLimiter,
            grantType === "password" ? "password" : "refresh",
            request,
          );
          if (limited !== null) return limited;
        }
        const input = await request.json() as {
          email?: string;
          password?: string;
          refresh_token?: string;
        };
        if (grantType === "password") {
          if (input.email === undefined || input.password === undefined) {
            throw new Error("Email and password are required");
          }
          return Response.json(await service.signInWithPassword(input.email, input.password));
        }
        if (grantType === "refresh_token") {
          if (input.refresh_token === undefined) {
            throw new Error("Refresh token is required");
          }
          return Response.json(await service.refresh(input.refresh_token));
        }
        throw new Error(`Unsupported grant type: ${grantType}`);
      }

      if (request.method === "GET" && url.pathname === "/auth/v1/user") {
        return Response.json(await service.getUser(bearerToken(request)));
      }

      if (request.method === "PUT" && url.pathname === "/auth/v1/user") {
        const limited = checkIpLimit(rateLimiter, "user_update", request);
        if (limited !== null) return limited;
        if (rateLimiter.requiresUpdateIdentity()) {
          const identityLimit = rateLimiter.checkIdentity(
            "user_update",
            authRateLimitIdentity(await service.resolveRequestContext(request)),
          );
          if (!identityLimit.allowed) return rateLimitResponse(identityLimit);
        }
        const user = await service.updateUser(
          bearerToken(request),
          await request.json() as UpdateUserInput,
        );
        return Response.json({ user });
      }

      if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
        await service.logout(bearerToken(request));
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/auth/v1/admin/users" && request.method === "GET") {
        return Response.json(
          await service.listUsers(
            bearerToken(request),
            Number(url.searchParams.get("page") ?? 1),
            Number(url.searchParams.get("per_page") ?? 50),
          ),
        );
      }

      const adminUserMatch = /^\/auth\/v1\/admin\/users\/([^/]+)$/u.exec(url.pathname);
      if (adminUserMatch !== null) {
        const userId = decodeURIComponent(adminUserMatch[1]!);
        if (request.method === "GET") {
          return Response.json({ user: await service.adminGetUser(bearerToken(request), userId) });
        }
        if (request.method === "PUT") {
          const user = await service.adminUpdateUser(
            bearerToken(request),
            userId,
            await request.json() as UpdateUserInput,
          );
          return Response.json({ user });
        }
        if (request.method === "DELETE") {
          return Response.json({
            user: await service.adminDeleteUser(bearerToken(request), userId),
          });
        }
      }

      return errorResponse(new Error(`No Auth route for ${request.method} ${url.pathname}`), 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Reauthentication required")) {
        return errorResponse(error, 403, "reauthentication_required");
      }
      if (message.startsWith("Password must")) {
        return errorResponse(error, 422, "weak_password");
      }
      const status = message.includes("Invalid login") || message.includes("JWT") ||
          message.includes("bearer") || message.includes("Session") ||
          message.includes("access token") || message.includes("Service Role")
        ? 401
        : 400;
      return errorResponse(error, status);
    }
  };
}

function checkIpLimit(
  limiter: AuthRateLimiter,
  route: AuthRateLimitRoute,
  request: Request,
): Response | null {
  const decision = limiter.checkIp(route, authRateLimitClientIp(request));
  return decision.allowed ? null : rateLimitResponse(decision);
}

function rateLimitResponse(limit: AuthRateLimitExceeded): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1_000));
  return Response.json(
    {
      code: 429,
      error_code: "auth_rate_limit_exceeded",
      msg: `Auth ${limit.route} ${limit.scope} rate limit exceeded`,
      route: limit.route,
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
