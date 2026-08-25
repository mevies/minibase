import type {
  FunctionRateLimitConfig,
  FunctionRateLimitOverride,
  MinibaseConfig,
} from "../config/types.ts";
import type { RequestDatabaseContext } from "../database/contract.ts";

export type FunctionRateLimitScope = "function" | "ip" | "identity";

export interface FunctionRateLimitExceeded {
  allowed: false;
  scope: FunctionRateLimitScope;
  limit: number;
  retryAfterMs: number;
  resetAt: number;
}

export interface FunctionRateLimitAllowed {
  allowed: true;
}

export type FunctionRateLimitDecision = FunctionRateLimitAllowed | FunctionRateLimitExceeded;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitConstraint {
  key: string;
  limit: number;
  scope: FunctionRateLimitScope;
}

interface ResolvedRateLimitPolicy {
  windowMs: number;
  perIp: number;
  perFunction: number;
  perIdentity: number;
}

type Clock = () => number;

export class FunctionRateLimiter {
  readonly #buckets = new Map<string, RateLimitBucket>();
  readonly #global: FunctionRateLimitConfig;
  readonly #definitions: MinibaseConfig["functions"]["definitions"];
  readonly #now: Clock;

  constructor(
    config: Pick<MinibaseConfig["functions"], "rateLimit" | "definitions">,
    now: Clock = Date.now,
  ) {
    this.#global = config.rateLimit;
    this.#definitions = config.definitions;
    this.#now = now;
  }

  requiresIdentity(functionName: string): boolean {
    return this.policy(functionName).perIdentity > 0;
  }

  checkIngress(functionName: string, clientIp: string): FunctionRateLimitDecision {
    const policy = this.policy(functionName);
    return this.check(policy, [
      {
        key: bucketKey("function", functionName, "all"),
        limit: policy.perFunction,
        scope: "function",
      },
      {
        key: bucketKey("ip", functionName, clientIp),
        limit: policy.perIp,
        scope: "ip",
      },
    ]);
  }

  checkIdentity(functionName: string, identity: string): FunctionRateLimitDecision {
    const policy = this.policy(functionName);
    return this.check(policy, [{
      key: bucketKey("identity", functionName, identity),
      limit: policy.perIdentity,
      scope: "identity",
    }]);
  }

  bucketCountForTest(): number {
    return this.#buckets.size;
  }

  private policy(functionName: string): ResolvedRateLimitPolicy {
    const override = this.#definitions[functionName]?.rateLimit;
    return resolvePolicy(this.#global, override);
  }

  private check(
    policy: ResolvedRateLimitPolicy,
    candidates: RateLimitConstraint[],
  ): FunctionRateLimitDecision {
    const constraints = candidates.filter((constraint) => constraint.limit > 0);
    if (constraints.length === 0) return { allowed: true };

    const now = this.#now();
    const active = constraints.map((constraint) => {
      const existing = this.#buckets.get(constraint.key);
      if (existing !== undefined && existing.resetAt <= now) {
        this.#buckets.delete(constraint.key);
        return { constraint, bucket: undefined };
      }
      return { constraint, bucket: existing };
    });
    for (const item of active) {
      if (item.bucket !== undefined && item.bucket.count >= item.constraint.limit) {
        this.touch(item.constraint.key, item.bucket);
        return {
          allowed: false,
          scope: item.constraint.scope,
          limit: item.constraint.limit,
          retryAfterMs: Math.max(1, item.bucket.resetAt - now),
          resetAt: item.bucket.resetAt,
        };
      }
    }

    const newBucketCount = active.filter((item) => item.bucket === undefined).length;
    this.ensureCapacity(newBucketCount, new Set(active.map((item) => item.constraint.key)), now);
    for (const item of active) {
      const bucket = item.bucket ?? { count: 0, resetAt: now + policy.windowMs };
      bucket.count++;
      this.touch(item.constraint.key, bucket);
    }
    return { allowed: true };
  }

  private ensureCapacity(additional: number, protectedKeys: Set<string>, now: number): void {
    if (this.#buckets.size + additional <= this.#global.maxKeys) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && !protectedKeys.has(key)) this.#buckets.delete(key);
    }
    while (this.#buckets.size + additional > this.#global.maxKeys) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      if (protectedKeys.has(oldest)) {
        const bucket = this.#buckets.get(oldest)!;
        this.touch(oldest, bucket);
        continue;
      }
      this.#buckets.delete(oldest);
    }
  }

  private touch(key: string, bucket: RateLimitBucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
  }
}

export function functionRateLimitIdentity(context: RequestDatabaseContext): string {
  const subject = context.claims.sub;
  if (typeof subject === "string" && subject.length > 0 && subject.length <= 256) {
    return `${context.role}:subject:${subject}`;
  }
  return `role:${context.role}`;
}

export function functionRateLimitClientIp(request: Request): string {
  const value = request.headers.get("x-forwarded-for")?.trim();
  if (
    value === undefined || value.length === 0 || value.length > 64 || value.includes(",") ||
    !/^[0-9a-f:.]+$/iu.test(value)
  ) {
    return "unknown";
  }
  return value.toLowerCase();
}

function resolvePolicy(
  global: FunctionRateLimitConfig,
  override: FunctionRateLimitOverride | undefined,
): ResolvedRateLimitPolicy {
  return {
    windowMs: override?.windowMs ?? global.windowMs,
    perIp: override?.perIp ?? global.perIp,
    perFunction: override?.perFunction ?? global.perFunction,
    perIdentity: override?.perIdentity ?? global.perIdentity,
  };
}

function bucketKey(
  scope: FunctionRateLimitScope,
  functionName: string,
  discriminator: string,
): string {
  return JSON.stringify([scope, functionName, discriminator]);
}
