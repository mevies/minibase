import { assert, assertEquals, assertRejects } from "@std/assert";
import type { DatabaseEngine, RequestDatabaseContext } from "../../src/database/contract.ts";

interface ObservedContext {
  database_role: string;
  claim_role: string | null;
  uid: string | null;
}

const authenticatedId = "11111111-1111-4111-8111-111111111111";

export async function assertRequestContextContract(engine: DatabaseEngine): Promise<void> {
  await assertContext(engine, { role: "anon", claims: { role: "anon" } }, {
    database_role: "anon",
    claim_role: "anon",
    uid: null,
  });
  await assertContext(
    engine,
    {
      role: "authenticated",
      claims: { sub: authenticatedId, role: "authenticated" },
    },
    {
      database_role: "authenticated",
      claim_role: "authenticated",
      uid: authenticatedId,
    },
  );
  await assertContext(engine, { role: "service_role", claims: { role: "service_role" } }, {
    database_role: "service_role",
    claim_role: "service_role",
    uid: null,
  });

  const rollbackBody = `rollback-${crypto.randomUUID()}`;
  await assertRejects(
    () =>
      engine.withRequestContext(
        {
          role: "authenticated",
          claims: { sub: authenticatedId, role: "authenticated" },
        },
        async (session) => {
          await session.query(
            "insert into public.notes(owner_id, body) values ($1, $2)",
            [authenticatedId, rollbackBody],
          );
          throw new Error("request-context rollback probe");
        },
      ),
    Error,
    "request-context rollback probe",
  );
  const rolledBack = await engine.withRequestContext(
    { role: "service_role", claims: { role: "service_role" } },
    (session) =>
      session.query<{ count: number }>(
        "select count(*)::int as count from public.notes where body = $1",
        [rollbackBody],
      ),
  );
  assertEquals(rolledBack.rows[0]?.count, 0);

  const cleared = await engine.query<{ database_role: string; claims_cleared: boolean }>(
    `select current_user as database_role,
            nullif(current_setting('request.jwt.claims', true), '') is null as claims_cleared`,
  );
  assert(cleared.rows[0] !== undefined);
  assert(!["anon", "authenticated", "service_role"].includes(cleared.rows[0].database_role));
  assertEquals(cleared.rows[0].claims_cleared, true);
}

async function assertContext(
  engine: DatabaseEngine,
  context: RequestDatabaseContext,
  expected: ObservedContext,
): Promise<void> {
  const observed = await engine.withRequestContext(
    context,
    (session) =>
      session.query<ObservedContext>(
        `select current_user as database_role,
              current_setting('request.jwt.claims', true)::jsonb ->> 'role' as claim_role,
              auth.uid()::text as uid`,
      ),
  );
  assertEquals(observed.rows, [expected]);
}
