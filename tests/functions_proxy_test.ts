import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { FunctionManager } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "./helpers/tls_fixture.ts";

Deno.test("Edge Function Fetch honors HTTP_PROXY, HTTPS_PROXY and NO_PROXY", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-functions-proxy-test-" });
  const directAbort = new AbortController();
  const directListening = Promise.withResolvers<number>();
  const direct = Deno.serve(
    {
      hostname: "localhost",
      port: 0,
      signal: directAbort.signal,
      onListen: (address) => directListening.resolve(address.port),
    },
    () => new Response("direct-http"),
  );
  const tlsAbort = new AbortController();
  const tlsListening = Promise.withResolvers<number>();
  const tls = Deno.serve(
    {
      hostname: "localhost",
      port: 0,
      cert: TEST_CERTIFICATE,
      key: TEST_PRIVATE_KEY,
      signal: tlsAbort.signal,
      onListen: (address) => tlsListening.resolve(address.port),
    },
    () => new Response("direct-https"),
  );
  const proxy = await TestProxy.start();
  try {
    const functionDir = join(root, "supabase", "functions", "proxy-probe");
    await Deno.mkdir(functionDir, { recursive: true });
    await Deno.writeTextFile(join(functionDir, "index.ts"), FUNCTION_SOURCE);
    const certificatePath = join(root, "localhost-ca.pem");
    await Deno.writeTextFile(certificatePath, TEST_CERTIFICATE);
    const project = await discoverProject(root);
    const config = await loadConfig(project);
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;

    const httpBody = await runProbe(config, {
      PROBE_URL: "http://proxy-http.invalid/probe?through=http-proxy",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "",
    });
    assertEquals(httpBody, "proxied-http");
    assert(proxy.httpTargets.includes("http://proxy-http.invalid/probe?through=http-proxy"));

    const tlsPort = await tlsListening.promise;
    const httpsBody = await runProbe(config, {
      PROBE_URL: `https://localhost:${tlsPort}/through-https-proxy`,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "",
      DENO_CERT: certificatePath,
    });
    assertEquals(httpsBody, "direct-https");
    assert(proxy.connectTargets.includes(`localhost:${tlsPort}`));

    const proxyEventsBeforeBypass = proxy.eventCount;
    const directPort = await directListening.promise;
    const bypassedBody = await runProbe(config, {
      PROBE_URL: `http://localhost:${directPort}/bypassed`,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "localhost",
    });
    assertEquals(bypassedBody, "direct-http");
    assertEquals(proxy.eventCount, proxyEventsBeforeBypass);
  } finally {
    await proxy.close();
    directAbort.abort();
    tlsAbort.abort();
    await Promise.all([direct.finished, tls.finished]);
    await Deno.remove(root, { recursive: true });
  }
});

async function runProbe(
  config: Awaited<ReturnType<typeof loadConfig>>,
  environment: Record<string, string>,
): Promise<string> {
  const manager = new FunctionManager({
    config,
    secrets: { anonKey: "anon-proxy-test", serviceRoleKey: "service-proxy-test" },
    environment,
    requestTimeoutMs: 5_000,
    log: () => undefined,
  });
  try {
    await manager.prepare();
    const response = await manager.invoke(
      "proxy-probe",
      new Request("http://localhost/functions/v1/proxy-probe"),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.text();
  } finally {
    await manager.close();
  }
}

class TestProxy {
  readonly httpTargets: string[] = [];
  readonly connectTargets: string[] = [];
  readonly #connections = new Set<Promise<void>>();
  readonly #acceptTask: Promise<void>;
  #closed = false;

  private constructor(private readonly listener: Deno.TcpListener) {
    this.#acceptTask = this.acceptConnections();
  }

  static async start(): Promise<TestProxy> {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0, transport: "tcp" });
    return await Promise.resolve(new TestProxy(listener));
  }

  get port(): number {
    return (this.listener.addr as Deno.NetAddr).port;
  }

  get eventCount(): number {
    return this.httpTargets.length + this.connectTargets.length;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.listener.close();
    await this.#acceptTask;
    await Promise.allSettled([...this.#connections]);
  }

  private async acceptConnections(): Promise<void> {
    try {
      for await (const connection of this.listener) {
        const task = this.handleConnection(connection).finally(() => {
          this.#connections.delete(task);
        });
        this.#connections.add(task);
      }
    } catch (error) {
      if (!this.#closed || !(error instanceof Deno.errors.BadResource)) throw error;
    }
  }

  private async handleConnection(connection: Deno.TcpConn): Promise<void> {
    try {
      const header = await readHttpHeader(connection);
      const [requestLine = ""] = header.split("\r\n");
      const [method, target] = requestLine.split(" ");
      if (method === "CONNECT" && target !== undefined) {
        this.connectTargets.push(target);
        await this.tunnel(connection, target);
        return;
      }
      if (target === undefined || !target.startsWith("http://")) {
        await writeHttpResponse(connection, 400, "invalid proxy request");
        return;
      }
      this.httpTargets.push(target);
      await writeHttpResponse(connection, 200, "proxied-http");
    } finally {
      try {
        connection.close();
      } catch {
        // A completed pipe may already close the connection.
      }
    }
  }

  private async tunnel(connection: Deno.TcpConn, target: string): Promise<void> {
    const separator = target.lastIndexOf(":");
    if (separator <= 0) {
      await writeHttpResponse(connection, 400, "invalid CONNECT target");
      return;
    }
    const hostname = target.slice(0, separator).replace(/^\[|\]$/gu, "");
    const port = Number(target.slice(separator + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      await writeHttpResponse(connection, 400, "invalid CONNECT port");
      return;
    }
    const upstream = await Deno.connect({ hostname, port });
    await connection.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    await Promise.allSettled([
      connection.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(connection.writable),
    ]);
    try {
      upstream.close();
    } catch {
      // A completed pipe may already close the upstream connection.
    }
  }
}

async function readHttpHeader(connection: Deno.TcpConn): Promise<string> {
  const reader = connection.readable.getReader();
  const decoder = new TextDecoder();
  let header = "";
  try {
    while (!header.includes("\r\n\r\n")) {
      const part = await reader.read();
      if (part.done) throw new Error("Proxy client closed before sending a complete header");
      header += decoder.decode(part.value, { stream: true });
      if (header.length > 64 * 1024) throw new Error("Proxy request header exceeds 64 KiB");
    }
    return header.slice(0, header.indexOf("\r\n\r\n") + 4);
  } finally {
    reader.releaseLock();
  }
}

async function writeHttpResponse(
  connection: Deno.TcpConn,
  status: number,
  body: string,
): Promise<void> {
  const reason = status === 200 ? "OK" : "Bad Request";
  const bytes = new TextEncoder().encode(body);
  await connection.write(
    new TextEncoder().encode(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain\r\ncontent-length: ${bytes.length}\r\nconnection: close\r\n\r\n`,
    ),
  );
  await connection.write(bytes);
}

const FUNCTION_SOURCE = `
Deno.serve(async () => {
  const target = Deno.env.get("PROBE_URL");
  if (target === undefined) return new Response("PROBE_URL is missing", { status: 500 });
  const response = await fetch(target);
  return new Response(response.body, { status: response.status, headers: response.headers });
});
`;
