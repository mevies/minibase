import { basename, dirname, join, resolve } from "@std/path";
import type { ProjectPaths } from "./types.ts";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function buildProjectPaths(root: string): ProjectPaths {
  const supabaseDir = join(root, "supabase");
  const minibaseDir = join(root, ".minibase");
  return {
    root,
    supabaseDir,
    supabaseConfigFile: null,
    migrationsDir: join(supabaseDir, "migrations"),
    functionsDir: join(supabaseDir, "functions"),
    seedFile: null,
    minibaseConfigFile: null,
    minibaseDir,
    stateFile: join(minibaseDir, "project.json"),
    runtimeFile: join(minibaseDir, "runtime.json"),
    secretsFile: join(minibaseDir, "secrets.json"),
    storageDir: join(minibaseDir, "storage"),
    logsDir: join(minibaseDir, "logs"),
    cacheDir: join(minibaseDir, "cache"),
    pgliteDataDir: join(minibaseDir, "data", "pglite"),
    postgresDataDir: join(minibaseDir, "data", "postgres"),
    backupsDir: join(minibaseDir, "backups"),
  };
}

async function hydrateOptionalPaths(paths: ProjectPaths): Promise<ProjectPaths> {
  const supabaseConfigFile = join(paths.supabaseDir, "config.toml");
  const seedFile = join(paths.supabaseDir, "seed.sql");
  const minibaseConfigFile = join(paths.root, "minibase.toml");
  return {
    ...paths,
    supabaseConfigFile: await isFile(supabaseConfigFile) ? supabaseConfigFile : null,
    seedFile: await isFile(seedFile) ? seedFile : null,
    minibaseConfigFile: await isFile(minibaseConfigFile) ? minibaseConfigFile : null,
  };
}

export async function discoverProject(startPath = Deno.cwd()): Promise<ProjectPaths> {
  let candidate = resolve(startPath);
  if (!(await isDirectory(candidate))) {
    throw new Error(`Project path does not exist or is not a directory: ${candidate}`);
  }

  if (basename(candidate).toLowerCase() === "supabase") {
    return await hydrateOptionalPaths(buildProjectPaths(dirname(candidate)));
  }

  while (true) {
    if (await isDirectory(join(candidate, "supabase"))) {
      return await hydrateOptionalPaths(buildProjectPaths(candidate));
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  throw new Error(
    `No Supabase project was found from ${resolve(startPath)}. Expected a supabase directory.`,
  );
}
