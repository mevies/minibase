import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PGliteEngine } from "../src/database/pglite.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";

Deno.test("PGlite worker keeps the event loop responsive and enforces query boundaries", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-pglite-worker-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"), { queryTimeoutMs: 2_000 });
  try {
    await engine.start();
    await engine.exec("create table durable_probe(id int primary key)");
    await engine.query("insert into durable_probe(id) values ($1)", [1]);

    let timerFired = false;
    const slow = engine.query("select pg_sleep(0.15)");
    setTimeout(() => {
      timerFired = true;
    }, 20);
    await slow;
    assert(timerFired, "database work blocked the main Deno event loop");

    await assertRejects(
      () => engine.query("select * from generate_series(1, 3)", [], { maxRows: 2 }),
      Error,
      "exceeding the 2 row limit",
    );

    const controller = new AbortController();
    const cancelled = engine.query("select pg_sleep(5)", [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assertRejects(() => cancelled, DOMException, "cancelled");

    const recovered = await engine.query<{ id: number }>("select id from durable_probe");
    assertEquals(recovered.rows, [{ id: 1 }]);

    const crashing = engine.query("select pg_sleep(5)");
    setTimeout(() => engine.terminateWorkerForTest(), 20);
    await assertRejects(() => crashing, Error, "crash-detection test");
    assertEquals(await engine.health(), true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("50 concurrent PGlite request contexts do not leak identities", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-pglite-context-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
    await applyMigrations(engine, project);
    const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
    const observed = await Promise.all(ids.map(async (id) => {
      const result = await engine.withRequestContext(
        { role: "authenticated", claims: { sub: id, role: "authenticated" } },
        (session) => session.query<{ id: string }>("select auth.uid()::text as id"),
      );
      return result.rows[0]!.id;
    }));
    assertEquals(observed, ids);

    await assertRejects(
      () =>
        engine.withRequestContext(
          { role: "authenticated", claims: { sub: ids[0], role: "authenticated" } },
          async (session) => {
            await session.exec("select 1");
            throw new Error("intentional request failure");
          },
        ),
      Error,
      "intentional request failure",
    );
    assertEquals(await engine.health(), true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("PGlite defers unscoped queries that arrive behind a queued transaction begin", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-pglite-queue-test-" });
  const engine = new PGliteEngine(join(temp, "pglite"));
  try {
    await engine.start();
    const project = await discoverProject(join(Deno.cwd(), "fixtures", "supabase-basic"));
    await applyMigrations(engine, project);
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    const work: Array<Promise<string | number>> = [];
    for (const [index, id] of ids.entries()) {
      work.push(engine.withRequestContext(
        { role: "authenticated", claims: { sub: id, role: "authenticated" } },
        async (session) => {
          await session.query("select pg_sleep(0.001)");
          const result = await session.query<{ id: string }>("select auth.uid()::text as id");
          return result.rows[0]!.id;
        },
      ));
      work.push(
        engine.query<{ value: number }>("select $1::int as value", [index])
          .then((result) => result.rows[0]!.value),
      );
    }
    const observed = await Promise.all(work);
    assertEquals(observed.filter((_, index) => index % 2 === 0), ids);
    assertEquals(
      observed.filter((_, index) => index % 2 === 1),
      Array.from({ length: 100 }, (_, index) => index),
    );
    assertEquals(await engine.health(), true);
  } finally {
    await engine.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("PGlite locks its data directory and recovers after a transaction timeout", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-pglite-lock-test-" });
  const dataDir = join(temp, "pglite");
  const warnings: Array<{ event: string; thresholdMs: number }> = [];
  const first = new PGliteEngine(dataDir, {
    longTransactionWarningMs: 20,
    transactionTimeoutMs: 80,
    onLongTransaction: (event) => warnings.push(event),
  });
  const second = new PGliteEngine(dataDir);
  try {
    await first.start();
    await first.exec("create table lock_probe(id int primary key)");
    await assertRejects(
      () => second.start(),
      Error,
      "already locked by another Minibase process",
    );

    await first.transaction(async (session) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await session.query("insert into lock_probe(id) values ($1)", [1]);
    });
    assertEquals(warnings.length, 1);
    assertEquals(warnings[0]?.event, "database_long_transaction");
    assertEquals(warnings[0]?.thresholdMs, 20);

    await assertRejects(
      () => first.transaction(async () => await new Promise((resolve) => setTimeout(resolve, 120))),
      Error,
      "transaction timed out after 80 ms",
    );
    const recovered = await first.query<{ id: number }>("select id from lock_probe order by id");
    assertEquals(recovered.rows, [{ id: 1 }]);

    await first.close();
    await second.start();
    assertEquals(await second.health(), true);
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await Deno.remove(temp, { recursive: true });
  }
});
