import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildInsertQuery,
  buildSelectQuery,
  RestQueryError,
  selectedRelationNames,
} from "../src/rest/query.ts";

Deno.test("REST query parser supports aliases, relationships and quoted in values", () => {
  const url = new URL(
    'http://localhost/rest/v1/notes?select=note_id:id,body,owner:profiles(display_name)&body=in.("alpha,beta",gamma)',
  );
  assertEquals(selectedRelationNames(url.searchParams.get("select")), ["profiles"]);
  const query = buildSelectQuery("public", "notes", url, [{
    name: "profiles",
    schema: "public",
    table: "profiles",
    sourceColumn: "owner_id",
    targetColumn: "id",
  }]);
  assertStringIncludes(query.sql, '"__root"."id" as "note_id"');
  assertStringIncludes(query.sql, 'as "owner"');
  assertStringIncludes(
    query.sql.replace(/\s+/gu, " "),
    '"__related"."id" = "__root"."owner_id"',
  );
  assertEquals(query.params, ["alpha,beta", "gamma", 1_000]);
  assertStringIncludes(query.sql, " limit $3");
});

Deno.test("REST query parser rejects malicious structure and parameterizes hostile values", () => {
  for (
    const hostile of [
      "' or true --",
      "x); drop table public.notes; --",
      "comma,value",
      "back\\slash",
      "emoji-🧪",
    ]
  ) {
    const url = new URL("http://localhost/rest/v1/notes");
    url.searchParams.set("select", "id,body");
    url.searchParams.set("body", `eq.${hostile}`);
    const query = buildSelectQuery("public", "notes", url);
    assertEquals(query.params, [hostile, 1_000]);
    assertEquals(query.sql.includes(hostile), false);
  }

  const paged = buildSelectQuery(
    "public",
    "notes",
    new URL("http://localhost/rest/v1/notes?select=id&limit=25&offset=50"),
  );
  assertEquals(paged.params, [25, 50]);
  assertStringIncludes(paged.sql, "limit $1 offset $2");
  assertEquals(paged.sql.includes("limit 25"), false);
  assertEquals(paged.sql.includes("offset 50"), false);

  const unsupported = assertThrows(
    () =>
      buildSelectQuery(
        "public",
        "notes",
        new URL("http://localhost/rest/v1/notes?body=contains.payload"),
      ),
    RestQueryError,
    "Unsupported filter operator",
  );
  assertEquals(unsupported.code, "PGRST100");

  assertThrows(
    () =>
      buildSelectQuery(
        "public",
        "notes",
        new URL("http://localhost/rest/v1/notes?select=profiles(notes(id))"),
      ),
    RestQueryError,
    "maximum nesting depth of one",
  );
  assertThrows(
    () =>
      buildSelectQuery(
        "public",
        "notes",
        new URL("http://localhost/rest/v1/notes?select=id&bad%22column=eq.1"),
      ),
    RestQueryError,
    "Invalid identifier",
  );
  const tooMany = Array.from({ length: 101 }, (_, index) => String(index)).join(",");
  const oversized = new URL("http://localhost/rest/v1/notes?select=id");
  oversized.searchParams.set("id", `in.(${tooMany})`);
  assertThrows(
    () => buildSelectQuery("public", "notes", oversized),
    RestQueryError,
    "100 value limit",
  );

  const tooManyFilters = new URL("http://localhost/rest/v1/notes?select=id");
  for (let index = 0; index < 51; index++) {
    tooManyFilters.searchParams.append("id", `neq.${index}`);
  }
  assertThrows(
    () => buildSelectQuery("public", "notes", tooManyFilters),
    RestQueryError,
    "50 filter limit",
  );
  assertThrows(
    () =>
      buildSelectQuery(
        "public",
        "notes",
        new URL("http://localhost/rest/v1/notes?select=id&order=id.asc.nullsfirst.extra"),
      ),
    RestQueryError,
    "Invalid order expression",
  );
  assertThrows(
    () =>
      buildInsertQuery(
        "public",
        "notes",
        Array.from({ length: 1_001 }, (_, id) => ({ id })),
      ),
    RestQueryError,
    "1000 row limit",
  );
});
