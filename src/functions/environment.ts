import { join } from "@std/path";
import type { ProjectPaths } from "../project/types.ts";

const FORWARDED_HOST_ENVIRONMENT = new Set([
  "ALL_PROXY",
  "all_proxy",
  "DENO_CERT",
  "DENO_TLS_CA_STORE",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "SYSTEMROOT",
  "TZ",
  "WINDIR",
]);

const RESERVED_EXACT = new Set([
  "DENO_DIR",
  "DENO_NO_UPDATE_CHECK",
  "MINIBASE_FUNCTION_NETWORK_POLICY",
  "MINIBASE_FUNCTION_PORT",
  "NO_COLOR",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_JWKS",
  "SUPABASE_JWKS_URL",
  "SUPABASE_URL",
]);

const PROCESS_LOADER_ENVIRONMENT = new Set([
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PATH",
  "PATHEXT",
]);

export interface LoadedFunctionEnvironment {
  values: Record<string, string>;
  secretValues: string[];
  files: string[];
  ignoredReserved: string[];
}

export async function loadFunctionEnvironment(
  project: ProjectPaths,
  hostEnvironment: Record<string, string> = Deno.env.toObject(),
): Promise<LoadedFunctionEnvironment> {
  const values: Record<string, string> = {};
  Object.assign(values, forwardedFunctionHostEnvironment(hostEnvironment));

  const files: string[] = [];
  const ignoredReserved = new Set<string>();
  const secretValues = new Set<string>();
  for (const path of [join(project.root, ".env"), join(project.functionsDir, ".env")]) {
    const parsed = await readEnvironmentFile(path);
    if (parsed === null) continue;
    files.push(path);
    for (const [name, value] of Object.entries(parsed)) {
      if (isReservedFunctionEnvironment(name)) {
        ignoredReserved.add(name);
        continue;
      }
      values[name] = value;
      if (value.length > 0) secretValues.add(value);
    }
  }

  return {
    values,
    secretValues: [...secretValues].sort((left, right) => right.length - left.length),
    files,
    ignoredReserved: [...ignoredReserved].sort(),
  };
}

export function forwardedFunctionHostEnvironment(
  hostEnvironment: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(([name]) => FORWARDED_HOST_ENVIRONMENT.has(name)),
  );
}

export function parseFunctionEnvironmentFile(
  contents: string,
  path = ".env",
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.trimStart();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const equals = line.indexOf("=");
    if (equals < 1) throw environmentSyntaxError(path, index, "expected NAME=value");
    const name = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw environmentSyntaxError(path, index, `invalid variable name ${name}`);
    }
    result[name] = parseEnvironmentValue(line.slice(equals + 1), path, index);
  }
  return result;
}

function parseEnvironmentValue(value: string, path: string, lineIndex: number): string {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('"') && !trimmed.startsWith("'")) {
    let end = trimmed.length;
    for (let index = 0; index < trimmed.length; index++) {
      if (trimmed[index] === "#" && (index === 0 || /\s/u.test(trimmed[index - 1]!))) {
        end = index;
        break;
      }
    }
    return trimmed.slice(0, end).trimEnd();
  }

  const quote = trimmed[0]!;
  let escaped = false;
  let parsed = "";
  let closing = -1;
  for (let index = 1; index < trimmed.length; index++) {
    const character = trimmed[index]!;
    if (quote === '"' && escaped) {
      parsed += decodeDoubleQuotedEscape(character);
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      closing = index;
      break;
    }
    parsed += character;
  }
  if (escaped || closing < 0) {
    throw environmentSyntaxError(path, lineIndex, "unterminated quoted value");
  }
  const remainder = trimmed.slice(closing + 1).trimStart();
  if (remainder.length > 0 && !remainder.startsWith("#")) {
    throw environmentSyntaxError(path, lineIndex, "unexpected content after quoted value");
  }
  return parsed;
}

function decodeDoubleQuotedEscape(character: string): string {
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  if (character === '"' || character === "\\") return character;
  return `\\${character}`;
}

function environmentSyntaxError(path: string, lineIndex: number, message: string): Error {
  return new Error(`${path}:${lineIndex + 1}: ${message}`);
}

async function readEnvironmentFile(path: string): Promise<Record<string, string> | null> {
  try {
    return parseFunctionEnvironmentFile(await Deno.readTextFile(path), path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function isReservedFunctionEnvironment(name: string): boolean {
  const normalized = name.toUpperCase();
  return RESERVED_EXACT.has(normalized) || PROCESS_LOADER_ENVIRONMENT.has(normalized) ||
    normalized.startsWith("MINIBASE_");
}
