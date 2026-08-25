export function quoteSqlIdentifier(value: string): string {
  if (value.includes("\0")) {
    throw new Error("PostgreSQL identifiers must not contain NUL bytes");
  }
  return `"${value.replaceAll('"', '""')}"`;
}
