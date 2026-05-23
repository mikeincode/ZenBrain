import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  ListConversationsQueryParams,
  GetConversationParams,
  UpdateConversationParams,
  UpdateConversationBody,
  DeleteConversationParams,
  DownloadConversationParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/conversations", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = ListConversationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { profileId, search, page = 1, limit = 20 } = parsed.data;

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabaseAdmin
    .from("conversations")
    .select("*, messages(count)", { count: "exact" })
    .eq("profile_id", profileId)
    .order("updated_at", { ascending: false })
    .range(from, to);

  if (search) {
    query = query.ilike("display_title", `%${search}%`);
  }

  const { data, error, count } = await query;

  if (error) {
    req.log.error({ error }, "Failed to list conversations");
    res.status(500).json({ error: error.message });
    return;
  }

  const conversations = (data || []).map((c) => ({
    id: c.id,
    profile_id: c.profile_id,
    provider: c.provider,
    display_title: c.display_title,
    external_id: c.external_id ?? null,
    message_count: (c.messages as unknown as { count: number }[])?.[0]?.count ?? null,
    storage_path: c.storage_path ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));

  res.json({
    conversations,
    total: count ?? 0,
    page,
    limit,
  });
});

router.get("/conversations/:conversationId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = GetConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { data: conv, error } = await supabaseAdmin
    .from("conversations")
    .select("*, messages(count), profiles!inner(user_id)")
    .eq("id", params.data.conversationId)
    .eq("profiles.user_id", req.userId!)
    .single();

  if (error || !conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  let markdownContent: string | null = null;
  if (conv.storage_path) {
    const { data: fileData } = await supabaseAdmin.storage
      .from("markdown-files")
      .download(conv.storage_path);
    if (fileData) {
      markdownContent = await fileData.text();
    }
  }

  res.json({
    id: conv.id,
    profile_id: conv.profile_id,
    provider: conv.provider,
    display_title: conv.display_title,
    external_id: conv.external_id ?? null,
    message_count: (conv.messages as unknown as { count: number }[])?.[0]?.count ?? null,
    storage_path: conv.storage_path ?? null,
    markdown_content: markdownContent,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
  });
});

router.patch("/conversations/:conversationId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = UpdateConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.display_title !== undefined) {
    updateData.display_title = parsed.data.display_title;
  }

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .update(updateData)
    .eq("id", params.data.conversationId)
    .select("*, profiles!inner(user_id)")
    .eq("profiles.user_id", req.userId!)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.json({
    id: data.id,
    profile_id: data.profile_id,
    provider: data.provider,
    display_title: data.display_title,
    external_id: data.external_id ?? null,
    message_count: null,
    storage_path: data.storage_path ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  });
});

router.delete("/conversations/:conversationId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = DeleteConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { error } = await supabaseAdmin
    .from("conversations")
    .delete()
    .eq("id", params.data.conversationId);

  if (error) {
    req.log.error({ error }, "Failed to delete conversation");
    res.status(500).json({ error: error.message });
    return;
  }

  res.sendStatus(204);
});

router.get("/conversations/:conversationId/download", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = DownloadConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { data: conv, error } = await supabaseAdmin
    .from("conversations")
    .select("id, storage_path, profiles!inner(user_id)")
    .eq("id", params.data.conversationId)
    .eq("profiles.user_id", req.userId!)
    .single();

  if (error || !conv || !conv.storage_path) {
    res.status(404).json({ error: "Conversation or file not found" });
    return;
  }

  const { data: signedData } = await supabaseAdmin.storage
    .from("markdown-files")
    .createSignedUrl(conv.storage_path, 3600);

  res.json({ url: signedData?.signedUrl ?? "", expires_at: null });
});

export default router;
