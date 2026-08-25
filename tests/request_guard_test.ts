import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { PGliteEngine } from "../src/database/pglite.ts";
import { RequestGuard } from "../src/server/request_guard.ts";

Deno.test("request guard rejects declared and streamed bodies beyond the limit", async () => {
  const guard = new RequestGuard({ maxBodyBytes: 8, timeoutMs: 1_000, maxConcurrent: 2 });
  let calls = 0;
  const declared = await guard.handle(
    new Request("http://localhost/rest/v1/notes", {
      method: "POST",
      headers: { "content-length": "9" },
      body: "123456789",
    }),
    () => {
      calls++;
      return Promise.resolve(new Response(null));
    },
  );
  assertEquals(declared.status, 413);
  assertEquals(calls, 0);

  const streamed = await guard.handle(
    new Request("http://localhost/auth/v1/signup", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("6789"));
          controller.close();
        },
      }),
    }),
    async (request) => {
      calls++;
      try {
        await request.text();
      } catch {
        return Response.json({ code: "downstream_error" }, { status: 400 });
      }
      return new Response(null);
    },
  );
  assertEquals(streamed.status, 413);
  assertEquals((await streamed.json()).code, "request_too_large");
  assertEquals(calls, 1);
});

Deno.test("request guard cancels request bodies ignored by a route", async () => {
  const guard = new RequestGuard({ maxBodyBytes: 8, timeoutMs: 1_000, maxConcurrent: 1 });
  let cancelled = false;
  const response = await guard.handle(
    new Request("http://localhost/auth/v1/logout", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
    () => Promise.resolve(new Response(null, { status: 204 })),
  );
  assertEquals(response.status, 204);
  assertEquals(cancelled, true);
});

Deno.test("request guard holds concurrency until response bodies finish", async () => {
  const guard = new RequestGuard({ maxBodyBytes: 1_024, timeoutMs: 1_000, maxConcurrent: 1 });
  const release = Promise.withResolvers<void>();
  const first = await guard.handle(
    new Request("http://localhost/stream"),
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await release.promise;
              controller.enqueue(new TextEncoder().encode("done"));
              controller.close();
            },
          }),
        ),
      ),
  );
  const overloaded = await guard.handle(
    new Request("http://localhost/second"),
    () => Promise.resolve(new Response("unexpected")),
  );
  assertEquals(overloaded.status, 503);
  assertEquals(overloaded.headers.get("retry-after"), "1");

  release.resolve();
  assertEquals(await first.text(), "done");
  const afterRelease = await guard.handle(
    new Request("http://localhost/third"),
    () => Promise.resolve(new Response(null, { status: 204 })),
  );
  assertEquals(afterRelease.status, 204);
});

Deno.test("request guard aborts timed out handlers and releases their slot", async () => {
  const guard = new RequestGuard({ maxBodyBytes: 1_024, timeoutMs: 20, maxConcurrent: 1 });
  let aborted = false;
  const timedOut = await guard.handle(
    new Request("http://localhost/slow"),
    (request) =>
      new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          resolve(new Response(null));
        }, { once: true });
      }),
  );
  assertEquals(timedOut.status, 504);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(aborted, true);

  const afterTimeout = await guard.handle(
    new Request("http://localhost/healthy"),
    () => Promise.resolve(new Response(null, { status: 204 })),
  );
  assertEquals(afterTimeout.status, 204);
});

Deno.test("request timeouts cancel ambient database queries", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-request-guard-database-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"), { queryTimeoutMs: 5_000 });
  const guard = new RequestGuard({ maxBodyBytes: 1_024, timeoutMs: 20, maxConcurrent: 1 });
  try {
    await engine.start();
    const response = await guard.handle(
      new Request("http://localhost/rest/v1/slow"),
      async () => {
        await engine.query("select pg_sleep(5)");
        return new Response(null);
      },
    );
    assertEquals(response.status, 504);
    assertEquals(await engine.health(), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovered = await guard.handle(
      new Request("http://localhost/health/ready"),
      () => Promise.resolve(Response.json({ ready: true })),
    );
    assertEquals(recovered.status, 200);
    assertEquals((await recovered.json()).ready, true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});
