import { join, resolve } from "@std/path";
import { loadLogicalBackup } from "../backup/restore.ts";
import { loadConfig } from "../config/load.ts";
import { startConfiguredDatabase } from "../database/factory.ts";
import { discoverProject } from "../project/discover.ts";
import { prepareProject, readProjectState } from "../project/state.ts";
import { startServer } from "../server/start.ts";
import { MINIBASE_VERSION } from "../version.ts";
import { readRuntimeState, runtimeIsLive, runtimeIsReady } from "../project/runtime.ts";
import { upgradeProject } from "../project/upgrade.ts";
import { formatDoctorReport, runDoctor } from "../diagnostics/doctor.ts";
import { parseCliArguments } from "./args.ts";
import { formatCliOutput } from "./output.ts";
import { resetProject, stopProject } from "./lifecycle.ts";
import { cacheFunctionDependencies } from "../functions/manager.ts";
import { readFunctionLogs } from "../functions/log_store.ts";
import { LocalObjectStore } from "../storage/local.ts";
import { S3ObjectStore } from "../storage/s3.ts";
import type { ObjectStore } from "../storage/contract.ts";
import type { MinibaseConfig } from "../config/types.ts";
import { checkStorageConsistency } from "../storage/consistency.ts";
import { runMigrationCheck } from "../migrations/check.ts";
import { recoverInterruptedMigration } from "../migrations/runner.ts";
import {
  activateAuthSigningKey,
  loadOrCreateAuthSecrets,
  publicAuthKeyring,
  removeAuthSigningKey,
  rotateAuthSigningKey,
} from "../auth/secrets.ts";

const HELP = `Minibase ${MINIBASE_VERSION}

Usage:
  minibase <command> [options]

Commands:
  start     Start Minibase in the foreground
  stop      Gracefully stop a running Minibase process
  doctor    Validate the Supabase project and resolved configuration
  status    Show the project initialization state
  reset     Back up and recreate the local database and storage
  prepare   Create Minibase runtime directories and engine marker
  upgrade   Back up and upgrade an existing project data format
  version   Print the Minibase version
  functions cache  Download and verify all Function dependencies
  functions logs   Read persisted Function logs, optionally filtered by name
  storage check    Report missing, orphaned or inconsistent local objects
  storage repair   Repair reported Storage inconsistencies (requires --force)
  storage unlock   Release a stale S3 writer lock after every writer is stopped (requires --force)
  backup export    Export a versioned logical backup directory
  backup restore   Restore a logical backup into Embedded or Server
  migration check  Verify migrations in isolated Embedded and Server databases
  migration recover  Retry one interrupted non-transactional migration (requires --force)
  auth keys list       List Auth signing key metadata without secrets
  auth keys rotate     Create and activate a new Auth signing key
  auth keys activate   Activate an existing Auth signing key by --kid
  auth keys remove     Remove an inactive Auth signing key by --kid --force
  help      Show this help

Options:
  --project <path>       Project root or supabase directory
  --engine <name>       pglite or postgres
  --host <address>      API listen address
  --port <number>       API listen port
  --public-url <url>    Public API URL
  --json                Emit machine-readable output
  --output <path>       Logical backup export directory
  --input <path>        Logical backup restore directory
  --kid <id>            Auth signing key id for activate/remove
  --migration-version <id>  Interrupted migration version to recover
  --function <name>     Filter Function logs by function name
  --tail <count>        Return only the newest Function log entries
  --include-storage     Include Storage object contents in a backup
  --force               Confirm destructive reset, key removal, S3 unlock, or stale-state cleanup
`;

