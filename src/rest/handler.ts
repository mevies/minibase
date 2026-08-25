import type { DatabaseEngine, QueryRow, RequestDatabaseContext } from "../database/contract.ts";
import {
  buildCountQuery,
  buildDeleteQuery,
  buildInsertQuery,
  buildSelectQuery,
  buildUpdateQuery,
  type ResolvedRelation,
  RestQueryError,
  selectedRelationNames,
} from "./query.ts";

export type RequestContextResolver = (
  request: Request,
) => Promise<RequestDatabaseContext> | RequestDatabaseContext;

export interface RestHandlerDependencies {
  engine: DatabaseEngine;
  resolveContext: RequestContextResolver;
}

function errorResponse(error: unknown, status = 400): Response {
  const candidate = error as { code?: string; detail?: string; hint?: string; message?: string };
  return Response.json(
    {
      code: candidate.code ?? "MINIBASE_REST_ERROR",
      details: candidate.detail ?? null,
      hint: candidate.hint ?? null,
      message: candidate.message ?? String(error),
    },
    { status },
  );
}

function dataResponse(request: Request, rows: QueryRow[], status: number): Response {
  const wantsSingle = request.headers.get("accept")?.includes(
    "application/vnd.pgrst.object+json",
  ) ?? false;
  if (wantsSingle) {
    if (rows.length !== 1) {
      return Response.json(
        {
          code: "PGRST116",
          details: `The result contains ${rows.length} rows`,
          hint: null,
          message: "JSON object requested, multiple (or no) rows returned",
        },
        { status: 406 },
      );
    }
    return Response.json(rows[0], { status });
  }
  return Response.json(rows, { status });
}

function applyRange(request: Request, original: URL): {
  url: URL;
  offset: number;
  limit: number | null;
} {
  const url = new URL(original);
  const range = request.headers.get("range");
  const rangeUnit = request.headers.get("range-unit");
  if (range === null || (rangeUnit !== null && rangeUnit !== "items")) {
    return {
      url,
      offset: Number(url.searchParams.get("offset") ?? 0),
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null,
    };
  }
  const match = /^(\d+)-(\d*)$/u.exec(range.trim());
  if (match === null) {
    throw new Error(`Invalid Range header: ${range}`);
  }
  const offset = Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  url.searchParams.set("offset", String(offset));
  if (end !== null) {
    if (end < offset) {
      throw new Error("Range end must not be smaller than range start");
    }
    url.searchParams.set("limit", String(end - offset + 1));
  }
  return { url, offset, limit: end === null ? null : end - offset + 1 };
}

async function primaryKeyColumns(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await engine.query<{ column_name: string }>(
    `select a.attname as column_name
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     join unnest(i.indkey) with ordinality as keys(attnum, ordinality) on true
     join pg_attribute a on a.attrelid = c.oid and a.attnum = keys.attnum
     where i.indisprimary and n.nspname = $1 and c.relname = $2
     order by keys.ordinality`,
    [schema, table],
  );
  return result.rows.map((row) => row.column_name);
}

function tableFromPath(pathname: string): string | null {
  const prefix = "/rest/v1/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const table = decodeURIComponent(pathname.slice(prefix.length));
  return table.length > 0 && !table.includes("/") ? table : null;
}

interface ForeignKeyRow {
  relation_name: string;
  relation_schema: string;
  source_column: string;
  target_column: string;
  column_count: number;
}

async function loadRelations(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): Promise<ResolvedRelation[]> {
  const result = await engine.query<ForeignKeyRow>(
    `select target.relname as relation_name,
            target_namespace.nspname as relation_schema,
            source_attribute.attname as source_column,
            target_attribute.attname as target_column,
            cardinality(constraint_row.conkey)::int as column_count
     from pg_constraint constraint_row
     join pg_class source on source.oid = constraint_row.conrelid
     join pg_namespace source_namespace on source_namespace.oid = source.relnamespace
     join pg_class target on target.oid = constraint_row.confrelid
     join pg_namespace target_namespace on target_namespace.oid = target.relnamespace
     join lateral unnest(constraint_row.conkey) with ordinality
       as source_key(attnum, position) on true
     join lateral unnest(constraint_row.confkey) with ordinality
       as target_key(attnum, position) on target_key.position = source_key.position
     join pg_attribute source_attribute
       on source_attribute.attrelid = source.oid and source_attribute.attnum = source_key.attnum
     join pg_attribute target_attribute
       on target_attribute.attrelid = target.oid and target_attribute.attnum = target_key.attnum
     where constraint_row.contype = 'f'
       and source_namespace.nspname = $1
       and source.relname = $2
     order by target_namespace.nspname, target.relname, constraint_row.conname,
              source_key.position`,
    [schema, table],
    { maxRows: 500 },
  );
  return result.rows.filter((row) => row.column_count === 1).map((row) => ({
    name: row.relation_name,
    schema: row.relation_schema,
    table: row.relation_name,
    sourceColumn: row.source_column,
    targetColumn: row.target_column,
  }));
}

