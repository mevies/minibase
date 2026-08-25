import { join } from "@std/path";
import toolchain from "../../toolchain.json" with { type: "json" };
import type { MinibaseConfig } from "../config/types.ts";
import { startConfiguredDatabase } from "../database/factory.ts";
import { resolvePostgresRuntimePath } from "../database/postgres_bundled.ts";
import { functionDependenciesCached, resolveFunctionFiles } from "../functions/manager.ts";
import {
  offlineMigrationCapabilities,
  scanMigrationCompatibility,
} from "../migrations/compatibility.ts";
import { inspectMigrationAttempts } from "../migrations/runner.ts";
import { readRuntimeState, runtimeIsLive, type RuntimeState } from "../project/runtime.ts";
import { readProjectState } from "../project/state.ts";
import {
  inspectWindowsSecretAcl,
  unauthorizedWindowsAclSids,
  windowsSecretAclIsPrivate,
} from "../security/windows_acl.ts";
import { checkStorageConsistency, type StorageConsistencyReport } from "../storage/consistency.ts";
import { LocalObjectStore } from "../storage/local.ts";
import { S3ObjectStore } from "../storage/s3.ts";
import { secretQualityChecks } from "./secrets.ts";
import type { DiagnosticResult } from "./types.ts";

const POSTGRES_MAJOR = toolchain.components.postgres.required.split(".", 1)[0]!;

export interface DoctorReport {
  ok: boolean;
  engine: string;
  checks: DiagnosticResult[];
}

interface RuntimeInspection {
  state: RuntimeState | null;
  live: boolean;
  ready: boolean;
  checks?: {
    database?: { ready?: unknown };
    storage?: { ready?: unknown; driver?: unknown };
  };
}

export async function runDoctor(config: MinibaseConfig): Promise<DoctorReport> {
  const runtimeResolution = await resolveDoctorRuntime(config);
  config = runtimeResolution.config;
  const runtime = await inspectRuntime(config);
  const databaseIntegrity = await databaseIntegrityChecks(config, runtime);
  const databaseCorrupt = databaseIntegrity.some((check) => check.severity === "error");
  const checks: DiagnosticResult[] = [];
  checks.push(...await projectChecks(config));
  checks.push(...serverChecks(config, runtime));
  checks.push(...await secretFileChecks(config));
  checks.push(...await secretQualityChecks(config));
  checks.push(...await storageBackendChecks(config, runtime));
  checks.push(...databaseIntegrity);
  if (!databaseCorrupt) checks.push(...await storageConsistencyChecks(config, runtime));
  checks.push(...await migrationChecks(config));
  checks.push(...await extensionChecks(config, runtime));
  checks.push(...await functionChecks(config));
  if (runtimeResolution.error !== undefined) checks.push(runtimeResolution.error);
  else if (!databaseCorrupt) checks.push(...await databaseChecks(config, runtime));
  checks.push(...runtimeChecks(runtime));
  return {
    ok: !checks.some((check) => check.severity === "error"),
    engine: config.database.engine,
    checks,
  };
}

