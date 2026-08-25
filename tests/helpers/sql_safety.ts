import { assertEquals, assertThrows } from "@std/assert";
import type { DatabaseEngine } from "../../src/database/contract.ts";
import { quoteSqlIdentifier } from "../../src/database/sql.ts";

const INJECTION_MARKER = "minibase_sql_injected";

export async function assertSqlSafetyContract(engine: DatabaseEngine): Promise<void> {
  assertEquals(quoteSqlIdentifier('safe"name'), '"safe""name"');
  assertThrows(
    () => quoteSqlIdentifier("unsafe\0name"),
    Error,
    "must not contain NUL bytes",
  );

  const schema = `sql_safety_${crypto.randomUUID().replaceAll("-", "")}`;
  const hostileTable = `records" (value text); create table public.${INJECTION_MARKER}(id int); --`;
  const hostileValue = `'); create table public.${INJECTION_MARKER}(id int); --`;
  const qualifiedTable = `${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(hostileTable)}`;
  try {
    await engine.exec(`create schema ${quoteSqlIdentifier(schema)}`);
    await engine.exec(`create table ${qualifiedTable} (value text not null)`);
    await engine.query(`insert into ${qualifiedTable}(value) values ($1)`, [hostileValue]);
    const result = await engine.query<{ value: string }>(
      `select value from ${qualifiedTable}`,
    );
    assertEquals(result.rows, [{ value: hostileValue }]);
    const injection = await engine.query<{ relation: string | null }>(
      "select to_regclass($1)::text as relation",
      [`public.${INJECTION_MARKER}`],
    );
    assertEquals(injection.rows, [{ relation: null }]);
  } finally {
    await engine.exec(`drop schema if exists ${quoteSqlIdentifier(schema)} cascade`);
    await engine.exec(`drop table if exists public.${quoteSqlIdentifier(INJECTION_MARKER)}`);
  }
}
