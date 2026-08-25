import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  auditRestArchitecture,
  type RestArchitectureSources,
} from "../scripts/check_architecture.ts";

const repositorySources: RestArchitectureSources = {
  app: await Deno.readTextFile(new URL("../src/server/app.ts", import.meta.url)),
  handler: await Deno.readTextFile(new URL("../src/rest/handler.ts", import.meta.url)),
  start: await Deno.readTextFile(new URL("../src/server/start.ts", import.meta.url)),
};

Deno.test("REST architecture stays on one in-process HTTP-to-database path", () => {
  const result = auditRestArchitecture(repositorySources);

  assertEquals(result.ok, true);
  assertEquals(result.listenerCount, 1);
  assertEquals(result.restFactoryCalls, 1);
  assertEquals(result.restDispatchCalls, 1);
  assertEquals(result.requestContextCalls > 0, true);
  assertEquals(result.sessionQueryCalls > 0, true);
});

Deno.test("REST architecture rejects an internal HTTP dispatch", () => {
  const error = assertThrows(
    () =>
      auditRestArchitecture({
        ...repositorySources,
        app: repositorySources.app.replace(
          "await restHandler(request)",
          'await fetch(new URL("/rest/v1/items", request.url))',
        ),
      }),
    Error,
  );

  assertStringIncludes(error.message, "expected one direct await restHandler(request) dispatch");
  assertStringIncludes(error.message, "fetch() is forbidden");
});

Deno.test("REST architecture rejects a PostgREST subprocess boundary", () => {
  const error = assertThrows(
    () =>
      auditRestArchitecture({
        ...repositorySources,
        handler: `${repositorySources.handler}\nnew Deno.Command("postgrest");\n`,
      }),
    Error,
  );

  assertStringIncludes(error.message, "Deno.Command() is forbidden");
  assertStringIncludes(error.message, "PostgREST is forbidden");
});

Deno.test("REST architecture rejects a second server listener", () => {
  const error = assertThrows(
    () =>
      auditRestArchitecture({
        ...repositorySources,
        start: `${repositorySources.start}\nDeno.serve(() => new Response());\n`,
      }),
    Error,
  );

  assertStringIncludes(error.message, "expected exactly one public Deno.serve() listener");
});