function resolveRequestedRelations(
  available: ResolvedRelation[],
  requested: string[],
): ResolvedRelation[] {
  return requested.map((name) => {
    const matches = available.filter((relation) => relation.name === name);
    if (matches.length === 0) {
      throw new RestQueryError(
        `No foreign-key relationship from the requested table to ${name}`,
        "PGRST200",
      );
    }
    if (matches.length > 1) {
      throw new RestQueryError(
        `Multiple foreign-key relationships exist for ${name}; relationship hints are required`,
        "PGRST201",
      );
    }
    return matches[0]!;
  });
}

export function createRestHandler(
  dependencies: RestHandlerDependencies,
): (request: Request) => Promise<Response | null> {
  const relationCache = new Map<string, Promise<ResolvedRelation[]>>();
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const table = tableFromPath(url.pathname);
    if (table === null) {
      return null;
    }
    const context = await dependencies.resolveContext(request);
    const schema = request.headers.get("accept-profile") ??
      request.headers.get("content-profile") ??
      "public";

    try {
      if (request.method === "GET") {
        const range = applyRange(request, url);
        const requestedRelations = selectedRelationNames(range.url.searchParams.get("select"));
        const cacheKey = `${schema}.${table}`;
        const availableRelations = requestedRelations.length === 0
          ? []
          : await (relationCache.get(cacheKey) ?? (() => {
            const pending = loadRelations(dependencies.engine, schema, table);
            relationCache.set(cacheKey, pending);
            return pending;
          })());
        const query = buildSelectQuery(
          schema,
          table,
          range.url,
          resolveRequestedRelations(availableRelations, requestedRelations),
        );
        const result = await dependencies.engine.withRequestContext(
          context,
          (session) => session.query(query.sql, query.params),
        );
        const response = dataResponse(request, result.rows, 200);
        response.headers.set("content-profile", schema);
        const wantsCount = request.headers.get("prefer")?.includes("count=exact") ?? false;
        let total = "*";
        if (wantsCount) {
          const countQuery = buildCountQuery(schema, table, range.url);
          const count = await dependencies.engine.withRequestContext(
            context,
            (session) => session.query<{ count: bigint }>(countQuery.sql, countQuery.params),
          );
          total = String(count.rows[0]?.count ?? 0);
        }
        const end = result.rows.length === 0 ? range.offset : range.offset + result.rows.length - 1;
        response.headers.set("content-range", `${range.offset}-${end}/${total}`);
        return response;
      }

      if (request.method === "POST") {
        const input = await request.json() as QueryRow | QueryRow[];
        const preference = request.headers.get("prefer") ?? "";
        const isUpsert = preference.includes("resolution=merge-duplicates") ||
          preference.includes("resolution=ignore-duplicates");
        const requestedConflict = url.searchParams.get("on_conflict")?.split(",").filter(Boolean);
        const conflictColumns = isUpsert
          ? requestedConflict ?? await primaryKeyColumns(dependencies.engine, schema, table)
          : undefined;
        const query = buildInsertQuery(schema, table, input, {
          returning: url.searchParams.get("select"),
          conflictColumns,
          ignoreDuplicates: preference.includes("resolution=ignore-duplicates"),
        });
        const result = await dependencies.engine.withRequestContext(
          context,
          (session) => session.query(query.sql, query.params),
        );
        const wantsRepresentation = request.headers.get("prefer")?.includes(
          "return=representation",
        ) ?? false;
        return wantsRepresentation
          ? dataResponse(request, result.rows, 201)
          : new Response(null, { status: 201 });
      }

      if (request.method === "PATCH") {
        const input = await request.json() as QueryRow;
        const query = buildUpdateQuery(schema, table, input, url);
        const result = await dependencies.engine.withRequestContext(
          context,
          (session) => session.query(query.sql, query.params),
        );
        const wantsRepresentation = request.headers.get("prefer")?.includes(
          "return=representation",
        ) ?? false;
        return wantsRepresentation
          ? dataResponse(request, result.rows, 200)
          : new Response(null, { status: 204 });
      }

      if (request.method === "DELETE") {
        const query = buildDeleteQuery(schema, table, url);
        const result = await dependencies.engine.withRequestContext(
          context,
          (session) => session.query(query.sql, query.params),
        );
        const wantsRepresentation = request.headers.get("prefer")?.includes(
          "return=representation",
        ) ?? false;
        return wantsRepresentation
          ? dataResponse(request, result.rows, 200)
          : new Response(null, { status: 204 });
      }

      return errorResponse(
        new Error(`Method ${request.method} is not supported for REST tables`),
        405,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = code === "42501" ? 403 : 400;
      return errorResponse(error, status);
    }
  };
}
