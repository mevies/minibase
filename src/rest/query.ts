import type { QueryRow } from "../database/contract.ts";
import { quoteSqlIdentifier } from "../database/sql.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SELECT_LENGTH = 4_096;
const MAX_SELECTED_FIELDS = 50;
const MAX_FILTER_LENGTH = 4_096;
const MAX_FILTER_DEPTH = 4;
const MAX_FILTERS = 50;
const MAX_IN_VALUES = 100;
const FILTER_OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  ilike: "ilike",
};

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export interface ResolvedRelation {
  name: string;
  schema: string;
  table: string;
  sourceColumn: string;
  targetColumn: string;
}

interface ColumnSelection {
  kind: "column";
  column: string;
  alias?: string;
}

interface WildcardSelection {
  kind: "wildcard";
}

interface RelationSelection {
  kind: "relation";
  relation: string;
  alias?: string;
  columns: Array<ColumnSelection | WildcardSelection>;
}

type Selection = ColumnSelection | WildcardSelection | RelationSelection;

export class RestQueryError extends Error {
  override readonly name = "RestQueryError";

  constructor(message: string, readonly code = "PGRST100") {
    super(message);
  }
}

export function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new RestQueryError(`Invalid identifier: ${value}`);
  }
  return quoteSqlIdentifier(value);
}

export function selectedColumns(value: string | null): string {
  const selections = parseSelections(value);
  return selections.map((selection) => {
    if (selection.kind === "relation") {
      throw new RestQueryError("Relationship selections are only supported for GET requests");
    }
    if (selection.kind === "wildcard") return "*";
    const column = quoteIdentifier(selection.column);
    return selection.alias === undefined
      ? column
      : `${column} as ${quoteIdentifier(selection.alias)}`;
  }).join(", ");
}

export function selectedRelationNames(value: string | null): string[] {
  return parseSelections(value).flatMap((selection) =>
    selection.kind === "relation" ? [selection.relation] : []
  );
}

function selectColumns(value: string | null, relations: ResolvedRelation[]): string {
  const relationMap = new Map(relations.map((relation) => [relation.name, relation]));
  return parseSelections(value).map((selection) => {
    if (selection.kind === "wildcard") return `"__root".*`;
    if (selection.kind === "column") {
      const column = `"__root".${quoteIdentifier(selection.column)}`;
      return selection.alias === undefined
        ? column
        : `${column} as ${quoteIdentifier(selection.alias)}`;
    }
    const relation = relationMap.get(selection.relation);
    if (relation === undefined) {
      throw new RestQueryError(
        `No foreign-key relationship from the requested table to ${selection.relation}`,
        "PGRST200",
      );
    }
    const outputName = selection.alias ?? selection.relation;
    const relatedColumns = selection.columns.map((column) => {
      if (column.kind === "wildcard") return `"__related".*`;
      const sql = `"__related".${quoteIdentifier(column.column)}`;
      return column.alias === undefined ? sql : `${sql} as ${quoteIdentifier(column.alias)}`;
    }).join(", ");
    return `(select row_to_json("__relation_row")
      from (
        select ${relatedColumns}
        from ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)} as "__related"
        where "__related".${quoteIdentifier(relation.targetColumn)} =
              "__root".${quoteIdentifier(relation.sourceColumn)}
        limit 1
      ) as "__relation_row") as ${quoteIdentifier(outputName)}`;
  }).join(", ");
}

function parseSelections(value: string | null): Selection[] {
  if (value === null || value === "*") return [{ kind: "wildcard" }];
  if (value.length > MAX_SELECT_LENGTH) {
    throw new RestQueryError(`select exceeds the ${MAX_SELECT_LENGTH} character limit`);
  }
  const items = splitTopLevel(value);
  if (items.length === 0 || items.length > MAX_SELECTED_FIELDS) {
    throw new RestQueryError(`select must contain between 1 and ${MAX_SELECTED_FIELDS} fields`);
  }
  return items.map(parseSelection);
}

function parseSelection(raw: string): Selection {
  const item = raw.trim();
  if (item === "*") return { kind: "wildcard" };
  const open = item.indexOf("(");
  if (open >= 0) {
    if (!item.endsWith(")") || item.slice(open + 1, -1).includes("(")) {
      throw new RestQueryError("Relationship selections support a maximum nesting depth of one");
    }
    const { alias, name: relation } = parseAlias(item.slice(0, open));
    const columns = splitTopLevel(item.slice(open + 1, -1)).map((column) => {
      const parsed = parseSelection(column);
      if (parsed.kind === "relation") {
        throw new RestQueryError("Relationship selections support a maximum nesting depth of one");
      }
      return parsed;
    });
    if (columns.length === 0) {
      throw new RestQueryError(`Relationship ${relation} must select at least one field`);
    }
    return { kind: "relation", relation, alias, columns };
  }
  const { alias, name: column } = parseAlias(item);
  return { kind: "column", column, alias };
}

