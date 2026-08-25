import { dirname, fromFileUrl, isAbsolute, join } from "@std/path";
import { createHash } from "node:crypto";
import toolchain from "../../toolchain.json" with { type: "json" };
import {
  currentReleasePlatform,
  denoExecutableSha256,
  denoRuntimeAssetName,
  functionWorkerAssetName,
  type ReleasePlatformDescriptor,
} from "../release/platform.ts";

const DENO_VERSION = toolchain.runtimes.deno.required;
const FUNCTION_WORKER_SOURCE = new URL("./worker_entry.ts", import.meta.url);
let standaloneDenoExecutable: Promise<string> | undefined;
let standaloneWorkerEntrypoint: Promise<string> | undefined;

export interface BundledDenoRuntimeOptions {
  cacheRoot: string;
  compressedRuntime: URL | string;
  expectedSha256: string;
  version: string;
  executableName: string;
}

export interface BundledRuntimeFileOptions {
  runtimeDir: string;
  source: URL | string;
  fileStem: string;
  extension: string;
}

export async function functionDenoExecutable(): Promise<string> {
  if (!Deno.build.standalone) return Deno.execPath();
  const bundled = bundledRuntimeDescriptor();
  standaloneDenoExecutable ??= ensureBundledDenoRuntime({
    cacheRoot: runtimeCacheRoot(),
    compressedRuntime: bundled.archive,
    expectedSha256: bundled.executableSha256,
    version: DENO_VERSION,
    executableName: bundled.platform.denoExecutableName,
  });
  return await standaloneDenoExecutable;
}

export async function functionWorkerEntrypoint(): Promise<string> {
  if (!Deno.build.standalone) return fromFileUrl(FUNCTION_WORKER_SOURCE);
  standaloneWorkerEntrypoint ??= (async () => {
    const executable = await functionDenoExecutable();
    const bundled = bundledRuntimeDescriptor();
    return await ensureBundledRuntimeFile({
      runtimeDir: dirname(executable),
      source: bundled.worker,
      fileStem: "minibase-function-worker",
      extension: ".js",
    });
  })();
  return await standaloneWorkerEntrypoint;
}

function bundledRuntimeDescriptor(): {
  platform: ReleasePlatformDescriptor;
  archive: URL;
  worker: URL;
  executableSha256: string;
} {
  const platform = currentReleasePlatform();
  return {
    platform,
    archive: new URL(
      `../../release/assets/${denoRuntimeAssetName(DENO_VERSION, platform)}`,
      import.meta.url,
    ),
    worker: new URL(
      `../../release/assets/${functionWorkerAssetName(platform)}`,
      import.meta.url,
    ),
    executableSha256: denoExecutableSha256(platform),
  };
}

export async function ensureBundledDenoRuntime(
  options: BundledDenoRuntimeOptions,
): Promise<string> {
  validateOptions(options);
  const runtimeDir = join(options.cacheRoot, "deno", options.version);
  const executable = join(runtimeDir, options.executableName);
  await Deno.mkdir(runtimeDir, { recursive: true });
  const lock = await Deno.open(join(runtimeDir, "extract.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(true);
  try {
    if (await fileExists(executable)) {
      const actual = await sha256File(executable);
      if (actual !== options.expectedSha256) {
        throw new Error(
          `Bundled Deno Runtime integrity check failed at ${executable}; ` +
            `remove ${runtimeDir} and restart Minibase to restore the versioned Runtime`,
        );
      }
      return executable;
    }
    const temporary = join(runtimeDir, `${options.executableName}.${crypto.randomUUID()}.tmp`);
    try {
      const archive = await Deno.open(options.compressedRuntime, { read: true });
      const target = await Deno.open(temporary, {
        createNew: true,
        write: true,
        mode: 0o700,
      });
      await archive.readable.pipeThrough(new DecompressionStream("gzip")).pipeTo(target.writable);
      const actual = await sha256File(temporary);
      if (actual !== options.expectedSha256) {
        throw new Error(
          `Embedded Deno Runtime SHA-256 mismatch: expected ${options.expectedSha256}, got ${actual}`,
        );
      }
      if (Deno.build.os !== "windows") await Deno.chmod(temporary, 0o700);
      await Deno.rename(temporary, executable);
      return executable;
    } finally {
      await Deno.remove(temporary).catch(ignoreNotFound);
    }
  } finally {
    await lock.unlock();
    lock.close();
  }
}

export async function ensureBundledRuntimeFile(
  options: BundledRuntimeFileOptions,
): Promise<string> {
  validateRuntimeFileOptions(options);
  const contents = await Deno.readFile(options.source);
  const expectedSha256 = sha256Bytes(contents);
  const destination = join(
    options.runtimeDir,
    `${options.fileStem}-${expectedSha256}${options.extension}`,
  );
  await Deno.mkdir(options.runtimeDir, { recursive: true });
  const lock = await Deno.open(join(options.runtimeDir, "extract.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(true);
  try {
    if (await fileExists(destination)) {
      const actual = await sha256File(destination);
      if (actual !== expectedSha256) {
        throw new Error(
          `Bundled Function worker integrity check failed at ${destination}; ` +
            `remove ${options.runtimeDir} and restart Minibase to restore the versioned Runtime`,
        );
      }
      return destination;
    }
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeFile(temporary, contents, { createNew: true, mode: 0o600 });
      await Deno.rename(temporary, destination);
      return destination;
    } finally {
      await Deno.remove(temporary).catch(ignoreNotFound);
    }
  } finally {
    await lock.unlock();
    lock.close();
  }
}

function runtimeCacheRoot(): string {
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA");
    if (localAppData === undefined || !isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path for the bundled Function Runtime");
    }
    return join(localAppData, "minibase", "runtimes");
  }
  const configured = Deno.env.get("XDG_CACHE_HOME");
  if (configured !== undefined && isAbsolute(configured)) {
    return join(configured, "minibase", "runtimes");
  }
  const home = Deno.env.get("HOME");
  if (home === undefined || !isAbsolute(home)) {
    throw new Error("HOME must be an absolute path for the bundled Function Runtime");
  }
  return join(home, ".cache", "minibase", "runtimes");
}

function validateOptions(options: BundledDenoRuntimeOptions): void {
  if (!isAbsolute(options.cacheRoot)) throw new Error("Deno Runtime cache root must be absolute");
  if (!/^[0-9A-Za-z._-]+$/u.test(options.version)) {
    throw new Error("Deno Runtime version contains unsupported characters");
  }
  if (!/^[0-9A-Za-z._-]+$/u.test(options.executableName)) {
    throw new Error("Deno Runtime executable name contains unsupported characters");
  }
  if (!/^[0-9a-f]{64}$/u.test(options.expectedSha256)) {
    throw new Error("Deno Runtime SHA-256 must be a lowercase hexadecimal digest");
  }
}

function validateRuntimeFileOptions(options: BundledRuntimeFileOptions): void {
  if (!isAbsolute(options.runtimeDir)) throw new Error("Runtime directory must be absolute");
  if (!/^[0-9A-Za-z_-]+$/u.test(options.fileStem)) {
    throw new Error("Runtime file stem contains unsupported characters");
  }
  if (!/^\.[0-9A-Za-z]+$/u.test(options.extension)) {
    throw new Error("Runtime file extension contains unsupported characters");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const read = await file.read(buffer);
      if (read === null) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

function sha256Bytes(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
