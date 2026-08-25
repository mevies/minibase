import { assert, assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertSupabaseRestContract(
  client: SupabaseClient,
  userId: string,
  displayName: string,
  prefix: string,
): Promise<{ retainedBody: string }> {
  const primaryBody = `${prefix}, primary note`;
  const retainedBody = `${prefix} retained note`;
  const inserted = await client.from("notes").insert({
    owner_id: userId,
    body: primaryBody,
  }).select("id,body").single();
  assertEquals(inserted.error, null);
  assertEquals(inserted.data?.body, primaryBody);

  const retained = await client.from("notes").insert({
    owner_id: userId,
    body: retainedBody,
  }).select("id,body").single();
  assertEquals(retained.error, null);

  const aliased = await client.from("notes")
    .select("id,note_text:body")
    .eq("id", inserted.data!.id)
    .single();
  assertEquals(aliased.error, null);
  assertEquals(aliased.data?.note_text, primaryBody);

  const related = await client.from("notes")
    .select("id,body,owner:profiles(display_name)")
    .eq("id", inserted.data!.id)
    .single();
  assertEquals(related.error, null);
  assertEquals(related.data?.owner as unknown, { display_name: displayName });

  const missing = await client.from("notes")
    .select("id")
    .eq("body", `${prefix} missing`)
    .maybeSingle();
  assertEquals(missing.error, null);
  assertEquals(missing.data, null);

  const filtered = await client.from("notes")
    .select("id,body", { count: "exact" })
    .neq("body", `${prefix} excluded`)
    .gt("id", 0)
    .gte("id", inserted.data!.id)
    .lt("id", retained.data!.id + 10)
    .lte("id", retained.data!.id)
    .like("body", `${prefix}%note`)
    .ilike("body", `${prefix.toUpperCase()}%NOTE`)
    .in("body", [primaryBody, retainedBody])
    .not("body", "is", null)
    .order("id", { ascending: true })
    .limit(10);
  assertEquals(filtered.error, null);
  assertEquals(filtered.count, 2);
  assertEquals(filtered.data?.map((row) => row.body), [primaryBody, retainedBody]);

  const nullBody = await client.from("notes").select("id").is("body", null);
  assertEquals(nullBody.error, null);
  assertEquals(nullBody.data, []);

  const ranged = await client.from("notes")
    .select("id,body", { count: "exact" })
    .in("id", [inserted.data!.id, retained.data!.id])
    .order("id", { ascending: true })
    .range(1, 1);
  assertEquals(ranged.error, null);
  assertEquals(ranged.count, 2);
  assertEquals(ranged.data?.map((row) => row.id), [retained.data!.id]);

  const updated = await client.from("notes")
    .update({ body: `${prefix} updated note` })
    .eq("id", inserted.data!.id)
    .select("id,note_text:body")
    .single();
  assertEquals(updated.error, null);
  assertEquals(updated.data?.note_text, `${prefix} updated note`);

  const upserted = await client.from("notes").upsert({
    id: inserted.data!.id,
    owner_id: userId,
    body: `${prefix} upserted note`,
  }).select("id,body").single();
  assertEquals(upserted.error, null);
  assertEquals(upserted.data?.body, `${prefix} upserted note`);

  const removed = await client.from("notes")
    .delete()
    .eq("id", inserted.data!.id)
    .select("id,body")
    .single();
  assertEquals(removed.error, null);
  assertEquals(removed.data?.body, `${prefix} upserted note`);
  assert(retained.data !== null);
  return { retainedBody };
}