function parseAlias(value: string): { alias?: string; name: string } {
  const parts = value.split(":");
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new RestQueryError(`Invalid select field: ${value}`);
  }
  return parts.length === 1 ? { name: parts[0]! } : { alias: parts[0]!, name: parts[1]! };
}

function splitTopLevel(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") {
      depth--;
      if (depth < 0) throw new RestQueryError("Unbalanced select parentheses");
    } else if (value[index] === "," && depth === 0) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (depth !== 0) throw new RestQueryError("Unbalanced select parentheses");
  items.push(value.slice(start));
  if (items.some((item) => item.trim().length === 0)) {
    throw new RestQueryError("select contains an empty field");
  }
  return items;
}

function parseFilter(
  column: string,
  expression: string,
  params: unknown[],
  depth = 0,
): string {
  if (expression.length > MAX_FILTER_LENGTH) {
    throw new RestQueryError(`Filter exceeds the ${MAX_FILTER_LENGTH} character limit`);
  }
  if (depth > MAX_FILTER_DEPTH) {
    throw new RestQueryError(`Filter nesting exceeds the ${MAX_FILTER_DEPTH} level limit`);
  }
  const separator = expression.indexOf(".");
  if (separator < 1) {
    throw new RestQueryError(`Invalid filter for ${column}: ${expression}`);
  }
  const operator = expression.slice(0, separator);
  const value = expression.slice(separator + 1);
  if (operator === "not") {
    return `not (${parseFilter(column, value, params, depth + 1)})`;
  }
  if (operator === "in") {
    const match = /^\((.*)\)$/u.exec(value);
    if (match === null) {
      throw new RestQueryError(`Invalid in filter value: ${value}`);
    }
    const values = parseInValues(match[1]!);
    if (values.length === 0) {
      return "false";
    }
    if (values.length > MAX_IN_VALUES) {
      throw new RestQueryError(`in filter exceeds the ${MAX_IN_VALUES} value limit`);
    }
    const placeholders = values.map((item) => {
      params.push(item);
      return `$${params.length}`;
    });
    return `${quoteIdentifier(column)} in (${placeholders.join(", ")})`;
  }
  if (operator === "is") {
    if (value === "null") {
      return `${quoteIdentifier(column)} is null`;
    }
    if (value === "true" || value === "false") {
      return `${quoteIdentifier(column)} is ${value}`;
    }
    throw new RestQueryError(`Unsupported is filter value: ${value}`);
  }
  const sqlOperator = FILTER_OPERATORS[operator];
  if (sqlOperator === undefined) {
    throw new RestQueryError(`Unsupported filter operator: ${operator}`);
  }
  params.push(value);
  return `${quoteIdentifier(column)} ${sqlOperator} $${params.length}`;
}

function parseInValues(value: string): string[] {
  if (value.length === 0) return [];
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new RestQueryError("Unterminated quoted value in in filter");
  values.push(current);
  return values;
}

function buildWhere(url: URL, params: unknown[]): string {
  const where: string[] = [];
  const reserved = new Set(["select", "order", "limit", "offset", "on_conflict"]);
  const filters = [...url.searchParams].filter(([key]) => !reserved.has(key));
  if (filters.length > MAX_FILTERS) {
    throw new RestQueryError(`Query exceeds the ${MAX_FILTERS} filter limit`);
  }
  for (const [key, value] of filters) {
    where.push(parseFilter(key, value, params));
  }
  return where.length > 0 ? ` where ${where.join(" and ")}` : "";
}

function parseOrder(value: string | null): string {
  if (value === null || value.length === 0) {
    return "";
  }
  const clauses = value.split(",").map((item) => {
    const parts = item.split(".");
    if (parts.length > 3) {
      throw new RestQueryError(`Invalid order expression: ${item}`);
    }
    const [column = "", direction = "asc", nulls] = parts;
    if (direction !== "asc" && direction !== "desc") {
      throw new RestQueryError(`Invalid order direction: ${direction}`);
    }
    const nullsSql = nulls === undefined
      ? ""
      : nulls === "nullsfirst"
      ? " nulls first"
      : nulls === "nullslast"
      ? " nulls last"
      : (() => {
        throw new RestQueryError(`Invalid null ordering: ${nulls}`);
      })();
    return `${quoteIdentifier(column)} ${direction}${nullsSql}`;
  });
  return ` order by ${clauses.join(", ")}`;
}

