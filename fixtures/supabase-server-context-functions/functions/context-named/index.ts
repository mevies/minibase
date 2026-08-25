import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase(
    { auth: "secret:automations", cors: "disabled" },
    (_request, context) => Promise.resolve(Response.json({ authMode: context.authMode })),
  ),
};
