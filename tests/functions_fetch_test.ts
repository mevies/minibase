import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "./helpers/tls_fixture.ts";

const API_KEY = "fetch-matrix-secret-never-log";
const FIRST_REQUEST_CHUNK_BYTES = 32 * 1024;

Deno.test("Edge Function outbound Fetch covers HTTP semantics, streaming and OpenAI APIs", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-fetch-matrix-test-" });
  const responseGate = Promise.withResolvers<void>();
  const httpAbort = new AbortController();
  const httpsAbort = new AbortController();
  const httpListening = Promise.withResolvers<number>();
  const httpsListening = Promise.withResolvers<number>();
  const functionLogs: string[] = [];
  const handler = createUpstreamHandler(responseGate.promise);
  const http = Deno.serve(
    {
      hostname: "localhost",
      port: 0,
      signal: httpAbort.signal,
      onListen: (address) => httpListening.resolve(address.port),
    },
    handler,
  );
  const https = Deno.serve(
    {
      hostname: "localhost",
      port: 0,
      cert: TEST_CERTIFICATE,
      key: TEST_PRIVATE_KEY,
      signal: httpsAbort.signal,
      onListen: (address) => httpsListening.resolve(address.port),
    },
    handler,
  );
  let manager: FunctionManager | null = null;
  try {
    const functionsDir = join(root, "supabase", "functions", "fetch-matrix");
    await Deno.mkdir(functionsDir, { recursive: true });
    await Deno.writeTextFile(join(functionsDir, "index.ts"), FUNCTION_SOURCE);
    const certificatePath = join(root, "localhost-ca.pem");
    await Deno.writeTextFile(certificatePath, TEST_CERTIFICATE);

    const project = await discoverProject(root);
    const config = await loadConfig(project);
    assertEquals(config.functions.outbound, "allow");
    manager = new FunctionManager({
      config,
      secrets: { anonKey: "anon-fetch-test", serviceRoleKey: "service-fetch-test" },
      environment: {
        FETCH_HTTP_BASE: `http://localhost:${await httpListening.promise}`,
        FETCH_HTTPS_BASE: `https://localhost:${await httpsListening.promise}`,
        FETCH_API_KEY: API_KEY,
        DENO_CERT: certificatePath,
      },
      log: (_stream, line) => functionLogs.push(line),
    });
    await manager.prepare();

    const methodCases = [
      { method: "GET", bodyKind: "none" },
      { method: "POST", bodyKind: "json" },
      { method: "PUT", bodyKind: "text" },
      { method: "PATCH", bodyKind: "binary" },
      { method: "DELETE", bodyKind: "text" },
    ] as const;
    for (const item of methodCases) {
      const response = await invoke(manager, {
        mode: "echo",
        method: item.method,
        bodyKind: item.bodyKind,
      });
      const body = await response.json() as EchoResponse;
      assertEquals(body.method, item.method);
      assertEquals(body.authorization, `Bearer ${API_KEY}`);
      assertEquals(body.customHeader, "minibase-fetch-matrix");
      if (item.bodyKind === "json") assertEquals(JSON.parse(body.text), { compatible: true });
      if (item.bodyKind === "text") assertEquals(body.text, "plain-text-你好");
      if (item.bodyKind === "binary") assertEquals(body.bytes, [0, 1, 2, 127, 128, 255]);
    }

    const form = await invokeJson(manager, { mode: "echo", method: "POST", bodyKind: "form" });
    assertEquals(form.form, {
      field: "form-value",
      filename: "payload.bin",
      fileType: "application/octet-stream",
      fileBytes: [9, 8, 7, 0, 255],
    });

    const redirected = await invokeJson(manager, { mode: "redirect", method: "GET" });
    assertEquals(redirected.path, "/echo?redirected=true");

    const httpsEcho = await invokeJson(manager, {
      mode: "echo",
      method: "POST",
      bodyKind: "json",
      tls: true,
    });
    assertEquals(httpsEcho.secure, true);
    assertEquals(JSON.parse(String(httpsEcho.text)), { compatible: true });

    const reused = await invokeJson(manager, { mode: "reuse" });
    assert(Array.isArray(reused.ports));
    assertEquals(reused.ports.length, 2);
    assertEquals(reused.ports[0], reused.ports[1]);

    const streamedRequest = await invokeJson(manager, { mode: "stream-request" });
    assertEquals(streamedRequest.firstBytes, FIRST_REQUEST_CHUNK_BYTES);
    assertEquals(streamedRequest.totalBytes, FIRST_REQUEST_CHUNK_BYTES + 4);
    assert(Number(streamedRequest.gapMs) >= 120, `request gap was ${streamedRequest.gapMs} ms`);

    const streamedResponse = await invoke(manager, { mode: "stream-response" });
    assert(streamedResponse.body);
    const reader = streamedResponse.body.getReader();
    const first = await reader.read();
    assertEquals(first.done, false);
    assertStringIncludes(new TextDecoder().decode(first.value), "first-chunk");
    responseGate.resolve();
    let remainder = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      remainder += new TextDecoder().decode(next.value);
    }
    assertStringIncludes(remainder, "second-chunk");

    const chat = await invokeJson(manager, {
      mode: "openai-chat",
      payload: { model: "test-chat", messages: [{ role: "user", content: "hello" }] },
    });
    assertEquals(chat.object, "chat.completion");
    assertEquals(chat.model, "test-chat");

    const responses = await invokeJson(manager, {
      mode: "openai-responses",
      payload: { model: "test-responses", input: "hello" },
    });
    assertEquals(responses.object, "response");
    assertEquals(responses.model, "test-responses");

    const sse = await invoke(manager, {
      mode: "openai-sse",
      payload: { model: "test-stream", messages: [] },
    });
    assertStringIncludes(sse.headers.get("content-type") ?? "", "text/event-stream");
    const sseBody = await sse.text();
    assertStringIncludes(sseBody, 'data: {"delta":"hello"}');
    assertStringIncludes(sseBody, "data: [DONE]");

    const secretFailure = await manager.invoke(
      "fetch-matrix",
      new Request("http://localhost/functions/v1/fetch-matrix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "log-secret" }),
      }),
    );
    assertEquals(secretFailure.status, 500);
    await secretFailure.body?.cancel();
    await waitFor(() => functionLogs.some((line) => line.includes("[REDACTED]")));
    assertEquals(functionLogs.join("\n").includes(API_KEY), false);
  } finally {
    responseGate.resolve();
    await manager?.close();
    httpAbort.abort();
    httpsAbort.abort();
    await Promise.all([http.finished, https.finished]);
    await Deno.remove(root, { recursive: true });
  }
});

