import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase(
    { auth: "secret", cors: "disabled" },
    async (request, context) =>
      Response.json({
        authMode: context.authMode,
        authKeyName: context.authKeyName,
        body: await request.json(),
      }),
  ),
};
