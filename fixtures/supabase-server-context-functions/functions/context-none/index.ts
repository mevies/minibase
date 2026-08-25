import { withSupabase } from "@supabase/server";

export default {
  fetch: withSupabase(
    { auth: "none", cors: "disabled" },
    (_request, context) =>
      Promise.resolve(Response.json({
        authMode: context.authMode,
        userClaims: context.userClaims,
        jwtClaims: context.jwtClaims,
      })),
  ),
};
