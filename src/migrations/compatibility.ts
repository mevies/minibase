import { join } from "@std/path";
import type { DatabaseEngineName } from "../config/types.ts";
import type { DatabaseCapabilities, DatabaseEngine } from "../database/contract.ts";
import type { DiagnosticResult } from "../diagnostics/types.ts";
import type { ProjectPaths } from "../project/types.ts";

interface MigrationSource {
  file: string;
  sql: string;
}

export type MigrationCompatibilityCapabilities =
  & Pick<
    DatabaseCapabilities,
    "engine" | "externalConnections" | "extensions" | "logicalReplication"
  >
  & { extensionsKnown?: boolean };

const OFFLINE_CAPABILITIES: Record<DatabaseEngineName, MigrationCompatibilityCapabilities> = {
  pglite: {
    engine: "pglite",
    externalConnections: false,
    extensions: ["plpgsql"],
    extensionsKnown: true,
    logicalReplication: "unavailable",
  },
  postgres: {
    engine: "postgres",
    externalConnections: true,
    extensions: [],
    extensionsKnown: false,
    logicalReplication: "configurable",
  },
};

export function offlineMigrationCapabilities(
  engine: DatabaseEngineName,
): MigrationCompatibilityCapabilities {
  return OFFLINE_CAPABILITIES[engine];
}

const REPLICATION_PATTERNS: Array<{ pattern: RegExp; feature: string }> = [
  { pattern: /\bcreate\s+(?:publication|subscription)\b/giu, feature: "logical replication" },
  {
    pattern: /\bpg_(?:create|drop)_logical_replication_slot\s*\(/giu,
    feature: "replication slots",
  },
  { pattern: /\balter\s+system\s+set\s+wal_level\b/giu, feature: "wal_level" },
];

const NON_TRANSACTIONAL_PATTERNS: Array<{ pattern: RegExp; feature: string }> = [
  { pattern: /\bcreate\s+index\s+concurrently\b/giu, feature: "CREATE INDEX CONCURRENTLY" },
  { pattern: /\bdrop\s+index\s+concurrently\b/giu, feature: "DROP INDEX CONCURRENTLY" },
  { pattern: /\breindex\b[^;]*\bconcurrently\b/giu, feature: "REINDEX CONCURRENTLY" },
  {
    pattern: /\brefresh\s+materialized\s+view\s+concurrently\b/giu,
    feature: "REFRESH MATERIALIZED VIEW CONCURRENTLY",
  },
  { pattern: /\b(?:vacuum|cluster)\b/giu, feature: "VACUUM/CLUSTER" },
  { pattern: /\balter\s+system\b/giu, feature: "ALTER SYSTEM" },
  { pattern: /\b(?:create|drop)\s+database\b/giu, feature: "database-level DDL" },
];

export class MigrationCompatibilityError extends Error {
  override readonly name = "MigrationCompatibilityError";

  constructor(readonly diagnostics: DiagnosticResult[]) {
    const first = diagnostics[0];
    const location = first?.file === undefined
      ? ""
      : first.line === undefined
      ? ` at ${first.file}`
      : first.column === undefined
      ? ` at ${first.file}:${first.line}`
      : ` at ${first.file}:${first.line}:${first.column}`;
    super(
      `Migration compatibility check failed${location}: ${
        first?.message ?? "unknown incompatibility"
      }`,
    );
  }
}

export async function assertMigrationCompatibility(
  engine: DatabaseEngine,
  project: ProjectPaths,
): Promise<void> {
  const capabilities = await engine.capabilities();
  const diagnostics = await scanMigrationCompatibility(project, capabilities);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new MigrationCompatibilityError(errors);
}

export async function scanMigrationCompatibility(
  project: ProjectPaths,
  capabilities: MigrationCompatibilityCapabilities,
): Promise<DiagnosticResult[]> {
  const diagnostics: DiagnosticResult[] = [];
  const extensionsKnown = capabilities.extensionsKnown ?? true;
  const extensionSet = new Set(
    capabilities.extensions.map((extension) => extension.toLowerCase()),
  );

  for (const source of await loadMigrationSources(project)) {
    const scanSql = maskSqlForStaticScan(source.sql);
    const extensionPattern =
      /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([a-z_][\w$-]*))/giu;
    for (const match of scanSql.matchAll(extensionPattern)) {
      const extension = (match[1] ?? match[2]!).toLowerCase();
      if (extensionsKnown && !extensionSet.has(extension)) {
        diagnostics.push(diagnosticAt(source, match.index, {
          code: "migration.extension.unavailable",
          severity: "error",
          message: `Extension ${extension} is unavailable in ${capabilities.engine}.`,
          fix: capabilities.externalConnections
            ? "Install the extension in the Server runtime before applying this migration."
            : "Use the Server distribution or remove the extension requirement.",
        }));
      } else if (!extensionsKnown && ["postgis", "pg_net", "pg_cron"].includes(extension)) {
        diagnostics.push(diagnosticAt(source, match.index, {
          code: "migration.extension.verify",
          severity: "warning",
          message: `Migration requires ${extension}; verify that the Server runtime provides it.`,
          fix: "Run `minibase migration check` with the Server runtime installed.",
        }));
      }
    }

    for (const requirement of REPLICATION_PATTERNS) {
      for (const match of scanSql.matchAll(requirement.pattern)) {
        const unavailable = capabilities.logicalReplication === "unavailable";
        diagnostics.push(diagnosticAt(source, match.index, {
          code: "migration.replication",
          severity: unavailable ? "error" : "warning",
          message: unavailable
            ? `${requirement.feature} is unavailable in ${capabilities.engine}.`
            : `${requirement.feature} requires explicit Server runtime configuration.`,
          fix: unavailable
            ? "Use the Server distribution or remove the replication requirement."
            : "Verify wal_level, replication permissions and deployment topology.",
        }));
      }
    }

    if (!/^\s*--\s*minibase:no-transaction\b/im.test(source.sql)) {
      for (const requirement of NON_TRANSACTIONAL_PATTERNS) {
        const match = requirement.pattern.exec(scanSql);
        requirement.pattern.lastIndex = 0;
        if (match === null) continue;
        diagnostics.push(diagnosticAt(source, match.index, {
          code: "migration.transaction.required",
          severity: "error",
          message: `${requirement.feature} cannot run inside the default migration transaction.`,
          fix:
            "Add `-- minibase:no-transaction` as a standalone migration header after reviewing partial-failure recovery.",
        }));
      }
    }
  }

  if (diagnostics.length === 0) {
    diagnostics.push({
      code: "migration.compatibility",
      severity: "info",
      message: `No known ${capabilities.engine} incompatibilities were detected`,
    });
  }
  return diagnostics;
}