function parseBoundedInteger(value: string | null, name: string, maximum: number): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new RestQueryError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return parsed;
}

export function buildSelectQuery(
  schema: string,
  table: string,
  url: URL,
  relations: ResolvedRelation[] = [],
): BuiltQuery {
  const params: unknown[] = [];
  const limit = parseBoundedInteger(url.searchParams.get("limit"), "limit", 1_000) ?? 1_000;
  const offset = parseBoundedInteger(url.searchParams.get("offset"), "offset", 1_000_000);
  const where = buildWhere(url, params);
  params.push(limit);
  const limitPlaceholder = `$${params.length}`;
  let offsetClause = "";
  if (offset !== null) {
    params.push(offset);
    offsetClause = ` offset $${params.length}`;
  }
  const sql = [
    `select ${selectColumns(url.searchParams.get("select"), relations)}`,
    ` from ${quoteIdentifier(schema)}.${quoteIdentifier(table)} as "__root"`,
    where,
    parseOrder(url.searchParams.get("order")),
    ` limit ${limitPlaceholder}`,
    offsetClause,
  ].join("");
  return { sql, params };
}

export function buildInsertQuery(
  schema: string,
  table: string,
  input: QueryRow | QueryRow[],
  options: {
    returning?: string | null;
    conflictColumns?: string[];
    ignoreDuplicates?: boolean;
  } = {},
): BuiltQuery {
  const rows = Array.isArray(input) ? input : [input];
  if (rows.length === 0) {
    throw new Error("Insert body must contain at least one row");
  }
  if (rows.length > 1_000) {
    throw new RestQueryError("Insert body exceeds the 1000 row limit");
  }
  const columns = Object.keys(rows[0]!);
  if (columns.length === 0) {
    throw new Error("Insert row must contain at least one column");
  }
  for (const row of rows) {
    const rowColumns = Object.keys(row);
    if (rowColumns.length !== columns.length || !columns.every((column) => column in row)) {
      throw new Error("All inserted rows must contain the same columns");
    }
  }

  const params: unknown[] = [];
  const values = rows.map((row) => {
    const placeholders = columns.map((column) => {
      params.push(row[column]);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  let conflict = "";
  if (options.conflictColumns !== undefined && options.conflictColumns.length > 0) {
    const target = options.conflictColumns.map(quoteIdentifier).join(", ");
    if (options.ignoreDuplicates) {
      conflict = ` on conflict (${target}) do nothing`;
    } else {
      const updates = columns
        .filter((column) => !options.conflictColumns!.includes(column))
        .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`);
      conflict = updates.length === 0
        ? ` on conflict (${target}) do nothing`
        : ` on conflict (${target}) do update set ${updates.join(", ")}`;
    }
  }
  return {
    sql: `insert into ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${
      columns.map(quoteIdentifier).join(", ")
    }) values ${values.join(", ")}${conflict} returning ${
      selectedColumns(options.returning ?? null)
    }`,
    params,
  };
}

export function buildUpdateQuery(
  schema: string,
  table: string,
  input: QueryRow,
  url: URL,
): BuiltQuery {
  const columns = Object.keys(input);
  if (columns.length === 0) {
    throw new Error("Update body must contain at least one column");
  }
  const params: unknown[] = [];
  const assignments = columns.map((column) => {
    params.push(input[column]);
    return `${quoteIdentifier(column)} = $${params.length}`;
  });
  const where = buildWhere(url, params);
  return {
    sql: `update ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
      set ${assignments.join(", ")}${where}
      returning ${selectedColumns(url.searchParams.get("select"))}`,
    params,
  };
}

export function buildDeleteQuery(schema: string, table: string, url: URL): BuiltQuery {
  const params: unknown[] = [];
  const where = buildWhere(url, params);
  return {
    sql: `delete from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${where}
      returning ${selectedColumns(url.searchParams.get("select"))}`,
    params,
  };
}

export function buildCountQuery(schema: string, table: string, url: URL): BuiltQuery {
  const params: unknown[] = [];
  return {
    sql: `select count(*)::bigint as count
      from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${buildWhere(url, params)}`,
    params,
  };
}