function createUpstreamHandler(responseGate: Promise<void>) {
  return async (request: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/redirect") {
      return new Response(null, { status: 307, headers: { location: "/echo?redirected=true" } });
    }
    if (url.pathname === "/connection") {
      return Response.json({ port: (info.remoteAddr as Deno.NetAddr).port });
    }
    if (url.pathname === "/stream-request") {
      assert(request.body);
      const reader = request.body.getReader();
      let firstBytes = 0;
      while (firstBytes < FIRST_REQUEST_CHUNK_BYTES) {
        const part = await reader.read();
        if (part.done) throw new Error("streaming request ended before its first chunk completed");
        firstBytes += part.value.byteLength;
      }
      const firstCompleteAt = performance.now();
      let totalBytes = firstBytes;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.byteLength;
      }
      return Response.json({
        firstBytes,
        totalBytes,
        gapMs: performance.now() - firstCompleteAt,
      });
    }
    if (url.pathname === "/stream-response") {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("first-chunk"));
            await responseGate;
            controller.enqueue(encoder.encode("second-chunk"));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    }
    if (url.pathname === "/v1/chat/completions") {
      assertEquals(request.headers.get("authorization"), `Bearer ${API_KEY}`);
      const input = await request.json() as { model: string; stream?: boolean };
      if (input.stream) {
        return new Response('data: {"delta":"hello"}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "chatcmpl_test",
        object: "chat.completion",
        model: input.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
      });
    }
    if (url.pathname === "/v1/responses") {
      assertEquals(request.headers.get("authorization"), `Bearer ${API_KEY}`);
      const input = await request.json() as { model: string };
      return Response.json({
        id: "resp_test",
        object: "response",
        model: input.model,
        output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      });
    }

    const contentType = request.headers.get("content-type") ?? "";
    let text = "";
    let bytes: number[] = [];
    let form: Record<string, unknown> | null = null;
    if (contentType.startsWith("multipart/form-data")) {
      const data = await request.formData();
      const file = data.get("file");
      assert(file instanceof File);
      form = {
        field: data.get("field"),
        filename: file.name,
        fileType: file.type,
        fileBytes: [...new Uint8Array(await file.arrayBuffer())],
      };
    } else {
      const raw = new Uint8Array(await request.arrayBuffer());
      bytes = [...raw];
      text = new TextDecoder().decode(raw);
    }
    return Response.json({
      method: request.method,
      path: url.pathname + url.search,
      secure: url.protocol === "https:",
      authorization: request.headers.get("authorization"),
      customHeader: request.headers.get("x-minibase-fetch"),
      contentType,
      text,
      bytes,
      form,
    });
  };
}

