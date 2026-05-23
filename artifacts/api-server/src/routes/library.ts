import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/library/summary", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const { data: profiles, error } = await supabaseAdmin
    .from("profiles")
    .select("id, provider, last_import_at, conversations(count)")
    .eq("user_id", req.userId!);

  if (error) {
    req.log.error({ error }, "Failed to get library summary");
    res.status(500).json({ error: error.message });
    return;
  }

  const providerMap = new Map<
    string,
    { profile_count: number; conversation_count: number; last_import_at: string | null }
  >();

  let totalConversations = 0;

  for (const profile of profiles || []) {
    const p = profile.provider;
    const convCount = (profile.conversations as unknown as { count: number }[])?.[0]?.count ?? 0;
    totalConversations += convCount;

    if (!providerMap.has(p)) {
      providerMap.set(p, { profile_count: 0, conversation_count: 0, last_import_at: null });
    }

    const entry = providerMap.get(p)!;
    entry.profile_count += 1;
    entry.conversation_count += convCount;

    if (profile.last_import_at) {
      if (!entry.last_import_at || profile.last_import_at > entry.last_import_at) {
        entry.last_import_at = profile.last_import_at;
      }
    }
  }

  const providers = Array.from(providerMap.entries()).map(([provider, stats]) => ({
    provider,
    ...stats,
  }));

  res.json({
    providers,
    total_conversations: totalConversations,
    total_profiles: profiles?.length ?? 0,
  });
});

export default router;
