Deno.serve(async (request) => {
  const body = await request.json().catch(() => null);
  return Response.json({
    body,
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
  });
});