async function resolveDoctorRuntime(config: MinibaseConfig): Promise<{
  config: MinibaseConfig;
  error?: DiagnosticResult;
}> {
  if (
    config.database.engine !== "postgres" || !config.database.managed ||
    config.database.runtimePath !== undefined
  ) {
    return { config };
  }
  try {
    const runtimePath = await resolvePostgresRuntimePath(undefined);
    if (runtimePath === null) return { config };
    return {
      config: {
        ...config,
        database: { ...config.database, runtimePath },
      },
    };
  } catch (error) {
    return {
      config,
      error: {
        code: "database.runtime",
        severity: "error",
        message: errorMessage(error),
        fix: "Remove the damaged versioned Runtime directory named in the error and rerun doctor.",
      },
    };
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Minibase doctor: ${report.ok ? "OK" : "FAILED"}`,
    `Engine: ${report.engine}`,
  ];
  for (const check of report.checks) {
    lines.push(`[${check.severity.toUpperCase()}] ${check.code}: ${check.message}`);
    if (check.file !== undefined) {
      const location = [check.file, check.line, check.column].filter((value) => value !== undefined)
        .join(":");
      lines.push(`  At: ${location}`);
    }
    if (check.fix !== undefined) lines.push(`  Fix: ${check.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

async function inspectRuntime(config: MinibaseConfig): Promise<RuntimeInspection> {
  const state = await readRuntimeState(config.project);
  if (state === null) return { state: null, live: false, ready: false };
  const live = await runtimeIsLive(state);
  if (!live) return { state, live: false, ready: false };
  try {
    const response = await fetch(new URL("/health/ready", state.controlUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json() as { checks?: RuntimeInspection["checks"] };
    return { state, live, ready: response.ok, checks: body.checks };
  } catch {
    return { state, live, ready: false };
  }
}

function serverChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): DiagnosticResult[] {
  if (runtime.live) {
    return [{
      code: "server.port",
      severity: "info",
      message: `Minibase is listening on ${runtime.state!.apiUrl}`,
    }];
  }
  const checks = [
    portCheck(
      "server.port",
      config.server.host,
      config.server.port,
      "Choose another --port value or stop the process using the API port.",
    ),
  ];
  if (config.database.engine === "postgres" && config.database.managed) {
    if (config.database.port === config.server.port) {
      checks.push({
        code: "database.port",
        severity: "error",
        message: `Managed PostgreSQL and the API both use port ${config.database.port}`,
        fix: "Configure different API and PostgreSQL ports before starting Minibase.",
      });
    } else {
      checks.push(
        portCheck(
          "database.port",
          "127.0.0.1",
          config.database.port,
          "Choose another PostgreSQL port or stop the process currently using it.",
        ),
      );
    }
  }
  return checks;
}

function portCheck(
  code: string,
  hostname: string,
  port: number,
  fix: string,
): DiagnosticResult {
  let listener: Deno.TcpListener | null = null;
  try {
    listener = Deno.listen({ hostname, port, transport: "tcp" });
    return {
      code,
      severity: "info",
      message: `${hostname}:${port} is available`,
    };
  } catch (error) {
    return {
      code,
      severity: "error",
      message: `${hostname}:${port} is unavailable: ${errorMessage(error)}`,
      fix,
    };
  } finally {
    listener?.close();
  }
}

async function storageBackendChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<DiagnosticResult[]> {
  if (runtime.live) {
    const ready = runtime.checks?.storage?.ready;
    if (typeof ready !== "boolean") {
      return [{
        code: "storage.health",
        severity: "error",
        message: "Running Minibase did not return a valid Storage readiness result",
        fix: "Inspect `/health/ready` and the runtime logs, then restart Minibase if needed.",
      }];
    }
    return [{
      code: "storage.health",
      severity: ready ? "info" : "error",
      message: ready
        ? `${config.storage.driver} Storage readiness probe succeeded`
        : `${config.storage.driver} Storage readiness probe failed`,
      fix: ready ? undefined : storageHealthFix(config),
    }];
  }
  const store = config.storage.driver === "s3"
    ? new S3ObjectStore(config.storage.s3!)
    : new LocalObjectStore(config.storage.path);
  const healthy = await store.health();
  return [{
    code: "storage.health",
    severity: healthy ? "info" : "error",
    message: healthy
      ? `${config.storage.driver} Storage probe succeeded`
      : `${config.storage.driver} Storage probe failed`,
    fix: healthy ? undefined : storageHealthFix(config),
  }];
}

function storageHealthFix(config: MinibaseConfig): string {
  return config.storage.driver === "s3"
    ? "Verify the S3 endpoint, bucket, credentials, network access and ListObjectsV2 permission."
    : "Grant write/delete permission to storage.path or configure another local Storage directory.";
}

async function secretFileChecks(config: MinibaseConfig): Promise<DiagnosticResult[]> {
  const checks: DiagnosticResult[] = [];
  const configuredSecrets = config.secrets.file === undefined ? [] : [{
    code: "secrets.external",
    label: "external Secret file",
    path: config.secrets.file,
    minibaseOwned: false,
  }] as const;
  const authSecrets = config.auth.jwtSecret === undefined
    ? [{
      code: "secrets.auth",
      label: "Auth secrets",
      path: config.project.secretsFile,
      minibaseOwned: true,
    }] as const
    : [];
  for (
    const secret of [
      {
        code: "secrets.env.root",
        label: "project .env",
        path: join(config.project.root, ".env"),
        minibaseOwned: false,
      },
      {
        code: "secrets.env.functions",
        label: "Functions .env",
        path: join(config.project.functionsDir, ".env"),
        minibaseOwned: false,
      },
      ...configuredSecrets,
      ...authSecrets,
    ] as const
  ) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(secret.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      checks.push({
        code: `${secret.code}.stat`,
        severity: "warning",
        message: `${secret.label} metadata could not be inspected: ${errorMessage(error)}`,
        fix: `Inspect ${secret.path} and its parent directory permissions.`,
        file: secret.path,
      });
      continue;
    }
    if (info.isSymlink) {
      checks.push({
        code: `${secret.code}.symlink`,
        severity: secret.minibaseOwned ? "error" : "warning",
        message: `${secret.label} is a symbolic link: ${secret.path}`,
        fix: secret.minibaseOwned
          ? "Replace the link with a regular file owned by the Minibase service account."
          : "Confirm the target is trusted, then replace the link with a regular file when practical.",
        file: secret.path,
      });
      continue;
    }
    if (!info.isFile) {
      checks.push({
        code: `${secret.code}.type`,
        severity: "error",
        message: `${secret.label} is not a regular file: ${secret.path}`,
        fix: "Replace it with a regular file and preserve the existing Secret values securely.",
        file: secret.path,
      });
      continue;
    }
    if (Deno.build.os === "windows") {
      try {
        const acl = await inspectWindowsSecretAcl(secret.path);
        if (acl.ownerSid !== acl.currentSid) {
          checks.push({
            code: `${secret.code}.owner`,
            severity: secret.minibaseOwned ? "error" : "warning",
            message: `${secret.label} is not owned by the current Windows account`,
            fix: secret.minibaseOwned
              ? "Set the owner to the Minibase service account, then restart so the loader can harden the ACL."
              : "Move the file to the service account or set that account as its owner.",
            file: secret.path,
          });
        }
        const unauthorizedSids = unauthorizedWindowsAclSids(acl);
        if (!windowsSecretAclIsPrivate(acl)) {
          checks.push({
            code: `${secret.code}.acl`,
            severity: secret.minibaseOwned ? "error" : "warning",
            message: !acl.protected
              ? `${secret.label} inherits Windows permissions instead of using an explicit private ACL`
              : unauthorizedSids.length > 0
              ? `${secret.label} grants Windows access beyond the current account and SYSTEM`
              : `${secret.label} does not grant the required private Windows ACL`,
            fix: secret.minibaseOwned
              ? "Stop Minibase and let the Auth Secret loader replace inherited access with a private ACL."
              : "Disable inherited access and grant only the service account and SYSTEM the required rights.",
            file: secret.path,
          });
        }
      } catch {
        checks.push({
          code: `${secret.code}.acl.inspect`,
          severity: "warning",
          message: `${secret.label} Windows owner and ACL could not be inspected`,
          fix:
            "Ensure Windows PowerShell and Get-Acl are available, then inspect the file manually.",
          file: secret.path,
        });
      }
      continue;
    }
    const currentUid = Deno.uid();
    if (info.uid !== null && info.uid !== currentUid) {
      checks.push({
        code: `${secret.code}.owner`,
        severity: "warning",
        message: `${secret.label} is owned by uid ${info.uid}, not the current uid ${currentUid}`,
        fix: `Change ${secret.path} ownership to the Minibase service account.`,
        file: secret.path,
      });
    }
    if (info.mode !== null && (info.mode & 0o077) !== 0) {
      checks.push({
        code: `${secret.code}.permissions`,
        severity: "warning",
        message: `${secret.label} grants group or other users access: ${secret.path}`,
        fix: `Restrict ${secret.path} to owner-only access, for example chmod 600.`,
        file: secret.path,
      });
    }
  }
  return checks;
}

async function storageConsistencyChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<DiagnosticResult[]> {
  if (config.storage.driver !== "local") return [];
  if (runtime.live) {
    return [{
      code: "storage.consistency.deferred",
      severity: "warning",
      message: "Storage consistency was not checked while Minibase is running",
      fix: "Stop Minibase and rerun doctor for an offline Storage consistency check.",
    }];
  }
  const state = await readProjectState(config.project);
  if (state === null) {
    return [{
      code: "storage.consistency.uninitialized",
      severity: "info",
      message: "Storage consistency is unavailable until the project database is initialized",
    }];
  }
  if (state.engine !== config.database.engine) {
    return [{
      code: "storage.consistency.engine",
      severity: "error",
      message: `Project data uses ${state.engine}, but doctor resolved ${config.database.engine}`,
      fix: `Rerun doctor with --engine ${state.engine}.`,
    }];
  }
  if (
    config.database.engine === "postgres" && config.database.managed &&
    !(await isFile(join(config.project.postgresDataDir, "PG_VERSION")))
  ) {
    return [{
      code: "storage.consistency.database",
      severity: "error",
      message: "Managed PostgreSQL data is not initialized; Storage consistency was not checked",
      fix: "Start Minibase successfully or restore a backup before rerunning doctor.",
    }];
  }

  try {
    const database = await startConfiguredDatabase(config);
    try {
      const report = await checkStorageConsistency(
        database.engine,
        new LocalObjectStore(config.storage.path),
      );
      return storageReportDiagnostics(report);
    } finally {
      await database.close();
    }
  } catch (error) {
    return [{
      code: "storage.consistency.database",
      severity: "error",
      message: `Storage consistency could not be checked: ${errorMessage(error)}`,
      fix: "Verify the database configuration and rerun `minibase storage check --json`.",
    }];
  }
}

function storageReportDiagnostics(report: StorageConsistencyReport): DiagnosticResult[] {
  if (report.ok) {
    return [{
      code: "storage.consistency",
      severity: "info",
      message: "Storage object files and database metadata are consistent",
    }];
  }
  const diagnostics: DiagnosticResult[] = [];
  if (report.missingFiles.length > 0) {
    diagnostics.push({
      code: "storage.consistency.missing_files",
      severity: "error",
      message: `${report.missingFiles.length} Storage metadata rows reference missing files: ${
        summarizeObjects(report.missingFiles)
      }`,
      fix: "Restore the missing files or run `minibase storage repair --force` after a backup.",
    });
  }
  if (report.orphanFiles.length > 0) {
    diagnostics.push({
      code: "storage.consistency.orphan_files",
      severity: "warning",
      message: `${report.orphanFiles.length} untracked Storage files were found: ${
        summarizeObjects(report.orphanFiles)
      }`,
      fix: "Inspect the files, then run `minibase storage repair --force` to delete them.",
    });
  }
  if (report.temporaryFiles.length > 0) {
    diagnostics.push({
      code: "storage.consistency.temporary_files",
      severity: "warning",
      message: `${report.temporaryFiles.length} incomplete Storage files were found: ${
        summarizeObjects(report.temporaryFiles)
      }`,
      fix: "Confirm no upload is running, then run `minibase storage repair --force`.",
    });
  }
  if (report.sizeMismatches.length > 0) {
    diagnostics.push({
      code: "storage.consistency.size_mismatches",
      severity: "error",
      message: `${report.sizeMismatches.length} Storage objects have mismatched sizes: ${
        summarizeObjects(report.sizeMismatches)
      }`,
      fix: "Inspect the objects, then run `minibase storage repair --force` after a backup.",
    });
  }
  return diagnostics;
}

function summarizeObjects(objects: Array<{ bucket: string; name: string }>): string {
  const visible = objects.slice(0, 5).map((object) => `${object.bucket}/${object.name}`);
  if (objects.length > visible.length) visible.push(`and ${objects.length - visible.length} more`);
  return visible.join(", ");
}

const TRACKED_EXTENSIONS = [
  "plpgsql",
  "pgcrypto",
  "uuid-ossp",
  "postgis",
  "pg_net",
  "pg_cron",
] as const;

async function extensionChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<DiagnosticResult[]> {
  const available = await availableExtensions(config, runtime);
  if (available === null) {
    return [{
      code: "database.extensions.unknown",
      severity: "warning",
      message: "PostgreSQL Extension availability could not be determined while Server is offline.",
      fix: "Configure database.runtime_path or start Minibase and rerun doctor.",
    }];
  }
  const extensionSet = new Set(available.map((extension) => extension.toLowerCase()));
  return TRACKED_EXTENSIONS.map((extension) => {
    const present = extensionSet.has(extension);
    return {
      code: `database.extension.${extension}`,
      severity: present ? "info" as const : "warning" as const,
      message: present
        ? `Extension ${extension} is available in ${config.database.engine}.`
        : `Extension ${extension} is unavailable in ${config.database.engine}.`,
      fix: present
        ? undefined
        : "Use a distribution or PostgreSQL Runtime that provides this Extension.",
    };
  });
}

async function availableExtensions(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<string[] | null> {
  if (runtime.live) {
    try {
      const response = await fetch(new URL("/_minibase/capabilities", runtime.state!.apiUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const body = await response.json() as { extensions?: unknown };
      if (
        Array.isArray(body.extensions) &&
        body.extensions.every((extension) => typeof extension === "string")
      ) {
        return body.extensions;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (config.database.engine === "pglite") {
    return offlineMigrationCapabilities("pglite").extensions;
  }
  if (config.database.runtimePath === undefined) return null;
  const extensionDirs = [
    join(config.database.runtimePath, "share", "extension"),
    join(
      config.database.runtimePath,
      "usr",
      "share",
      "postgresql",
      POSTGRES_MAJOR,
      "extension",
    ),
  ];
  const extensions = new Set<string>();
  let foundDirectory = false;
  for (const extensionDir of extensionDirs) {
    try {
      for await (const entry of Deno.readDir(extensionDir)) {
        foundDirectory = true;
        if (entry.isFile && entry.name.endsWith(".control")) {
          extensions.add(entry.name.slice(0, -".control".length));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  return foundDirectory ? [...extensions].sort() : null;
}

async function projectChecks(config: MinibaseConfig): Promise<DiagnosticResult[]> {
  const checks: DiagnosticResult[] = [];
  for (
    const [code, path, required] of [
      ["project.supabase", config.project.supabaseDir, true],
      ["project.migrations", config.project.migrationsDir, false],
      ["project.functions", config.project.functionsDir, false],
    ] as const
  ) {
    const present = await isDirectory(path);
    checks.push({
      code,
      severity: present ? "info" : required ? "error" : "warning",
      message: present ? `${path} is available` : `${path} is not present`,
      fix: present
        ? undefined
        : required
        ? "Create a Supabase project containing a supabase directory."
        : "This directory is optional; create it when the corresponding feature is needed.",
    });
  }

  try {
    await Deno.mkdir(config.project.minibaseDir, { recursive: true });
    const probe = join(config.project.minibaseDir, `.doctor-${crypto.randomUUID()}`);
    await Deno.writeTextFile(probe, "ok");
    await Deno.remove(probe);
    checks.push({
      code: "data.writable",
      severity: "info",
      message: `${config.project.minibaseDir} is writable`,
    });
  } catch (error) {
    checks.push({
      code: "data.writable",
      severity: "error",
      message: `Runtime directory is not writable: ${errorMessage(error)}`,
      fix: "Grant the current user write permission or configure a writable project directory.",
    });
  }

  return checks;
}

async function migrationChecks(config: MinibaseConfig): Promise<DiagnosticResult[]> {
  return await scanMigrationCompatibility(
    config.project,
    offlineMigrationCapabilities(config.database.engine),
  );
}

async function functionChecks(config: MinibaseConfig): Promise<DiagnosticResult[]> {
  if (!(await isDirectory(config.project.functionsDir))) {
    return [];
  }
  const directories = new Set<string>();
  for await (const entry of Deno.readDir(config.project.functionsDir)) {
    if (entry.isDirectory && entry.name !== "_shared" && /^[A-Za-z0-9_-]+$/.test(entry.name)) {
      directories.add(entry.name);
    }
  }
  for (const [name, definition] of Object.entries(config.functions.definitions)) {
    if (definition.entrypoint !== undefined && /^[A-Za-z0-9_-]+$/.test(name)) {
      directories.add(name);
    }
  }
  const resolvedFunctions = await Promise.all(
    [...directories].sort().map(async (name) => ({
      name,
      files: await resolveFunctionFiles(config, name),
    })),
  );
  const lockFiles = [
    ...new Set(
      resolvedFunctions.flatMap(({ files }) =>
        files.lockFile === undefined ? [] : [files.lockFile]
      ),
    ),
  ];
  const checks: DiagnosticResult[] = [{
    code: "functions.lockfile",
    severity: lockFiles.length > 0 ? "info" : "warning",
    message: lockFiles.length > 0
      ? `Edge Function lockfile coverage uses ${lockFiles.join(", ")}`
      : "No Edge Function deno.lock is present",
    fix: lockFiles.length > 0
      ? undefined
      : "Run `deno install` for each Function dependency configuration and commit deno.lock.",
  }];
  const dependenciesCached = await functionDependenciesCached(config);
  checks.push({
    code: "functions.cache",
    severity: dependenciesCached ? "info" : "warning",
    message: dependenciesCached
      ? "Edge Function dependencies are available in the project cache"
      : "One or more Edge Function dependencies are missing from the project cache",
    fix: dependenciesCached
      ? undefined
      : "Run `minibase functions cache --project <path>` while dependencies are reachable.",
  });
  for (const { name, files } of resolvedFunctions) {
    const entryPath = files.entryPath;
    if (await isFile(entryPath)) continue;
    checks.push({
      code: "functions.entrypoint.missing",
      severity: "error",
      message: `Edge Function ${name} is missing its entrypoint: ${entryPath}`,
      fix: `Create ${entryPath} or remove the incomplete function directory.`,
      file: entryPath,
    });
  }
  return checks;
}

async function databaseIntegrityChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<DiagnosticResult[]> {
  if (runtime.live || (config.database.engine === "postgres" && !config.database.managed)) {
    return [];
  }
  let state: Awaited<ReturnType<typeof readProjectState>>;
  try {
    state = await readProjectState(config.project);
  } catch {
    return [{
      code: "database.integrity.state",
      severity: "error",
      message: "Project state metadata is unreadable; doctor left it unchanged",
      fix: "Restore project.json from a trusted backup before starting or resetting Minibase.",
      file: config.project.stateFile,
    }];
  }
  if (state === null || state.engine !== config.database.engine) return [];

  const dataDir = config.database.engine === "pglite"
    ? config.project.pgliteDataDir
    : config.project.postgresDataDir;
  const directory = await pathInfo(dataDir);
  if (directory === null || !directory.isDirectory || directory.isSymlink) {
    return [{
      code: "database.integrity.directory",
      severity: "error",
      message: `Database data path is missing, linked, or not a directory; doctor made no changes`,
      fix: "Restore the complete database data directory from a trusted backup.",
      file: dataDir,
    }];
  }

  const versionFile = join(dataDir, "PG_VERSION");
  const versionInfo = await pathInfo(versionFile);
  if (
    versionInfo === null || !versionInfo.isFile || versionInfo.isSymlink ||
    versionInfo.size < 2 || versionInfo.size > 32
  ) {
    return [corruptDatabaseFile(versionFile, "PG_VERSION is missing or structurally invalid")];
  }
  let major: string;
  try {
    major = (await Deno.readTextFile(versionFile)).trim();
  } catch {
    return [corruptDatabaseFile(versionFile, "PG_VERSION could not be read")];
  }
  if (major !== "18") {
    return [
      corruptDatabaseFile(
        versionFile,
        `database major version ${JSON.stringify(major)} does not match the supported major 18`,
      ),
    ];
  }

  const controlFile = join(dataDir, "global", "pg_control");
  const controlInfo = await pathInfo(controlFile);
  if (
    controlInfo === null || !controlInfo.isFile || controlInfo.isSymlink ||
    controlInfo.size !== 8_192
  ) {
    return [corruptDatabaseFile(controlFile, "pg_control is missing or has an invalid size")];
  }
  return [{
    code: "database.integrity.structure",
    severity: "info",
    message: `Read-only database structure check passed for ${dataDir}; no data files were changed`,
  }];
}

function corruptDatabaseFile(file: string, detail: string): DiagnosticResult {
  return {
    code: "database.integrity.corrupt",
    severity: "error",
    message: `Possible database corruption: ${detail}. Doctor left the data directory unchanged`,
    fix:
      "Preserve the damaged directory for analysis and restore a verified backup; do not reset it in place.",
    file,
  };
}

async function pathInfo(path: string): Promise<
  {
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
    size: number;
  } | null
> {
  try {
    const info = await Deno.lstat(path);
    return {
      isFile: info.isFile,
      isDirectory: info.isDirectory,
      isSymlink: info.isSymlink,
      size: info.size,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function databaseChecks(
  config: MinibaseConfig,
  runtime: RuntimeInspection,
): Promise<DiagnosticResult[]> {
  if (runtime.live) {
    const ready = runtime.checks?.database?.ready;
    if (typeof ready !== "boolean") {
      return [{
        code: "database.health",
        severity: "error",
        message: "Running Minibase did not return a valid database readiness result",
        fix: "Inspect `/health/ready` and the database logs, then restart Minibase if needed.",
      }];
    }
    return [{
      code: "database.health",
      severity: ready ? "info" : "error",
      message: ready ? "Database readiness probe succeeded" : "Database readiness probe failed",
      fix: ready
        ? undefined
        : "Verify the database process or connection, inspect logs, and restore from backup if needed.",
    }];
  }

  const state = await readProjectState(config.project);
  if (state !== null && state.engine !== config.database.engine) {
    return [{
      code: "database.engine",
      severity: "error",
      message: `Project data uses ${state.engine}, but doctor resolved ${config.database.engine}`,
      fix: `Rerun doctor with --engine ${state.engine}.`,
    }];
  }
  if (
    config.database.engine === "postgres" && config.database.managed &&
    config.database.runtimePath === undefined
  ) {
    return [{
      code: "database.runtime",
      severity: "error",
      message: "The managed PostgreSQL Server runtime is not installed",
      fix: "Use the Embedded build or install and configure the matching Server runtime.",
    }];
  }
  if (state === null && !(config.database.engine === "postgres" && !config.database.managed)) {
    return [{
      code: "database.uninitialized",
      severity: "info",
      message: `${config.database.engine} data has not been initialized yet`,
    }];
  }
  if (
    config.database.engine === "postgres" && config.database.managed &&
    !(await isFile(join(config.project.postgresDataDir, "PG_VERSION")))
  ) {
    return [{
      code: "database.health",
      severity: "error",
      message: "Managed PostgreSQL state exists but its data directory is not initialized",
      fix:
        "Restore the PostgreSQL data backup or reset the project after preserving recoverable data.",
    }];
  }

  let database: Awaited<ReturnType<typeof startConfiguredDatabase>> | null = null;
  try {
    database = await startConfiguredDatabase(config);
    const healthy = await database.engine.health();
    return [
      ...await migrationAttemptChecks(database.engine),
      {
        code: "database.health",
        severity: healthy ? "info" : "error",
        message: healthy ? "Database health probe succeeded" : "Database health probe failed",
        fix: healthy
          ? undefined
          : "Verify the database process or connection, inspect logs, and restore from backup if needed.",
      },
    ];
  } catch {
    return [{
      code: "database.health",
      severity: "error",
      message: "Database could not be opened or reached",
      fix: "Verify the database runtime, URL, credentials and logs without sharing Secret values.",
    }];
  } finally {
    await database?.close().catch(() => undefined);
  }
}

async function migrationAttemptChecks(
  engine: Awaited<ReturnType<typeof startConfiguredDatabase>>["engine"],
): Promise<DiagnosticResult[]> {
  const attempts = await inspectMigrationAttempts(engine);
  return attempts.filter((attempt) => attempt.state !== "applied").map((attempt) => {
    if (attempt.transactional) {
      return {
        code: `migration.attempt.${attempt.state}`,
        severity: attempt.state === "running" ? "warning" as const : "error" as const,
        message:
          `Transactional migration ${attempt.version} is ${attempt.state} after attempt ${attempt.attempt}`,
        fix: attempt.state === "running"
          ? "Start Minibase to retry the transaction safely from its unchanged SQL file."
          : "Fix the reported migration error, keep the SQL version unchanged, and start Minibase to retry.",
      };
    }
    return {
      code: `migration.attempt.${attempt.state}`,
      severity: "error" as const,
      message:
        `Non-transactional migration ${attempt.version} is ${attempt.state} after attempt ${attempt.attempt}; ` +
        "automatic replay is blocked to avoid repeating partial SQL",
      fix:
        `Inspect partial database changes, then run minibase migration recover --migration-version ${attempt.version} --force.`,
    };
  });
}

function runtimeChecks(runtime: RuntimeInspection): DiagnosticResult[] {
  if (runtime.state === null) {
    return [{
      code: "runtime.state",
      severity: "info",
      message: "Minibase is not currently running for this project",
    }];
  }
  return [{
    code: "runtime.state",
    severity: runtime.ready ? "info" : "warning",
    message: runtime.ready
      ? `Minibase PID ${runtime.state.pid} is ready`
      : runtime.live
      ? `Minibase PID ${runtime.state.pid} is live but not ready`
      : "runtime.json is stale",
    fix: runtime.ready
      ? undefined
      : runtime.live
      ? "Inspect `/health/ready` component results and runtime logs before restarting Minibase."
      : "Run `minibase stop --force` to remove stale runtime state.",
  }];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