function print(value: unknown, json: boolean): void {
  console.log(formatCliOutput(value, json));
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args);
    if (parsed.help || parsed.command === "help") {
      console.log(HELP);
      return 0;
    }
    if (parsed.command === "version") {
      print({ version: MINIBASE_VERSION }, parsed.json);
      return 0;
    }

    const project = await discoverProject(parsed.project);
    const config = await loadConfig(project, parsed.configOverrides);

    if (parsed.command === "auth:keys:list") {
      requireManagedAuthSecrets(config);
      print(publicAuthKeyring(await loadOrCreateAuthSecrets(project.secretsFile)), parsed.json);
      return 0;
    }

    if (parsed.command === "auth:keys:rotate") {
      requireManagedAuthSecrets(config);
      await requireStoppedProject(project);
      const rotated = await rotateAuthSigningKey(project.secretsFile);
      print({
        ...publicAuthKeyring(rotated.secrets),
        previousKid: rotated.previousKid,
      }, parsed.json);
      return 0;
    }

    if (parsed.command === "auth:keys:activate") {
      requireManagedAuthSecrets(config);
      await requireStoppedProject(project);
      if (parsed.kid === undefined) throw new Error("auth keys activate requires --kid <id>");
      print(
        publicAuthKeyring(await activateAuthSigningKey(project.secretsFile, parsed.kid)),
        parsed.json,
      );
      return 0;
    }

    if (parsed.command === "auth:keys:remove") {
      requireManagedAuthSecrets(config);
      await requireStoppedProject(project);
      if (parsed.kid === undefined) throw new Error("auth keys remove requires --kid <id>");
      if (!parsed.force) {
        throw new Error("auth keys remove permanently invalidates tokens; rerun with --force");
      }
      print(
        publicAuthKeyring(await removeAuthSigningKey(project.secretsFile, parsed.kid)),
        parsed.json,
      );
      return 0;
    }

    if (parsed.command === "doctor") {
      const report = await runDoctor(config);
      if (parsed.json) print(report, true);
      else console.log(formatDoctorReport(report).trimEnd());
      return report.ok ? 0 : 2;
    }

    if (parsed.command === "migration:check") {
      const report = await runMigrationCheck(config);
      print(report, parsed.json);
      return report.ok ? 0 : 2;
    }

    if (parsed.command === "migration:recover") {
      if (parsed.migrationVersion === undefined || !/^\d+$/u.test(parsed.migrationVersion)) {
        throw new Error("migration recover requires --migration-version <digits>");
      }
      if (!parsed.force) {
        throw new Error(
          "migration recover may repeat partial non-transactional SQL; inspect the database and rerun with --force",
        );
      }
      await requireStoppedProject(project, "recovering a migration");
      const state = await readProjectState(project);
      if (state === null) {
        throw new Error(
          "Project has not been initialized; there is no migration attempt to recover",
        );
      }
      if (state.engine !== config.database.engine) {
        throw new Error(
          `Project data uses ${state.engine}; rerun migration recover with --engine ${state.engine}`,
        );
      }
      const database = await startConfiguredDatabase(config);
      try {
        print(
          await recoverInterruptedMigration(
            database.engine,
            project,
            parsed.migrationVersion,
          ),
          parsed.json,
        );
        return 0;
      } finally {
        await database.close();
      }
    }

    if (parsed.command === "status") {
      const runtime = await readRuntimeState(project);
      const runtimeStatus = runtime === null
        ? null
        : await Promise.all([runtimeIsLive(runtime), runtimeIsReady(runtime)]);
      print(
        {
          projectRoot: project.root,
          state: await readProjectState(project),
          runtime: runtime === null ? null : {
            pid: runtime.pid,
            startedAt: runtime.startedAt,
            apiUrl: runtime.apiUrl,
            engine: runtime.engine,
            databaseMode: runtime.databaseMode,
            databaseRuntime: runtime.databaseRuntime,
            storage: runtime.storage,
            live: runtimeStatus![0],
            ready: runtimeStatus![1],
          },
        },
        parsed.json,
      );
      return 0;
    }

    if (parsed.command === "stop") {
      print(await stopProject(config, parsed.force), parsed.json);
      return 0;
    }

    if (parsed.command === "reset") {
      print(await resetProject(config, parsed.force), parsed.json);
      return 0;
    }

    if (parsed.command === "backup:export") {
      const runtime = await readRuntimeState(project);
      if (runtime !== null && await runtimeIsLive(runtime)) {
        throw new Error("Stop Minibase before exporting an offline logical backup");
      }
      const state = await readProjectState(project);
      if (state === null) {
        throw new Error("Project has not been initialized; start Minibase before exporting");
      }
      if (state.engine !== config.database.engine) {
        throw new Error(
          `Project data uses ${state.engine}; rerun backup export with --engine ${state.engine}`,
        );
      }
      const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const outputDir = parsed.output === undefined
        ? join(project.backupsDir, `logical-${timestamp}`)
        : resolve(project.root, parsed.output);
      const database = await startConfiguredDatabase(config);
      try {
        const backup = await database.engine.exportLogicalBackup({
          projectId: config.projectId,
          outputDir,
          includeStorage: parsed.includeStorage,
          storagePath: config.storage.driver === "local" ? config.storage.path : undefined,
          objectStore: parsed.includeStorage ? configuredObjectStore(config) : undefined,
        });
        print(backup, parsed.json);
        return 0;
      } finally {
        await database.close();
      }
    }

    if (parsed.command === "backup:restore") {
      if (parsed.input === undefined) {
        throw new Error("backup restore requires --input <path>");
      }
      const runtime = await readRuntimeState(project);
      if (runtime !== null && await runtimeIsLive(runtime)) {
        throw new Error("Stop Minibase before restoring an offline logical backup");
      }
      const inputDir = resolve(project.root, parsed.input);
      const backup = await loadLogicalBackup(inputDir);
      const existing = await readProjectState(project);
      if (existing !== null && existing.engine !== config.database.engine) {
        throw new Error(
          `Project data uses ${existing.engine}; restore into a separate ${config.database.engine} project`,
        );
      }
      let safetyBackupDir: string | null = null;
      if (parsed.force && existing !== null) {
        safetyBackupDir = (await resetProject(config, true)).backupDir;
      } else {
        await prepareProject(project, config.database.engine);
      }
      const database = await startConfiguredDatabase(config);
      const objectStore = backup.objectsIncluded
        ? configuredObjectStore(config, { ownershipRequired: true })
        : undefined;
      try {
        await objectStore?.acquireOwnership?.(config.projectId);
        await database.engine.applyMigrations(project);
        const restored = await database.engine.restoreLogicalBackup({
          inputDir,
          force: parsed.force,
          storagePath: config.storage.driver === "local" ? config.storage.path : undefined,
          objectStore,
        });
        print({ ...restored, safetyBackupDir }, parsed.json);
        return 0;
      } finally {
        try {
          await objectStore?.releaseOwnership?.();
        } finally {
          await database.close();
        }
      }
    }

    if (parsed.command === "functions:cache") {
      print({ ok: true, functions: await cacheFunctionDependencies(config) }, parsed.json);
      return 0;
    }

    if (parsed.command === "functions:logs") {
      if (
        parsed.functionName !== undefined &&
        !/^[A-Za-z0-9_-]+$/u.test(parsed.functionName)
      ) {
        throw new Error("--function must contain only letters, numbers, underscores or hyphens");
      }
      print(
        await readFunctionLogs(config.project.logsDir, config.functions.logs.retentionFiles, {
          functionName: parsed.functionName,
          tail: parsed.tail,
        }),
        parsed.json,
      );
      return 0;
    }

    if (parsed.command === "storage:unlock") {
      if (config.storage.driver !== "s3") {
        throw new Error("storage unlock is only available for S3-compatible Storage");
      }
      if (!parsed.force) {
        throw new Error(
          "storage unlock can enable another writer; verify every Minibase instance is stopped and rerun with --force",
        );
      }
      await requireStoppedProject(project, "force-releasing S3 bucket ownership");
      const store = new S3ObjectStore(config.storage.s3!);
      print(await store.forceReleaseOwnership(config.projectId), parsed.json);
      return 0;
    }

    if (parsed.command === "storage:check" || parsed.command === "storage:repair") {
      const runtime = await readRuntimeState(project);
      if (runtime !== null && await runtimeIsLive(runtime)) {
        throw new Error("Stop Minibase before running an offline Storage consistency command");
      }
      const state = await readProjectState(project);
      if (state === null) {
        throw new Error("Project has not been initialized; start Minibase before checking Storage");
      }
      if (state.engine !== config.database.engine) {
        throw new Error(
          `Project data uses ${state.engine}; rerun Storage consistency with --engine ${state.engine}`,
        );
      }
      const database = await startConfiguredDatabase(config);
      const repairing = parsed.command === "storage:repair";
      const objectStore = configuredObjectStore(config, { ownershipRequired: repairing });
      try {
        if (repairing) await objectStore.acquireOwnership?.(config.projectId);
        const report = await checkStorageConsistency(
          database.engine,
          objectStore,
          { repair: parsed.command === "storage:repair", force: parsed.force },
        );
        print(report, parsed.json);
        return report.ok || report.repaired ? 0 : 3;
      } finally {
        try {
          await objectStore.releaseOwnership?.();
        } finally {
          await database.close();
        }
      }
    }

    if (parsed.command === "prepare") {
      const state = await prepareProject(project, config.database.engine);
      print(
        {
          ok: true,
          projectRoot: project.root,
          state,
        },
        parsed.json,
      );
      return 0;
    }

    if (parsed.command === "upgrade") {
      print(await upgradeProject(config), parsed.json);
      return 0;
    }

    if (parsed.command === "start") {
      await startServer(config);
      return 0;
    }

    throw new Error(`Unknown command: ${parsed.command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function configuredObjectStore(
  config: MinibaseConfig,
  options: { ownershipRequired?: boolean } = {},
): ObjectStore {
  return config.storage.driver === "s3"
    ? new S3ObjectStore(config.storage.s3!, options)
    : new LocalObjectStore(config.storage.path);
}

function requireManagedAuthSecrets(config: Awaited<ReturnType<typeof loadConfig>>): void {
  if (config.auth.jwtSecret !== undefined) {
    throw new Error(
      "Auth signing keys are externally managed; update MINIBASE_AUTH_JWT_SECRET in the configured Secret source",
    );
  }
}

async function requireStoppedProject(
  project: Awaited<ReturnType<typeof discoverProject>>,
  operation = "changing Auth signing keys",
) {
  const runtime = await readRuntimeState(project);
  if (runtime !== null && await runtimeIsLive(runtime)) {
    throw new Error(`Stop Minibase before ${operation}`);
  }
}