async function invoke(manager: FunctionManager, input: Record<string, unknown>): Promise<Response> {
  const response = await manager.invoke(
    "fetch-matrix",
    new Request("http://localhost/functions/v1/fetch-matrix", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`Function returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function invokeJson(
  manager: FunctionManager,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await (await invoke(manager, input)).json();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for redacted Function logs");
}

interface EchoResponse {
  method: string;
  authorization: string | null;
  customHeader: string | null;
  text: string;
  bytes: number[];
}

const FUNCTION_SOURCE = `
const FIRST_CHUNK_BYTES = ${FIRST_REQUEST_CHUNK_BYTES};

Deno.serve(async (request) => {
  const input = await request.json();
  const httpBase = Deno.env.get("FETCH_HTTP_BASE");
  const httpsBase = Deno.env.get("FETCH_HTTPS_BASE");
  const apiKey = Deno.env.get("FETCH_API_KEY");
  if (httpBase === undefined || httpsBase === undefined || apiKey === undefined) {
    return Response.json({ error: "fetch matrix environment is incomplete" }, { status: 500 });
  }
  const base = input.tls === true ? httpsBase : httpBase;
  const headers = new Headers({
    authorization: \`Bearer \${apiKey}\`,
    "x-minibase-fetch": "minibase-fetch-matrix",
  });

  if (input.mode === "log-secret") {
    console.log(\`stdout-secret:\${apiKey}\`);
    console.error(\`stderr-secret:\${apiKey}\`);
    throw new Error(\`thrown-secret:\${apiKey}\`);
  }

  if (input.mode === "reuse") {
    const first = await fetch(\`\${base}/connection\`);
    const firstBody = await first.json();
    const second = await fetch(\`\${base}/connection\`);
    const secondBody = await second.json();
    return Response.json({ ports: [firstBody.port, secondBody.port] });
  }

  let path = "/echo";
  let method = input.method ?? "POST";
  let body;
  if (input.mode === "redirect") path = "/redirect";
  if (input.mode === "stream-request") {
    path = "/stream-request";
    method = "POST";
    headers.set("content-type", "application/octet-stream");
    let phase = 0;
    body = new ReadableStream({
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(new Uint8Array(FIRST_CHUNK_BYTES).fill(65));
          return;
        }
        if (phase === 1) {
          phase = 2;
          await new Promise((resolve) => setTimeout(resolve, 200));
          controller.enqueue(new Uint8Array([66, 67, 68, 69]));
          controller.close();
        }
      },
    });
  } else if (input.mode === "stream-response") {
    path = "/stream-response";
    method = "GET";
  } else if (input.mode === "openai-chat" || input.mode === "openai-sse") {
    path = "/v1/chat/completions";
    method = "POST";
    headers.set("content-type", "application/json");
    body = JSON.stringify({ ...input.payload, stream: input.mode === "openai-sse" });
  } else if (input.mode === "openai-responses") {
    path = "/v1/responses";
    method = "POST";
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.payload);
  } else if (input.bodyKind === "json") {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ compatible: true });
  } else if (input.bodyKind === "text") {
    headers.set("content-type", "text/plain; charset=utf-8");
    body = "plain-text-你好";
  } else if (input.bodyKind === "binary") {
    headers.set("content-type", "application/octet-stream");
    body = new Uint8Array([0, 1, 2, 127, 128, 255]);
  } else if (input.bodyKind === "form") {
    const form = new FormData();
    form.set("field", "form-value");
    form.set(
      "file",
      new File([new Uint8Array([9, 8, 7, 0, 255])], "payload.bin", {
        type: "application/octet-stream",
      }),
    );
    body = form;
  }

  const upstream = await fetch(\`\${base}\${path}\`, { method, headers, body });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
});
`;
