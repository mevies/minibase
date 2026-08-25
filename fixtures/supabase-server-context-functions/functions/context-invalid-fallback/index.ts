import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase(
    { auth: ["user", "none"], cors: "disabled" },
    (_request, context) => Promise.resolve(Response.json({ authMode: context.authMode })),
  ),
};
