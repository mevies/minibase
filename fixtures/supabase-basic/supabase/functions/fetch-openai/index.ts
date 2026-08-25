Deno.serve(async (request) => {
  const baseUrl = Deno.env.get("OPENAI_BASE_URL");
  if (baseUrl === undefined) {
    return Response.json({ error: "OPENAI_BASE_URL is missing" }, { status: 500 });
  }
  const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY") ?? ""}`,
    },
    body: request.body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
});
