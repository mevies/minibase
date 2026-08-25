import type { DatabaseEngineName, StorageDriverName } from "../config/types.ts";
import type { ProjectPaths } from "./types.ts";

export interface RuntimeState {
  formatVersion: 1;
  pid: number;
  startedAt: string;
  apiUrl: string;
  controlUrl: string;
  controlToken: string;
  engine: DatabaseEngineName;
  databaseMode: "embedded" | "managed" | "external";
  databaseRuntime?: {
    initialized: boolean;
    initializeMs: number;
    startMs: number;
    version: string;
  };
  storage: StorageDriverName;
  logsDir: string;
}

export async function readRuntimeState(project: ProjectPaths): Promise<RuntimeState | null> {
  try {
    return JSON.parse(await Deno.readTextFile(project.runtimeFile)) as RuntimeState;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

export async function writeRuntimeState(
  project: ProjectPaths,
  state: RuntimeState,
): Promise<void> {
  await Deno.mkdir(project.minibaseDir, { recursive: true });
  const temporary = `${project.runtimeFile}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await Deno.rename(temporary, project.runtimeFile);
}

export async function removeRuntimeState(
  project: ProjectPaths,
  expectedPid?: number,
): Promise<void> {
  const current = await readRuntimeState(project);
  if (current === null || (expectedPid !== undefined && current.pid !== expectedPid)) {
    return;
  }
  try {
    await Deno.remove(project.runtimeFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

export async function runtimeIsReady(state: RuntimeState): Promise<boolean> {
  return await runtimeEndpointIsOk(state, "/health/ready", 3_000);
}

export async function runtimeIsLive(state: RuntimeState): Promise<boolean> {
  return await runtimeEndpointIsOk(state, "/health/live", 1_000);
}

async function runtimeEndpointIsOk(
  state: RuntimeState,
  pathname: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(new URL(pathname, state.controlUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
