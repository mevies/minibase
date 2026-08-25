import type { ConfigOverrides, DatabaseEngineName } from "../config/types.ts";

export interface CliArguments {
  command: string;
  project?: string;
  input?: string;
  output?: string;
  kid?: string;
  migrationVersion?: string;
  functionName?: string;
  tail?: number;
  includeStorage: boolean;
  json: boolean;
  help: boolean;
  force: boolean;
  configOverrides: ConfigOverrides;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCliArguments(args: string[]): CliArguments {
  const nestedFunctions = args[0] === "functions" && ["cache", "logs"].includes(args[1] ?? "");
  const nestedStorage = args[0] === "storage" &&
    ["check", "repair", "unlock"].includes(args[1] ?? "");
  const nestedBackup = args[0] === "backup" && ["export", "restore"].includes(args[1] ?? "");
  const nestedMigration = args[0] === "migration" && ["check", "recover"].includes(args[1] ?? "");
  const nestedAuthKeys = args[0] === "auth" && args[1] === "keys" &&
    ["list", "rotate", "activate", "remove"].includes(args[2] ?? "");
  const command = nestedFunctions
    ? `functions:${args[1]}`
    : nestedStorage
    ? `storage:${args[1]}`
    : nestedBackup
    ? `backup:${args[1]}`
    : nestedMigration
    ? `migration:${args[1]}`
    : nestedAuthKeys
    ? `auth:keys:${args[2]}`
    : args[0]?.startsWith("-")
    ? "help"
    : args[0] ?? "help";
  const parsed: CliArguments = {
    command,
    includeStorage: false,
    json: false,
    help: false,
    force: false,
    configOverrides: {},
  };

  const startIndex = nestedAuthKeys
    ? 3
    : nestedFunctions || nestedStorage || nestedBackup || nestedMigration
    ? 2
    : command === "help" && args[0]?.startsWith("-")
    ? 0
    : 1;
  for (let index = startIndex; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--project":
        parsed.project = requireValue(args, index, arg);
        index++;
        break;
      case "--input":
        parsed.input = requireValue(args, index, arg);
        index++;
        break;
      case "--output":
        parsed.output = requireValue(args, index, arg);
        index++;
        break;
      case "--kid":
        parsed.kid = requireValue(args, index, arg);
        index++;
        break;
      case "--migration-version":
        parsed.migrationVersion = requireValue(args, index, arg);
        index++;
        break;
      case "--function":
        parsed.functionName = requireValue(args, index, arg);
        index++;
        break;
      case "--tail": {
        const value = Number(requireValue(args, index, arg));
        if (!Number.isInteger(value) || value < 1 || value > 100_000) {
          throw new Error("--tail must be an integer between 1 and 100000");
        }
        parsed.tail = value;
        index++;
        break;
      }
      case "--include-storage":
        parsed.includeStorage = true;
        break;
      case "--engine": {
        const value = requireValue(args, index, arg);
        if (value !== "pglite" && value !== "postgres") {
          throw new Error("--engine must be pglite or postgres");
        }
        parsed.configOverrides.engine = value as DatabaseEngineName;
        index++;
        break;
      }
      case "--host":
        parsed.configOverrides.host = requireValue(args, index, arg);
        index++;
        break;
      case "--port":
        parsed.configOverrides.port = Number(requireValue(args, index, arg));
        index++;
        break;
      case "--public-url":
        parsed.configOverrides.publicUrl = requireValue(args, index, arg);
        index++;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}
