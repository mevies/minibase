export function formatCliOutput(value: unknown, json: boolean): string {
  return json ? JSON.stringify(value) : formatCliHuman(value);
}

export function formatCliHuman(value: unknown): string {
  return formatValue(value, 0);
}

function formatValue(value: unknown, indentation: number): string {
  if (Array.isArray(value)) return formatArray(value, indentation);
  if (isPlainObject(value)) return formatObject(value, indentation);
  return formatScalar(value);
}

function formatObject(value: Record<string, unknown>, indentation: number): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length === 0) return "{}";
  return entries.map(([key, item]) => {
    const prefix = `${spaces(indentation)}${formatKey(key)}:`;
    if (isCollection(item) && !isEmptyCollection(item)) {
      return `${prefix}\n${formatValue(item, indentation + 2)}`;
    }
    return `${prefix} ${formatValue(item, indentation + 2)}`;
  }).join("\n");
}

function formatArray(value: unknown[], indentation: number): string {
  if (value.length === 0) return "[]";
  return value.map((item) => {
    const prefix = `${spaces(indentation)}-`;
    if (isCollection(item) && !isEmptyCollection(item)) {
      return `${prefix}\n${formatValue(item, indentation + 2)}`;
    }
    return `${prefix} ${formatValue(item, indentation + 2)}`;
  }).join("\n");
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return formatString(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : formatString(
      String(value),
    );
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return String(value);
  return formatString(String(value));
}

function formatString(value: string): string {
  if (
    value.length === 0 || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    ["null", "true", "false", "[]", "{}"].includes(value) ||
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu.test(value)
  ) {
    return quoteString(value);
  }
  return value;
}

function formatKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value) ? value : quoteString(value);
}

function quoteString(value: string): string {
  return JSON.stringify(value).replace(
    /[\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

function isCollection(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) || isPlainObject(value);
}

function isEmptyCollection(value: unknown[] | Record<string, unknown>): boolean {
  return Array.isArray(value)
    ? value.length === 0
    : Object.keys(value).every((key) => value[key] === undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function spaces(count: number): string {
  return " ".repeat(count);
}
