import { PGlite } from "@electric-sql/pglite";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";

const probeRoot = await Deno.makeTempDir({ prefix: "minibase-pglite-probe-" });
const dataDir = join(probeRoot, "data");
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

try {
  const db = new PGlite(dataDir);
  await db.waitReady;

  const version = await db.query<{ version: string }>("select version() as version");
  console.log(version.rows[0]?.version);

  await db.exec(`
    create schema auth;

    create function auth.uid()
    returns uuid
    language sql
    stable
    as $function$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $function$;

    create role authenticated nologin;

    create table public.probe_items (
      id serial primary key,
      owner_id uuid not null,
      value text not null,
      normalized_value text
    );

    create function public.probe_normalize()
    returns trigger
    language plpgsql
    as $function$
    begin
      new.normalized_value := upper(new.value);
      return new;
    end
    $function$;

    create trigger normalize_probe_item
    before insert or update on public.probe_items
    for each row execute function public.probe_normalize();

    insert into public.probe_items(owner_id, value)
    values
      ('${ownerId}', 'visible'),
      ('${otherId}', 'hidden');

    alter table public.probe_items enable row level security;
    grant usage on schema public to authenticated;
    grant select on public.probe_items to authenticated;

    create policy owner_can_read
    on public.probe_items
    for select
    to authenticated
    using (auth.uid() = owner_id);
  `);

  await db.exec("begin");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
  await db.exec("set local role authenticated");
  const visibleRows = await db.query<{ normalized_value: string }>(
    "select normalized_value from public.probe_items order by id",
  );
  await db.exec("rollback");

  assertEquals(visibleRows.rows, [{ normalized_value: "VISIBLE" }]);
  await db.close();

  const reopened = new PGlite(dataDir);
  await reopened.waitReady;
  const persisted = await reopened.query<{ count: number }>(
    "select count(*)::int as count from public.probe_items",
  );
  assertEquals(persisted.rows, [{ count: 2 }]);
  await reopened.close();

  console.log(
    JSON.stringify({
      ok: true,
      persistence: true,
      plpgsql: true,
      trigger: true,
      rls: true,
    }),
  );
} finally {
  await Deno.remove(probeRoot, { recursive: true });
}
