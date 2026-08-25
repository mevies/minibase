import {
  assertNetworkUrlAllowed,
  FunctionNetworkPolicyError,
  type RuntimeNetworkPolicy,
} from "./network_policy.ts";

const entryPath = Deno.args[0];
const port = Number(Deno.env.get("MINIBASE_FUNCTION_PORT"));
const networkPolicy = JSON.parse(
  Deno.env.get("MINIBASE_FUNCTION_NETWORK_POLICY") ?? "null",
) as RuntimeNetworkPolicy | null;

if (entryPath === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Function worker requires an entry path and MINIBASE_FUNCTION_PORT");
}
if (networkPolicy === null) {
  throw new Error("Function worker requires MINIBASE_FUNCTION_NETWORK_POLICY");
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!networkPolicy.blockPrivateNetworks) {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input
      : new URL(input);
    await assertNetworkUrlAllowed(networkPolicy, url);
    return await originalFetch(input, init);
  }
  return await hardenedFetch(originalFetch, networkPolicy, input, init);
}) as typeof fetch;

async function hardenedFetch(
  fetchImplementation: typeof fetch,
  policy: RuntimeNetworkPolicy,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const requestedRedirect = init?.redirect ??
    (input instanceof Request ? input.redirect : "follow");
  if (requestedRedirect !== "follow") {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input
      : new URL(input);
    await assertNetworkUrlAllowed(policy, url);
    return await fetchImplementation(input, init);
  }
  let request = new Request(input, init);
  for (let redirects = 0; redirects <= 20; redirects++) {
    await assertNetworkUrlAllowed(policy, request.url);
    const response = await fetchImplementation(request, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    if (redirects === 20) {
      await response.body?.cancel();
      throw new FunctionNetworkPolicyError("Outbound fetch exceeded 20 redirects");
    }
    const nextUrl = new URL(location, request.url);
    const rewriteToGet = response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST");
    if (!rewriteToGet && request.method !== "GET" && request.method !== "HEAD") {
      await response.body?.cancel();
      throw new FunctionNetworkPolicyError(
        `Private-network hardening refuses a body-preserving ${response.status} redirect`,
      );
    }
    const headers = new Headers(request.headers);
    if (nextUrl.origin !== new URL(request.url).origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    if (rewriteToGet) {
      headers.delete("content-encoding");
      headers.delete("content-language");
      headers.delete("content-location");
      headers.delete("content-type");
    }
    await response.body?.cancel();
    request = new Request(nextUrl, {
      method: rewriteToGet && request.method !== "HEAD" ? "GET" : request.method,
      headers,
      signal: request.signal,
    });
  }
  throw new FunctionNetworkPolicyError("Outbound fetch redirect handling failed");
}

const originalServe = Deno.serve.bind(Deno);
let serverStarted = false;

const compatibleServe = ((first: unknown, second?: unknown) => {
  if (serverStarted) {
    throw new Error("A Minibase Edge Function may call Deno.serve only once");
  }
  serverStarted = true;
  const handler = typeof first === "function" ? first : second;
  const options = typeof first === "object" && first !== null ? first : {};
  if (typeof handler !== "function") {
    throw new Error("Deno.serve requires a request handler");
  }
  return originalServe(
    {
      ...options,
      hostname: "127.0.0.1",
      port,
      onListen: () => console.log(`MINIBASE_FUNCTION_READY:${port}`),
    },
    handler as Deno.ServeHandler,
  );
}) as typeof Deno.serve;

Object.defineProperty(Deno, "serve", {
  configurable: true,
  enumerable: true,
  value: compatibleServe,
});

const loaded = await import(new URL(`file:///${entryPath.replaceAll("\\", "/")}`).href);

if (!serverStarted) {
  const exported = loaded.default as unknown;
  const fetchHandler = typeof exported === "function"
    ? exported
    : typeof exported === "object" && exported !== null &&
        typeof (exported as { fetch?: unknown }).fetch === "function"
    ? (exported as {
      fetch: (
        request: Request,
        info: Deno.ServeHandlerInfo,
      ) => Response | Promise<Response>;
    }).fetch.bind(exported)
    : null;
  if (fetchHandler === null) {
    throw new Error("Function module must call Deno.serve or export a default fetch handler");
  }
  originalServe(
    {
      hostname: "127.0.0.1",
      port,
      onListen: () => console.log(`MINIBASE_FUNCTION_READY:${port}`),
    },
    (request, info) => fetchHandler(request, info),
  );
  serverStarted = true;
}
