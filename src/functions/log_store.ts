import { join } from "@std/path";

const LOG_FILE_NAME = "functions.jsonl";

export interface FunctionLogStoreOptions {
  maxBytes: number;
  retentionFiles: number;
  onError?: (error: unknown) => void;
}

export interface FunctionLogQuery {
  functionName?: string;
  tail?: number;
}

export interface FunctionLogQueryResult {
  path: string;
  entries: Record<string, unknown>[];
}

export class FunctionLogStore {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();
  #prepared: Promise<void> | null = null;

  constructor(
    private readonly logsDir: string,
    private readonly options: FunctionLogStoreOptions,
  ) {
    this.#path = join(logsDir, LOG_FILE_NAME);
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

  private async prepareStore(): Promise<void> {
    await Deno.mkdir(this.logsDir, { recursive: true });
    for (let index = this.options.retentionFiles + 1; index <= 100; index++) {
      await Deno.remove(`${this.#path}.${index}`).catch(ignoreNotFound);
    }
  }

  append(line: string): void {
    this.#pending = this.#pending.then(async () => await this.writeLine(line)).catch((error) => {
      this.options.onError?.(error);
    });
  }

  async close(): Promise<void> {
    await this.#pending;
  }

  private async writeLine(line: string): Promise<void> {
    await this.prepare();
    let output = line.endsWith("\n") ? line : `${line}\n`;
    let encoded = new TextEncoder().encode(output);
    if (encoded.byteLength > this.options.maxBytes) {
      output = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warning",
        module: "functions",
        event: "function_log_line_truncated",
        originalBytes: encoded.byteLength,
      }) + "\n";
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

export async function readFunctionLogs(
  logsDir: string,
  retentionFiles: number,
  query: FunctionLogQuery = {},
): Promise<FunctionLogQueryResult> {
  const path = join(logsDir, LOG_FILE_NAME);
  const files = [];
  for (let index = retentionFiles; index >= 1; index--) files.push(`${path}.${index}`);
  files.push(path);
  const entries: Record<string, unknown>[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = await Deno.readTextFile(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const line of contents.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const entry = parseLogEntry(line, file);
      if (query.functionName !== undefined && entry.function !== query.functionName) continue;
      entries.push(entry);
    }
  }
  return {
    path,
    entries: query.tail === undefined ? entries : entries.slice(-query.tail),
  };
}

function parseLogEntry(line: string, file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Return a bounded diagnostic below.
  }
  return {
    level: "warning",
    module: "functions",
    event: "malformed_function_log_line",
    file,
    preview: line.slice(0, 512),
  };
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
