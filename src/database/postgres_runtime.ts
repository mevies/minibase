import { join } from "@std/path";
import toolchain from "../../toolchain.json" with { type: "json" };

const POSTGRES_MAJOR = toolchain.components.postgres.required.split(".", 1)[0]!;

export interface PostgresRuntimeOptions {
  runtimeDir: string;
  dataDir: string;
  port: number;
  logsDir: string;
}

export interface PostgresRuntimeMetrics {
  initialized: boolean;
  initializeMs: number;
  startMs: number;
  version: string;
}

export class PostgresRuntime {
  readonly #binDir: string;
  #running = false;

  constructor(private readonly options: PostgresRuntimeOptions) {
    this.#binDir = Deno.build.os === "linux"
      ? join(options.runtimeDir, "usr", "lib", "postgresql", POSTGRES_MAJOR, "bin")
      : join(options.runtimeDir, "bin");
  }

  async start(): Promise<PostgresRuntimeMetrics> {
    await this.assertRuntime();
    if (await this.status()) {
      throw new Error(
        `PostgreSQL data directory is already running: ${this.options.dataDir}. ` +
          "Stop the existing instance before starting another Minibase Server.",
      );
    }
    await Deno.mkdir(this.options.logsDir, { recursive: true });
    const initialized = await exists(join(this.options.dataDir, "PG_VERSION"));
    let initializeMs = 0;
    if (!initialized) {
      await Deno.mkdir(this.options.dataDir, { recursive: true });
      const started = performance.now();
      await this.command("initdb", [
        "-D",
        this.options.dataDir,
        "--encoding=UTF8",
        "--locale=C",
        "--username=postgres",
        "--auth=trust",
      ]);
      initializeMs = performance.now() - started;
    }
    const startTime = performance.now();
    await this.control([
      "-D",
      this.options.dataDir,
      "-l",
      join(this.options.logsDir, "postgres.log"),
      "-w",
      "-t",
      "30",
      "start",
      "-o",
      this.serverOptions(),
    ]);
    this.#running = true;
    const versionOutput = await this.command("postgres", ["--version"]);
    return {
      initialized: !initialized,
      initializeMs,
      startMs: performance.now() - startTime,
      version: versionOutput.trim(),
    };
  }

  async stop(): Promise<void> {
    if (!this.#running && !(await exists(join(this.options.dataDir, "postmaster.pid")))) return;
    await this.control([
      "-D",
      this.options.dataDir,
      "-w",
      "-t",
      "30",
      "stop",
      "-m",
      "fast",
    ]);
    this.#running = false;
  }

  async status(): Promise<boolean> {
    return await this.control(["-D", this.options.dataDir, "status"], false);
  }

  async crashForTest(): Promise<void> {
    await this.control([
      "-D",
      this.options.dataDir,
      "-w",
      "-t",
      "30",
      "stop",
      "-m",
      "immediate",
    ]);
    this.#running = false;
  }

  private async assertRuntime(): Promise<void> {
    for (const executable of ["postgres", "initdb", "pg_ctl"]) {
      const path = this.executable(executable);
      if (!(await exists(path))) {
        throw new Error(`PostgreSQL runtime is incomplete: missing ${path}`);
      }
    }
  }

  private async command(name: string, args: string[]): Promise<string> {
    const result = await this.commandResult(name, args);
    if (!result.success) {
      throw new Error(
        `${name} failed with code ${result.code}: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
    }
    return new TextDecoder().decode(result.stdout);
  }

  private async control(args: string[], throwOnFailure = true): Promise<boolean> {
    const result = await new Deno.Command(this.executable("pg_ctl"), {
      args,
      env: this.runtimeEnvironment(),
      stdout: "null",
      stderr: "null",
    }).output();
    if (!result.success && throwOnFailure) {
      throw new Error(`pg_ctl failed with code ${result.code}; inspect postgres.log for details`);
    }
    return result.success;
  }

  private async commandResult(name: string, args: string[]): Promise<Deno.CommandOutput> {
    return await new Deno.Command(this.executable(name), {
      args,
      env: this.runtimeEnvironment(),
      stdout: "piped",
      stderr: "piped",
    }).output();
  }

  private executable(name: string): string {
    return join(this.#binDir, `${name}${Deno.build.os === "windows" ? ".exe" : ""}`);
  }

  private serverOptions(): string {
    const network = `-h 127.0.0.1 -p ${this.options.port}`;
    return Deno.build.os === "windows" ? network : `${network} -c unix_socket_directories=`;
  }

  private runtimeEnvironment(): Record<string, string> {
    const delimiter = Deno.build.os === "windows" ? ";" : ":";
    const environment: Record<string, string> = {
      PATH: `${this.#binDir}${delimiter}${Deno.env.get("PATH") ?? ""}`,
    };
    if (Deno.build.os === "linux") {
      const runtimeLibraries = join(
        this.options.runtimeDir,
        "usr",
        "lib",
        "x86_64-linux-gnu",
      );
      environment.LD_LIBRARY_PATH = `${runtimeLibraries}:${Deno.env.get("LD_LIBRARY_PATH") ?? ""}`;
    }
    return environment;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
