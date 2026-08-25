import type { DatabaseEngineName } from "../config/types.ts";
import { MINIBASE_VERSION, PROJECT_FORMAT_VERSION } from "../version.ts";
import { PGLITE_VERSION, POSTGRES_RUNTIME_VERSION } from "../toolchain.ts";
import type { ProjectPaths } from "./types.ts";

interface ProjectStateBase {
  engine: DatabaseEngineName;
  minibaseVersion: string;
  createdAt: string;
}

export interface LegacyProjectState extends ProjectStateBase {
  formatVersion: 1;
}

export interface CurrentProjectState extends ProjectStateBase {
  formatVersion: typeof PROJECT_FORMAT_VERSION;
  upgradedAt?: string;
  components: {
    minibaseCore: string;
    pglite: string;
    postgresRuntime: string;
  };
  database: {
    postgresMajor: number | null;
  };
}

export type ProjectState = LegacyProjectState | CurrentProjectState;

export async function readProjectState(project: ProjectPaths): Promise<ProjectState | null> {
  try {
    return parseProjectState(JSON.parse(await Deno.readTextFile(project.stateFile)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

export async function prepareProject(
  project: ProjectPaths,
  engine: DatabaseEngineName,
): Promise<ProjectState> {
  const existing = await readProjectState(project);
  if (existing !== null && existing.engine !== engine) {
    throw new Error(
      `Project data was initialized for ${existing.engine}, not ${engine}. Export and import data before switching engines.`,
    );
  }
  if (existing !== null && existing.formatVersion < PROJECT_FORMAT_VERSION) {
    throw new Error(
      `Project data format ${existing.formatVersion} requires an upgrade to ${PROJECT_FORMAT_VERSION}. ` +
        "Stop Minibase and run `minibase upgrade` before starting this project.",
    );
  }
  if (existing !== null && existing.formatVersion > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `Project data format ${existing.formatVersion} is newer than this Minibase supports ` +
        `(${PROJECT_FORMAT_VERSION}); use a compatible newer Minibase release`,
    );
  }

  await Promise.all([
    Deno.mkdir(project.minibaseDir, { recursive: true }),
    Deno.mkdir(project.storageDir, { recursive: true }),
    Deno.mkdir(project.logsDir, { recursive: true }),
    Deno.mkdir(project.cacheDir, { recursive: true }),
    Deno.mkdir(engine === "pglite" ? project.pgliteDataDir : project.postgresDataDir, {
      recursive: true,
    }),
  ]);

  if (existing !== null) {
    return existing;
  }

  const state: CurrentProjectState = {
    formatVersion: PROJECT_FORMAT_VERSION,
    engine,
    minibaseVersion: MINIBASE_VERSION,
    createdAt: new Date().toISOString(),
    components: currentComponentVersions(),
    database: { postgresMajor: null },
  };
  await writeProjectState(project, state);
  return state;
}

export async function writeProjectState(
  project: ProjectPaths,
  state: CurrentProjectState,
): Promise<void> {
  const temporary = `${project.stateFile}.${crypto.randomUUID()}.tmp`;
  const displaced = `${project.stateFile}.${crypto.randomUUID()}.old`;
  await Deno.writeTextFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    await Deno.rename(temporary, project.stateFile);
  } catch (error) {
    if (Deno.build.os === "windows" && error instanceof Deno.errors.AlreadyExists) {
      await Deno.rename(project.stateFile, displaced);
      try {
        await Deno.rename(temporary, project.stateFile);
      } catch (replacementError) {
        await Deno.rename(displaced, project.stateFile);
        throw replacementError;
      }
      await Deno.remove(displaced);
    } else {
      throw error;
    }
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

export function upgradedProjectState(
  state: LegacyProjectState,
  postgresMajor: number | null,
  upgradedAt: string,
): CurrentProjectState {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    engine: state.engine,
    minibaseVersion: MINIBASE_VERSION,
    createdAt: state.createdAt,
    upgradedAt,
    components: currentComponentVersions(),
    database: { postgresMajor },
  };
}

function currentComponentVersions(): CurrentProjectState["components"] {
  return {
    minibaseCore: MINIBASE_VERSION,
    pglite: PGLITE_VERSION,
    postgresRuntime: POSTGRES_RUNTIME_VERSION,
  };
}

function parseProjectState(value: unknown): ProjectState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project state must be a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.engine !== "pglite" && candidate.engine !== "postgres") {
    throw new Error("Project state has an invalid database engine");
  }
  const engine: DatabaseEngineName = candidate.engine;
  if (typeof candidate.minibaseVersion !== "string" || candidate.minibaseVersion.length === 0) {
    throw new Error("Project state has an invalid Minibase version");
  }
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    throw new Error("Project state has an invalid creation timestamp");
  }
  const base = {
    engine,
    minibaseVersion: candidate.minibaseVersion,
    createdAt: candidate.createdAt,
  };
  if (candidate.formatVersion === 1) return { formatVersion: 1, ...base };
  if (candidate.formatVersion !== PROJECT_FORMAT_VERSION) {
    if (!Number.isSafeInteger(candidate.formatVersion) || Number(candidate.formatVersion) < 1) {
      throw new Error("Project state has an invalid format version");
    }
    if (Number(candidate.formatVersion) > PROJECT_FORMAT_VERSION) {
      throw new Error(
        `Project data format ${candidate.formatVersion} is newer than this Minibase supports ` +
          `(${PROJECT_FORMAT_VERSION})`,
      );
    }
    throw new Error(
      `Unsupported project data format ${candidate.formatVersion}; ` +
        `no upgrade path to ${PROJECT_FORMAT_VERSION} is available`,
    );
  }
  const components = candidate.components as Record<string, unknown> | undefined;
  const database = candidate.database as Record<string, unknown> | undefined;
  if (
    components === undefined || typeof components.minibaseCore !== "string" ||
    typeof components.pglite !== "string" || typeof components.postgresRuntime !== "string"
  ) {
    throw new Error("Project state is missing component version records");
  }
  const postgresMajor = database?.postgresMajor;
  if (
    postgresMajor !== null && (!Number.isSafeInteger(postgresMajor) || Number(postgresMajor) < 1)
  ) {
    throw new Error("Project state has an invalid PostgreSQL major version");
  }
  if (
    candidate.upgradedAt !== undefined &&
    (typeof candidate.upgradedAt !== "string" || Number.isNaN(Date.parse(candidate.upgradedAt)))
  ) {
    throw new Error("Project state has an invalid upgrade timestamp");
  }
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    ...base,
    ...(typeof candidate.upgradedAt === "string" ? { upgradedAt: candidate.upgradedAt } : {}),
    components: {
      minibaseCore: components.minibaseCore,
      pglite: components.pglite,
      postgresRuntime: components.postgresRuntime,
    },
    database: { postgresMajor: postgresMajor === null ? null : Number(postgresMajor) },
  };
}
