import { join } from "@std/path";
import type { LogFormat } from "../config/types.ts";

const LOG_FILE_NAME = "minibase.jsonl";

export type LogLevel = "info" | "warning" | "error";

export interface LogRecord extends Record<string, unknown> {
  timestamp: string;
  level: LogLevel;
  module: string;
  event: string;
  requestId?: string;
  durationMs?: number;
}

export interface RuntimeLoggerOptions {
  format: LogFormat;
  maxBytes: number;
  retentionFiles: number;
  secrets?: string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  onError?: (error: unknown) => void;
}

export class RuntimeLogger {
  readonly #path: string;
  readonly #stdout: (line: string) => void;
  readonly #stderr: (line: string) => void;
  readonly #secrets = new Set<string>();
  #pending: Promise<void> = Promise.resolve();
  #prepared: Promise<void> | null = null;

  constructor(
    private readonly logsDir: string,
    private readonly options: RuntimeLoggerOptions,
  ) {
    this.#path = join(logsDir, LOG_FILE_NAME);
    this.#stdout = options.stdout ?? ((line) => console.log(line));
    this.#stderr = options.stderr ?? ((line) => console.error(line));
    this.addSecrets(options.secrets ?? []);
  }

  get path(): string {
    return this.#path;
  }

  addSecrets(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length > 0) this.#secrets.add(value);
    }
  }

  async prepare(): Promise<void> {
    if (this.#prepared === null) {
      this.#prepared = this.prepareStore().catch((error) => {
        this.#prepared = null;
        throw error;
      });
    }
    await this.#prepared;
  }

  info(module: string, event: string, fields: Record<string, unknown> = {}): void {
    this.write({ ...fields, level: "info", module, event });
  }

  warning(module: string, event: string, fields: Record<string, unknown> = {}): void {
    this.write({ ...fields, level: "warning", module, event });
  }

  error(module: string, event: string, fields: Record<string, unknown> = {}): void {
    this.write({ ...fields, level: "error", module, event });
  }

  write(input: Partial<LogRecord> & Pick<LogRecord, "level" | "module" | "event">): void {
    const record = sanitizeRecord({
      ...input,
      timestamp: typeof input.timestamp === "string" ? input.timestamp : new Date().toISOString(),
      level: input.level,
      module: input.module,
      event: input.event,
    }, this.#secrets);
    if (typeof record.durationMs === "number") {
      record.durationMs = Number(record.durationMs.toFixed(2));
    }
    const json = JSON.stringify(record);
    this.#pending = this.#pending.then(async () => await this.writeLine(json)).catch((error) => {
      this.options.onError?.(error);
    });
    const output = this.options.format === "json" ? json : humanLine(record);
    if (record.level === "error" || record.level === "warning") this.#stderr(output);
    else this.#stdout(output);
  }

  async close(): Promise<void> {
    await this.#pending;
  }

  private async prepareStore(): Promise<void> {
    await Deno.mkdir(this.logsDir, { recursive: true });
    for (let index = this.options.retentionFiles + 1; index <= 100; index++) {
      await Deno.remove(`${this.#path}.${index}`).catch(ignoreNotFound);
    }
  }

  private async writeLine(line: string): Promise<void> {
    await this.prepare();
    let output = `${line}\n`;
    let encoded = new TextEncoder().encode(output);
    if (encoded.byteLength > this.options.maxBytes) {
      output = JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          level: "warning",
          module: "logging",
          event: "runtime_log_line_truncated",
          originalBytes: encoded.byteLength,
        } satisfies LogRecord,
      ) + "\n";
      encoded = new TextEncoder().encode(output);
    }
    const currentBytes = await fileSize(this.#path);
    if (currentBytes > 0 && currentBytes + encoded.byteLength > this.options.maxBytes) {
      await this.rotate();
    }
    await Deno.writeTextFile(this.#path, output, { append: true, create: true });
  }

  private async rotate(): Promise<void> {
    if (this.options.retentionFiles === 0) {
      await Deno.remove(this.#path).catch(ignoreNotFound);
      return;
    }
    await Deno.remove(`${this.#path}.${this.options.retentionFiles}`).catch(ignoreNotFound);
    for (let index = this.options.retentionFiles - 1; index >= 1; index--) {
      await renameIfPresent(`${this.#path}.${index}`, `${this.#path}.${index + 1}`);
    }
    await renameIfPresent(this.#path, `${this.#path}.1`);
  }
}

function sanitizeRecord(record: LogRecord, secrets: Set<string>): LogRecord {
  return sanitizeValue(record, secrets) as LogRecord;
}

function sanitizeValue(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, secrets)]),
  );
}

function redact(value: string, secrets: Set<string>): string {
  let output = value;
  for (const secret of secrets) {
    const encoded = JSON.stringify(secret).slice(1, -1);
    for (const candidate of new Set([secret, encoded, encodeURIComponent(secret)])) {
      if (candidate.length > 0) output = output.replaceAll(candidate, "[REDACTED]");
    }
  }
  return output;
}

function humanLine(record: LogRecord): string {
  const fields = Object.entries(record)
    .filter(([key]) => !["timestamp", "level", "module", "event"].includes(key))
    .map(([key, value]) => `${key}=${humanValue(value)}`)
    .join(" ");
  return `${record.timestamp} ${record.level.toUpperCase()} [${record.module}] ${record.event}` +
    (fields.length === 0 ? "" : ` ${fields}`);
}

function humanValue(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9._:/-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  try {
    await Deno.rename(source, destination);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
