import type { AnonymousCleanupResult, AuditLogCleanupResult, AuthService } from "./service.ts";

export interface AnonymousCleanupSchedulerOptions {
  retentionMs: number;
  intervalMs: number;
  batchSize: number;
  onResult?: (result: AnonymousCleanupResult) => void;
  onError?: (error: unknown) => void;
}

type CleanupService = Pick<AuthService, "cleanupAnonymousUsers">;

export class AnonymousCleanupScheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;
  #started = false;
  #closed = false;

  constructor(
    private readonly service: CleanupService,
    private readonly options: AnonymousCleanupSchedulerOptions,
  ) {
    if (!Number.isFinite(options.retentionMs) || options.retentionMs <= 0) {
      throw new Error("Anonymous cleanup retention must be greater than zero");
    }
    if (
      !Number.isFinite(options.intervalMs) || options.intervalMs <= 0 ||
      options.intervalMs > 2_147_483_647
    ) {
      throw new Error("Anonymous cleanup interval must fit the runtime timer range");
    }
    if (
      !Number.isInteger(options.batchSize) || options.batchSize < 1 ||
      options.batchSize > 10_000
    ) {
      throw new Error("Anonymous cleanup batch size must be between 1 and 10000");
    }
  }

  start(): void {
    if (this.#closed) throw new Error("Anonymous cleanup scheduler is closed");
    if (this.#started) return;
    this.#started = true;
    this.runOnce();
    this.#timer = setInterval(() => this.runOnce(), this.options.intervalMs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#pending;
  }

  private runOnce(): void {
    if (this.#closed || this.#pending !== null) return;
    const pending = this.service.cleanupAnonymousUsers(
      this.options.retentionMs,
      this.options.batchSize,
    ).then((result) => this.options.onResult?.(result))
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        if (this.#pending === pending) this.#pending = null;
      });
    this.#pending = pending;
  }
}

export interface AuditLogCleanupSchedulerOptions {
  retentionMs: number;
  intervalMs: number;
  batchSize: number;
  onResult?: (result: AuditLogCleanupResult) => void;
  onError?: (error: unknown) => void;
}

type AuditCleanupService = Pick<AuthService, "cleanupAuditLog">;

export class AuditLogCleanupScheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;
  #started = false;
  #closed = false;

  constructor(
    private readonly service: AuditCleanupService,
    private readonly options: AuditLogCleanupSchedulerOptions,
  ) {
    if (!Number.isFinite(options.retentionMs) || options.retentionMs <= 0) {
      throw new Error("Auth audit log retention must be greater than zero");
    }
    if (
      !Number.isFinite(options.intervalMs) || options.intervalMs <= 0 ||
      options.intervalMs > 2_147_483_647
    ) {
      throw new Error("Auth audit log cleanup interval must fit the runtime timer range");
    }
    if (
      !Number.isInteger(options.batchSize) || options.batchSize < 1 ||
      options.batchSize > 10_000
    ) {
      throw new Error("Auth audit log cleanup batch size must be between 1 and 10000");
    }
  }

  start(): void {
    if (this.#closed) throw new Error("Auth audit log cleanup scheduler is closed");
    if (this.#started) return;
    this.#started = true;
    this.runOnce();
    this.#timer = setInterval(() => this.runOnce(), this.options.intervalMs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#pending;
  }

  private runOnce(): void {
    if (this.#closed || this.#pending !== null) return;
    const pending = this.service.cleanupAuditLog(
      this.options.retentionMs,
      this.options.batchSize,
    ).then((result) => this.options.onResult?.(result))
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        if (this.#pending === pending) this.#pending = null;
      });
    this.#pending = pending;
  }
}
