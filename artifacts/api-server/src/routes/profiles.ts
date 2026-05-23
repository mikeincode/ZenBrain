import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  ListProfilesQueryParams,
  CreateProfileBody,
  UpdateProfileBody,
  GetProfileParams,
  UpdateProfileParams,
  DeleteProfileParams,
  GetProfileStatsParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/profiles", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = ListProfilesQueryParams.safeParse(req.query);
  const provider = parsed.success ? parsed.data.provider : undefined;

  let query = supabaseAdmin
    .from("profiles")
    .select("*, conversations(count)")
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: false });

  if (provider) {
    query = query.eq("provider", provider);
  }

  const { data, error } = await query;

  if (error) {
    req.log.error({ error }, "Failed to list profiles");
    res.status(500).json({ error: error.message });
    return;
  }

  const profiles = (data || []).map((p) => ({
    id: p.id,
    user_id: p.user_id,
    provider: p.provider,
    name: p.name,
    description: p.description ?? null,
    conversation_count: (p.conversations as unknown as { count: number }[])?.[0]?.count ?? 0,
    last_import_at: p.last_import_at ?? null,
    created_at: p.created_at,
  }));

  res.json(profiles);
});

router.post("/profiles", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = CreateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .insert({ ...parsed.data, user_id: req.userId! })
    .select()
    .single();

  if (error) {
    req.log.error({ error }, "Failed to create profile");
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({
    id: data.id,
    user_id: data.user_id,
    provider: data.provider,
    name: data.name,
    description: data.description ?? null,
    conversation_count: 0,
    last_import_at: null,
    created_at: data.created_at,
  });
});

router.get("/profiles/:profileId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = GetProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("*, conversations(count)")
    .eq("id", params.data.profileId)
    .eq("user_id", req.userId!)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json({
    id: data.id,
    user_id: data.user_id,
    provider: data.provider,
    name: data.name,
    description: data.description ?? null,
    conversation_count: (data.conversations as unknown as { count: number }[])?.[0]?.count ?? 0,
    last_import_at: data.last_import_at ?? null,
    created_at: data.created_at,
  });
});

router.patch("/profiles/:profileId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = UpdateProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update(parsed.data)
    .eq("id", params.data.profileId)
    .eq("user_id", req.userId!)
    .select()
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json({
    id: data.id,
    user_id: data.user_id,
    provider: data.provider,
    name: data.name,
    description: data.description ?? null,
    conversation_count: null,
    last_import_at: data.last_import_at ?? null,
    created_at: data.created_at,
  });
});

router.delete("/profiles/:profileId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = DeleteProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .delete()
    .eq("id", params.data.profileId)
    .eq("user_id", req.userId!);

  if (error) {
    req.log.error({ error }, "Failed to delete profile");
    res.status(500).json({ error: error.message });
    return;
  }

  res.sendStatus(204);
});

router.get("/profiles/:profileId/stats", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const params = GetProfileStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const profileId = params.data.profileId;

  const [profileRes, convRes, msgRes, importRes] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, last_import_at")
      .eq("id", profileId)
      .eq("user_id", req.userId!)
      .single(),
    supabaseAdmin
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabaseAdmin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    supabaseAdmin
      .from("import_runs")
      .select("created_at")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (!profileRes.data) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json({
    conversation_count: convRes.count ?? 0,
    message_count: msgRes.count ?? 0,
    last_import_at: importRes.data?.[0]?.created_at ?? null,
    total_size_bytes: null,
  });
});

router.get("/profiles/:profileId/download-zip", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const profileId = Array.isArray(req.params.profileId) ? req.params.profileId[0] : req.params.profileId;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id, name")
    .eq("id", profileId)
    .eq("user_id", req.userId!)
    .single();

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const { data: conversations } = await supabaseAdmin
    .from("conversations")
    .select("id, display_title, storage_path")
    .eq("profile_id", profileId)
    .not("storage_path", "is", null);

  if (!conversations || conversations.length === 0) {
    res.status(404).json({ error: "No conversations with markdown files found" });
    return;
  }

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  for (const conv of conversations) {
    if (!conv.storage_path) continue;
    const { data: fileData } = await supabaseAdmin.storage
      .from("markdown-files")
      .download(conv.storage_path);

    if (fileData) {
      const text = await fileData.text();
      const safeName = conv.display_title
        .replace(/[^a-z0-9\s-_]/gi, "")
        .replace(/\s+/g, "_")
        .slice(0, 80);
      zip.file(`${safeName}_${conv.id.slice(0, 8)}.md`, text);
    }
  }

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = `zips/${req.userId}/${profileId}_${Date.now()}.zip`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("markdown-files")
    .upload(zipPath, zipBuffer, { contentType: "application/zip", upsert: true });

  if (uploadError) {
    req.log.error({ uploadError }, "Failed to upload zip");
    res.status(500).json({ error: "Failed to generate zip" });
    return;
  }

  const { data: signedData } = await supabaseAdmin.storage
    .from("markdown-files")
    .createSignedUrl(zipPath, 3600);

  res.json({ url: signedData?.signedUrl ?? "", expires_at: null });
});

export default router;
