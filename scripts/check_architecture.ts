export interface RestArchitectureSources {
  app: string;
  handler: string;
  start: string;
}

export interface RestArchitectureAudit {
  ok: true;
  listenerCount: number;
  restFactoryCalls: number;
  restDispatchCalls: number;
  requestContextCalls: number;
  sessionQueryCalls: number;
}

const INTERNAL_TRANSPORT_PATTERNS = [
  { pattern: /\bfetch\s*\(/gu, label: "fetch()" },
  { pattern: /\bDeno\.serve\s*\(/gu, label: "Deno.serve()" },
  { pattern: /\bDeno\.Command\s*\(/gu, label: "Deno.Command()" },
  { pattern: /\bpostgrest\b/giu, label: "PostgREST" },
] as const;

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const result = auditRestArchitecture({
    app: await Deno.readTextFile(new URL("src/server/app.ts", root)),
    handler: await Deno.readTextFile(new URL("src/rest/handler.ts", root)),
    start: await Deno.readTextFile(new URL("src/server/start.ts", root)),
  });
  console.log(JSON.stringify(result));
}

export function auditRestArchitecture(
  sources: RestArchitectureSources,
): RestArchitectureAudit {
  const failures: string[] = [];
  const restFactoryCalls = countMatches(sources.app, /\bcreateRestHandler\s*\(/gu);
  const restDispatchCalls = countMatches(
    sources.app,
    /\bawait\s+restHandler\s*\(\s*request\s*\)/gu,
  );
  const requestContextCalls = countMatches(
    sources.handler,
    /\bdependencies\.engine\.withRequestContext\s*\(/gu,
  );
  const sessionQueryCalls = countMatches(sources.handler, /\bsession\.query(?:<[^>]+>)?\s*\(/gu);
  const listenerCount = countMatches(sources.start, /\bDeno\.serve\s*\(/gu);

  if (
    !/import\s*\{[^}]*\bcreateRestHandler\b[^}]*\}\s*from\s*["']\.\.\/rest\/handler\.ts["']/u
      .test(sources.app)
  ) {
    failures.push(
      "src/server/app.ts: REST must import createRestHandler directly from src/rest/handler.ts",
    );
  }
  if (restFactoryCalls !== 1) {
    failures.push(
      `src/server/app.ts: expected one createRestHandler() call, observed ${restFactoryCalls}`,
    );
  }
  if (
    !/createRestHandler\s*\(\s*\{\s*engine:\s*dependencies\.engine\s*,\s*resolveContext:/u
      .test(sources.app)
  ) {
    failures.push(
      "src/server/app.ts: createRestHandler must receive the in-process DatabaseEngine directly",
    );
  }
  if (restDispatchCalls !== 1) {
    failures.push(
      `src/server/app.ts: expected one direct await restHandler(request) dispatch, observed ${restDispatchCalls}`,
    );
  }
  if (requestContextCalls === 0) {
    failures.push(
      "src/rest/handler.ts: REST operations must enter DatabaseEngine.withRequestContext directly",
    );
  }
  if (sessionQueryCalls === 0) {
    failures.push(
      "src/rest/handler.ts: REST operations must query the request-scoped session directly",
    );
  }
  if (listenerCount !== 1) {
    failures.push(
      `src/server/start.ts: expected exactly one public Deno.serve() listener, observed ${listenerCount}`,
    );
  }
  if (!/return\s+await\s+appHandler\s*\(/u.test(sources.start)) {
    failures.push("src/server/start.ts: the public listener must dispatch directly to appHandler");
  }

  rejectInternalTransport("src/server/app.ts", sources.app, failures);
  rejectInternalTransport("src/rest/handler.ts", sources.handler, failures);
  rejectStartTransport(sources.start, failures);

  if (failures.length > 0) {
    throw new Error(
      `REST architecture audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }

  return {
    ok: true,
    listenerCount,
    restFactoryCalls,
    restDispatchCalls,
    requestContextCalls,
    sessionQueryCalls,
  };
}

function rejectInternalTransport(path: string, source: string, failures: string[]): void {
  for (const { pattern, label } of INTERNAL_TRANSPORT_PATTERNS) {
    const count = countMatches(source, pattern);
    if (count > 0) {
      failures.push(`${path}: ${label} is forbidden in the in-process REST path (${count} found)`);
    }
  }
}

function rejectStartTransport(source: string, failures: string[]): void {
  for (
    const { pattern, label } of INTERNAL_TRANSPORT_PATTERNS.filter(({ label }) =>
      label !== "Deno.serve()"
    )
  ) {
    const count = countMatches(source, pattern);
    if (count > 0) {
      failures.push(
        `src/server/start.ts: ${label} is forbidden before appHandler dispatch (${count} found)`,
      );
    }
  }
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}