function maskSqlForStaticScan(sql: string): string {
  const output = sql.split("");
  const mask = (index: number): void => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      while (index < sql.length && sql[index] !== "\n") mask(index++);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith("/*", index)) {
          mask(index++);
          mask(index++);
          depth++;
        } else if (sql.startsWith("*/", index)) {
          mask(index++);
          mask(index++);
          depth--;
          if (depth === 0) break;
        } else {
          mask(index++);
        }
      }
      continue;
    }
    if (sql[index] === "'") {
      mask(index++);
      while (index < sql.length) {
        if (sql[index] === "\\" && index + 1 < sql.length) {
          mask(index++);
          mask(index++);
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          mask(index++);
          mask(index++);
        } else if (sql[index] === "'") {
          mask(index++);
          break;
        } else {
          mask(index++);
        }
      }
      continue;
    }
    if (sql[index] === "$") {
      const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/iu.exec(sql.slice(index))?.[0];
      if (delimiter !== undefined) {
        for (let offset = 0; offset < delimiter.length; offset++) mask(index++);
        const end = sql.indexOf(delimiter, index);
        const stop = end < 0 ? sql.length : end + delimiter.length;
        while (index < stop) mask(index++);
        continue;
      }
    }
    index++;
  }
  return output.join("");
}

async function loadMigrationSources(project: ProjectPaths): Promise<MigrationSource[]> {
  try {
    if (!(await Deno.stat(project.migrationsDir)).isDirectory) return [];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const names: string[] = [];
  for await (const entry of Deno.readDir(project.migrationsDir)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(".sql")) names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right));
  return await Promise.all(names.map(async (name) => {
    const file = join(project.migrationsDir, name);
    return { file, sql: await Deno.readTextFile(file) };
  }));
}

function diagnosticAt(
  source: MigrationSource,
  index: number,
  diagnostic: Omit<DiagnosticResult, "file" | "line" | "column">,
): DiagnosticResult {
  const prefix = source.sql.slice(0, index);
  const line = prefix.split("\n").length;
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    ...diagnostic,
    file: source.file,
    line,
    column: prefix.length - lastNewline,
  };
}
