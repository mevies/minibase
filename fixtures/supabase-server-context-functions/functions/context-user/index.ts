import { withSupabase } from "@supabase/server";

interface ContextDatabase {
  public: {
    Tables: {
      notes: {
        Row: { body: string };
        Insert: { body: string; owner_id: string };
        Update: { body?: string; owner_id?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export default {
  fetch: withSupabase<ContextDatabase>(
    { auth: "user", cors: "disabled" },
    async (request, context) => {
      const input = await request.json() as { prefix: string };
      const [authUser, userNotes, adminNotes, userObjects, adminObjects, invoke] = await Promise
        .all([
          context.supabase.auth.getUser(),
          context.supabase.from("notes").select("body").like("body", `${input.prefix}-%`).order(
            "body",
          ),
          context.supabaseAdmin.from("notes").select("body").like(
            "body",
            `${input.prefix}-%`,
          ).order("body"),
          context.supabase.storage.from("avatars").list(input.prefix),
          context.supabaseAdmin.storage.from("avatars").list(input.prefix),
          context.supabaseAdmin.functions.invoke("context-target", {
            body: { source: input.prefix, userId: context.userClaims?.id },
          }),
        ]);
      return Response.json({
        authMode: context.authMode,
        authKeyName: context.authKeyName ?? null,
        userClaims: context.userClaims,
        jwtSub: context.jwtClaims?.sub ?? null,
        authUser: {
          id: authUser.data.user?.id ?? null,
          email: authUser.data.user?.email ?? null,
          error: authUser.error?.message ?? null,
        },
        userNotes: {
          bodies: userNotes.data?.map((row) => row.body) ?? [],
          error: userNotes.error?.message ?? null,
        },
        adminNotes: {
          bodies: adminNotes.data?.map((row) => row.body) ?? [],
          error: adminNotes.error?.message ?? null,
        },
        userObjects: {
          names: userObjects.data?.map((object) => object.name).toSorted() ?? [],
          error: userObjects.error?.message ?? null,
        },
        adminObjects: {
          names: adminObjects.data?.map((object) => object.name).toSorted() ?? [],
          error: adminObjects.error?.message ?? null,
        },
        invoke: {
          data: invoke.data,
          error: invoke.error?.message ?? null,
        },
      });
    },
  ),
};
