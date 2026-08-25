import { relative } from "@std/path";
import type { MinibaseConfig } from "../config/types.ts";
import { discoverFunctionNames, resolveFunctionFiles } from "./manager.ts";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

export interface FunctionDocumentation {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: {
      bearerAuth: { type: "http"; scheme: "bearer"; bearerFormat: "JWT" };
    };
  };
}

const METHODS = new Set<HttpMethod>(["get", "post", "put", "patch", "delete", "head"]);

export function createFunctionDocsHandler(
  config: MinibaseConfig,
): (request: Request) => Promise<Response | null> {
  return async (request: Request): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;
    if (
      pathname !== "/functions/v1/docs" && pathname !== "/functions/v1/docs/" &&
      pathname !== "/functions/v1/docs/openapi.json"
    ) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ code: "method_not_allowed", message: "Only GET is supported" }, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    if (pathname.endsWith("/openapi.json")) {
      const document = await createFunctionOpenApiDocument(config, request);
      const body = JSON.stringify(document, null, 2) + "\n";
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }
    return new Response(request.method === "HEAD" ? null : functionDocsHtml(), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  };
}

export async function createFunctionOpenApiDocument(
  config: MinibaseConfig,
  request: Request,
): Promise<FunctionDocumentation> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const name of await discoverFunctionNames(config)) {
    if (name === "_shared" || name === "docs") continue;
    const files = await resolveFunctionFiles(config, name);
    if (!(await isFile(files.entryPath))) continue;
    const methods = detectMethods(await readSource(files.entryPath));
    const verifyJwt = config.functions.definitions[name]?.verifyJwt ?? true;
    const entrypoint = displayEntrypoint(config.project.root, files.entryPath);
    const operations: Record<string, unknown> = {};
    for (const method of methods) {
      const operation: Record<string, unknown> = {
        operationId: `${name}_${method}`,
        summary: name,
        description: [
          `Supabase-compatible Edge Function: ${name}.`,
          `Entrypoint: ${entrypoint}.`,
          `JWT verification: ${verifyJwt ? "required" : "disabled"}.`,
          "Request and response schemas are generic because user code is not executed during documentation generation.",
        ].join(" "),
        security: verifyJwt ? [{ bearerAuth: [] }] : [],
        responses: responseSchemas(verifyJwt),
        "x-minibase": {
          function: name,
          entrypoint,
          verifyJwt,
          hasLockfile: files.lockFile !== undefined,
        },
      };
      if (method === "post" || method === "put" || method === "patch") {
        operation.requestBody = {
          required: false,
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
              example: {},
            },
          },
        };
      }
      operations[method] = operation;
    }
    paths[`/functions/v1/${name}`] = operations;
  }
  return {
    openapi: "3.0.3",
    info: {
      title: `${config.projectId} Edge Functions`,
      version: "1.0.0",
      description:
        "Automatically generated Minibase documentation for Supabase-compatible Edge Functions.",
    },
    servers: [{ url: config.server.publicUrl || new URL(request.url).origin }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
}

function responseSchemas(verifyJwt: boolean): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": { description: "Function response" },
    "400": { description: "Invalid request" },
    "429": { description: "Function rate limit exceeded" },
    "502": { description: "Function runtime error" },
  };
  if (verifyJwt) responses["401"] = { description: "Missing or invalid bearer token" };
  return responses;
}

function detectMethods(source: string): HttpMethod[] {
  const methods = new Set<HttpMethod>();
  const pattern =
    /(?:\b(?:request|req)\.method\s*(?:===|==)|\bcase)\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD)["']/giu;
  for (const match of source.matchAll(pattern)) {
    const method = match[1]?.toLowerCase() as HttpMethod | undefined;
    if (method !== undefined && METHODS.has(method)) methods.add(method);
  }
  if (methods.size === 0) methods.add("post");
  return [...methods].sort((left, right) => methodOrder(left) - methodOrder(right));
}

function methodOrder(method: HttpMethod): number {
  return ["get", "post", "put", "patch", "delete", "head"].indexOf(method);
}

async function readSource(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function displayEntrypoint(projectRoot: string, entryPath: string): string {
  const value = relative(projectRoot, entryPath).replaceAll("\\", "/");
  return value.startsWith("..") ? "configured entrypoint" : value;
}

function functionDocsHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minibase Edge Functions</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { max-width: 1100px; margin: 0 auto; padding: 24px; }
header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.6rem; } a { color: #1677ff; } .muted { opacity: .72; }
.error { color: #d33; white-space: pre-wrap; }
.function { border: 1px solid #8886; border-radius: 8px; margin: 16px 0; padding: 16px; }
.operation { border-top: 1px solid #8884; margin-top: 12px; padding-top: 12px; }
.method { display: inline-block; min-width: 62px; font-weight: 700; }
textarea, input { box-sizing: border-box; width: 100%; margin: 6px 0; padding: 8px; font: inherit; }
textarea { min-height: 80px; resize: vertical; } button { cursor: pointer; padding: 7px 12px; }
pre { overflow: auto; background: #8882; padding: 10px; border-radius: 4px; white-space: pre-wrap; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } @media (max-width: 700px) { .row { grid-template-columns: 1fr; } }
</style></head><body>
<header><div><h1>Minibase Edge Functions</h1><div class="muted">OpenAPI documentation and local request console</div></div>
<a href="/functions/v1/docs/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a></header>
<main id="app"><p class="muted">Loading functions...</p></main>
<script>
const app = document.getElementById("app");
const methods = ["get", "post", "put", "patch", "delete", "head"];
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const render = (spec) => { app.replaceChildren(); const paths = Object.entries(spec.paths || {});
  if (!paths.length) { app.append(el("p", "No Edge Functions were found.")); return; }
  for (const [path, operations] of paths) { const section = el("section"); section.className = "function";
    section.append(el("h2", path.split("/").pop() || path));
    for (const method of methods) { const op = operations[method]; if (!op) continue;
      const block = el("div"); block.className = "operation"; const heading = el("div");
      const label = el("span", method.toUpperCase()); label.className = "method";
      heading.append(label, el("code", path), el("span", op.security && op.security.length ? "  JWT required" : "  Public"));
      block.append(heading, el("p", op.description || "")); const row = el("div"); row.className = "row";
      const token = el("input"); token.type = "password"; token.placeholder = "Bearer token (optional)";
      const body = el("textarea", "{}"); body.placeholder = "JSON request body"; row.append(token, body); block.append(row);
      const button = el("button", "Try it"); const output = el("pre");
      button.addEventListener("click", async () => { button.disabled = true; output.textContent = "Requesting...";
        try { const headers = { "content-type": "application/json" };
          if (token.value.trim()) headers.authorization = token.value.startsWith("Bearer ") ? token.value : "Bearer " + token.value;
          const init = { method: method.toUpperCase(), headers }; if (["post", "put", "patch"].includes(method)) init.body = body.value;
          const response = await fetch(path, init); output.textContent = response.status + " " + response.statusText + "\\n\\n" + await response.text();
        } catch (error) { output.textContent = String(error); } finally { button.disabled = false; }
      }); block.append(button, output); section.append(block);
    } app.append(section);
  }
};
fetch("/functions/v1/docs/openapi.json", { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error("OpenAPI request failed: " + response.status); return response.json(); })
  .then(render).catch((error) => { app.replaceChildren(el("p", String(error))); app.firstChild.className = "error"; });
</script></body></html>`;
}
