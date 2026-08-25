import type { AuthRateLimitConfig } from "../config/types.ts";
import type { RequestDatabaseContext } from "../database/contract.ts";

export type AuthRateLimitRoute = "signup" | "password" | "refresh" | "user_update";
export type AuthRateLimitScope = "ip" | "identity";

export interface AuthRateLimitExceeded {
  allowed: false;
  route: AuthRateLimitRoute;
  scope: AuthRateLimitScope;
  limit: number;
  retryAfterMs: number;
  resetAt: number;
}

export interface AuthRateLimitAllowed {
  allowed: true;
}

export type AuthRateLimitDecision = AuthRateLimitAllowed | AuthRateLimitExceeded;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

type Clock = () => number;

export class AuthRateLimiter {
  readonly #buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly config: AuthRateLimitConfig,
    private readonly now: Clock = Date.now,
  ) {}

  checkIp(route: AuthRateLimitRoute, clientIp: string): AuthRateLimitDecision {
    return this.check(route, "ip", clientIp, this.ipLimit(route));
  }

  checkIdentity(route: "user_update", identity: string): AuthRateLimitDecision {
    return this.check(route, "identity", identity, this.config.updatePerIdentity);
  }

  requiresUpdateIdentity(): boolean {
    return this.config.updatePerIdentity > 0;
  }

  bucketCountForTest(): number {
    return this.#buckets.size;
  }

  private ipLimit(route: AuthRateLimitRoute): number {
    switch (route) {
      case "signup":
        return this.config.signupPerIp;
      case "password":
        return this.config.passwordPerIp;
      case "refresh":
        return this.config.refreshPerIp;
      case "user_update":
        return this.config.updatePerIp;
    }
  }

  private check(
    route: AuthRateLimitRoute,
    scope: AuthRateLimitScope,
    discriminator: string,
    limit: number,
  ): AuthRateLimitDecision {
    if (limit === 0) return { allowed: true };
    const now = this.now();
    const key = JSON.stringify([route, scope, discriminator]);
    let bucket = this.#buckets.get(key);
    if (bucket !== undefined && bucket.resetAt <= now) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (bucket !== undefined && bucket.count >= limit) {
      this.touch(key, bucket);
      return {
        allowed: false,
        route,
        scope,
        limit,
        retryAfterMs: Math.max(1, bucket.resetAt - now),
        resetAt: bucket.resetAt,
      };
    }

    if (bucket === undefined) {
      this.ensureCapacity(key, now);
      bucket = { count: 0, resetAt: now + this.config.windowMs };
    }
    bucket.count++;
    this.touch(key, bucket);
    return { allowed: true };
  }

  private ensureCapacity(protectedKey: string, now: number): void {
    if (this.#buckets.size < this.config.maxKeys) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && key !== protectedKey) this.#buckets.delete(key);
    }
    while (this.#buckets.size >= this.config.maxKeys) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#buckets.delete(oldest);
    }
  }

  private touch(key: string, bucket: RateLimitBucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
  }
}

export function authRateLimitClientIp(request: Request): string {
  const value = request.headers.get("x-forwarded-for")?.trim();
  if (
    value === undefined || value.length === 0 || value.length > 64 || value.includes(",") ||
    !/^[0-9a-f:.]+$/iu.test(value)
  ) {
    return "unknown";
  }
  return value.toLowerCase();
}

export function authRateLimitIdentity(context: RequestDatabaseContext): string {
  const subject = context.claims.sub;
  if (context.role !== "authenticated" || typeof subject !== "string" || subject.length === 0) {
    throw new Error("A user access token is required");
  }
  return `authenticated:subject:${subject}`;
}
