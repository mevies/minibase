import { relative } from "@std/path";

const ROOT = Deno.cwd();
const EXEC_BOUNDARIES = new Map<string, string>([
  ["src/backup/restore.ts", "static restore control SQL and quoted backup identifiers"],
  ["src/database/bootstrap.ts", "compiled-in static system DDL"],
  ["src/database/postgres.ts", "database adapter pass-through"],
  ["src/database/pglite_worker.ts", "database worker pass-through"],
  ["src/migrations/runner.ts", "unchanged project migration and seed scripts"],
]);
const DYNAMIC_SQL_BOUNDARIES = new Map<string, string>([
  ["src/backup/export.ts", "catalog identifiers through quoteSqlIdentifier"],
  ["src/backup/restore.ts", "verified manifest identifiers through quoteSqlIdentifier"],
  ["src/rest/query.ts", "validated identifiers, enumerated grammar and bound values"],
]);
const FORBIDDEN_DYNAMIC_VALUE_PATTERNS = [
  { pattern: /\blimit\s+\$\{limit\}/iu, message: "LIMIT values must use bound parameters" },
  { pattern: /\boffset\s+\$\{offset\}/iu, message: "OFFSET values must use bound parameters" },
  { pattern: /\bset\s+local\s+role\s+\$\{/iu, message: "database roles must use set_config" },
];

const files = await sourceFiles();
const execFiles: string[] = [];
const dynamicSqlFiles = new Set<string>();
const failures: string[] = [];

for (const file of files) {
  const source = await Deno.readTextFile(file);
  const path = relative(ROOT, file).replaceAll("\\", "/");
  if (hasDatabaseExecBoundary(source)) {
    execFiles.push(path);
    if (!EXEC_BOUNDARIES.has(path)) {
      failures.push(`${path}: new exec boundary requires an explicit SQL safety audit`);
    }
  }
  for (const { pattern, message } of FORBIDDEN_DYNAMIC_VALUE_PATTERNS) {
    if (pattern.test(source)) failures.push(`${path}: ${message}`);
  }
  if (
    path !== "src/database/sql.ts" && source.includes("replaceAll('\"', '\"\"')")
  ) {
    failures.push(`${path}: SQL identifier quoting must use quoteSqlIdentifier`);
  }
  for (const template of dynamicTemplates(source)) {
    if (!looksLikeSql(template.staticText)) continue;
    dynamicSqlFiles.add(path);
    if (!DYNAMIC_SQL_BOUNDARIES.has(path)) {
      failures.push(
        `${path}:${template.line}: interpolated SQL template requires an explicit audited boundary`,
      );
    }
  }
}

for (const path of EXEC_BOUNDARIES.keys()) {
  if (!execFiles.includes(path)) failures.push(`${path}: obsolete exec boundary allowlist entry`);
}
for (const path of DYNAMIC_SQL_BOUNDARIES.keys()) {
  if (!dynamicSqlFiles.has(path)) {
    failures.push(`${path}: obsolete dynamic SQL boundary allowlist entry`);
  }
}

if (failures.length > 0) {
  throw new Error(
    `SQL safety audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}

console.log(JSON.stringify({
  ok: true,
  execBoundaries: Object.fromEntries(EXEC_BOUNDARIES),
  dynamicSqlBoundaries: Object.fromEntries(DYNAMIC_SQL_BOUNDARIES),
}));

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  await visit(`${ROOT}/src`);
  return files.sort();
}

interface DynamicTemplate {
  line: number;
  staticText: string;
}

function dynamicTemplates(source: string): DynamicTemplate[] {
  const templates: DynamicTemplate[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '"' || character === "'") {
      index = skipQuoted(source, index, character);
    } else if (character === "`") {
      const template = readTemplate(source, index);
      if (template.dynamic) {
        templates.push({
          line: 1 + source.slice(0, index).split("\n").length - 1,
          staticText: template.staticText,
        });
      }
      index = template.end;
    } else if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
    } else if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
    } else if (character === "/" && isRegexStart(source, index)) {
      index = skipRegex(source, index);
    } else {
      index++;
    }
  }
  return templates;
}

function readTemplate(
  source: string,
  start: number,
): { end: number; dynamic: boolean; staticText: string } {
  let index = start + 1;
  let dynamic = false;
  let staticText = "";
  while (index < source.length) {
    if (source[index] === "\\") {
      staticText += source.slice(index, Math.min(index + 2, source.length));
      index += 2;
    } else if (source[index] === "`") {
      return { end: index + 1, dynamic, staticText };
    } else if (source.startsWith("${", index)) {
      dynamic = true;
      staticText += " ";
      index = skipExpression(source, index + 2);
    } else {
      staticText += source[index];
      index++;
    }
  }
  throw new Error(`Unterminated template literal at offset ${start}`);
}

function skipExpression(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length;) {
    const character = source[index];
    if (character === '"' || character === "'") {
      index = skipQuoted(source, index, character);
    } else if (character === "`") {
      index = readTemplate(source, index).end;
    } else if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
    } else if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
    } else if (character === "/" && isRegexStart(source, index)) {
      index = skipRegex(source, index);
    } else if (character === "{") {
      depth++;
      index++;
    } else if (character === "}") {
      depth--;
      index++;
      if (depth === 0) return index;
    } else {
      index++;
    }
  }
  throw new Error(`Unterminated template expression at offset ${start}`);
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === quote) return index + 1;
  }
  throw new Error(`Unterminated quoted string at offset ${start}`);
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start + 2);
  return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end < 0) throw new Error(`Unterminated block comment at offset ${start}`);
  return end + 2;
}

function isRegexStart(source: string, index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(source[previous]!)) previous--;
  if (previous < 0) return true;
  return "=([{,:;!&|?+*%^~<>".includes(source[previous]!);
}

function skipRegex(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
    } else if (source[index] === "[") {
      inClass = true;
    } else if (source[index] === "]") {
      inClass = false;
    } else if (source[index] === "/" && !inClass) {
      index++;
      while (index < source.length && /[a-z]/iu.test(source[index]!)) index++;
      return index;
    } else if (source[index] === "\n" || source[index] === "\r") {
      throw new Error(`Unterminated regular expression at offset ${start}`);
    }
  }
  throw new Error(`Unterminated regular expression at offset ${start}`);
}

function looksLikeSql(staticText: string): boolean {
  const normalized = staticText.replace(/\s+/gu, " ").trim().toLowerCase();
  return /^(?:select\b|insert\s+into\b|update\b|delete\s+from\b|truncate\s+table\b|create\s+(?:schema|table|extension|index|function|role|policy|trigger|type|sequence|view)\b|alter\s+(?:schema|table|extension|index|function|role|policy|trigger|type|sequence|view)\b|drop\s+(?:schema|table|extension|index|function|role|policy|trigger|type|sequence|view)\b|set\s+(?:local|role|session|transaction)\b|with\b|limit\s+\$|offset\s+\$)/u
    .test(normalized);
}

function hasDatabaseExecBoundary(source: string): boolean {
  return /\b(?:engine|session)\.exec\s*\(/u.test(source) ||
    /(?:\.session\(\)|db\(\)|new\s+PostgresSession\([^\n]*\))\.exec\s*\(/u.test(source);
}
