import { Router, type IRouter } from "express";
import multer from "multer";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  parseChatGPTExport,
  conversationToMarkdown,
  type NormalizedConversation,
} from "../lib/chatgpt-parser";
import { ListImportRunsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

router.post("/import", requireAuth, upload.single("file"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const startTime = Date.now();
  const profileId = req.body?.profileId;
  const provider = req.body?.provider;

  if (!profileId || !provider) {
    res.status(400).json({ error: "profileId and provider are required" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", profileId)
    .eq("user_id", req.userId!)
    .single();

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const { data: runData, error: runError } = await supabaseAdmin
    .from("import_runs")
    .insert({ profile_id: profileId, provider, status: "running", user_id: req.userId! })
    .select()
    .single();

  if (runError || !runData) {
    req.log.error({ runError }, "Failed to create import run");
    res.status(500).json({ error: "Failed to create import run" });
    return;
  }

  const runId = runData.id;
  let newCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    const fileContent = req.file.buffer.toString("utf-8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(fileContent);
    } catch {
      throw new Error("Invalid JSON file");
    }

    let conversations: NormalizedConversation[] = [];

    if (provider === "chatgpt") {
      conversations = parseChatGPTExport(parsed);
    } else {
      throw new Error(`Provider '${provider}' is not yet supported`);
    }

    req.log.info({ count: conversations.length }, "Parsed conversations");

    for (const conv of conversations) {
      try {
        const externalId = conv.externalId;

        const { data: existing } = await supabaseAdmin
          .from("conversations")
          .select("id, updated_at")
          .eq("profile_id", profileId)
          .eq("external_id", externalId)
          .single();

        const markdown = conversationToMarkdown(conv);
        const markdownBuffer = Buffer.from(markdown, "utf-8");

        const safeTitle = conv.title
          .replace(/[^a-z0-9\s-_]/gi, "")
          .replace(/\s+/g, "_")
          .slice(0, 60);

        let conversationId: string;
        let storagePath: string;

        if (existing) {
          conversationId = existing.id;
          storagePath = `${req.userId}/${profileId}/${conversationId}.md`;

          await supabaseAdmin.storage
            .from("markdown-files")
            .upload(storagePath, markdownBuffer, {
              contentType: "text/markdown",
              upsert: true,
            });

          await supabaseAdmin
            .from("conversations")
            .update({
              display_title: conv.title,
              updated_at: new Date().toISOString(),
              storage_path: storagePath,
            })
            .eq("id", conversationId);

          if (conv.messages.length > 0) {
            const existingMsgIds = new Set<string>();
            const { data: existingMsgs } = await supabaseAdmin
              .from("messages")
              .select("external_id, content_hash")
              .eq("conversation_id", conversationId);

            for (const m of existingMsgs || []) {
              if (m.external_id) existingMsgIds.add(m.external_id);
              if (m.content_hash) existingMsgIds.add(`hash:${m.content_hash}`);
            }

            const newMessages = conv.messages.filter((m) => {
              return !existingMsgIds.has(m.id) && !existingMsgIds.has(`hash:${m.contentHash}`);
            });

            if (newMessages.length > 0) {
              await supabaseAdmin.from("messages").insert(
                newMessages.map((m) => ({
                  conversation_id: conversationId,
                  profile_id: profileId,
                  external_id: m.id,
                  role: m.role,
                  content: m.content,
                  content_hash: m.contentHash,
                  message_timestamp: m.timestamp
                    ? new Date(m.timestamp * 1000).toISOString()
                    : null,
                }))
              );
              updatedCount++;
            } else {
              skippedCount++;
            }
          } else {
            skippedCount++;
          }
        } else {
          const { data: newConv } = await supabaseAdmin
            .from("conversations")
            .insert({
              profile_id: profileId,
              provider,
              external_id: externalId,
              display_title: conv.title,
              storage_path: null,
            })
            .select()
            .single();

          if (!newConv) {
            failedCount++;
            continue;
          }

          conversationId = newConv.id;
          storagePath = `${req.userId}/${profileId}/${conversationId}.md`;

          await supabaseAdmin.storage
            .from("markdown-files")
            .upload(storagePath, markdownBuffer, {
              contentType: "text/markdown",
              upsert: true,
            });

          await supabaseAdmin
            .from("conversations")
            .update({ storage_path: storagePath })
            .eq("id", conversationId);

          if (conv.messages.length > 0) {
            await supabaseAdmin.from("messages").insert(
              conv.messages.map((m) => ({
                conversation_id: conversationId,
                profile_id: profileId,
                external_id: m.id,
                role: m.role,
                content: m.content,
                content_hash: m.contentHash,
                message_timestamp: m.timestamp
                  ? new Date(m.timestamp * 1000).toISOString()
                  : null,
              }))
            );
          }

          newCount++;
        }
      } catch (convErr) {
        failedCount++;
        errors.push(`Failed to import "${conv.title}": ${String(convErr)}`);
        req.log.warn({ convErr, title: conv.title }, "Failed to import conversation");
      }
    }

    await supabaseAdmin
      .from("profiles")
      .update({ last_import_at: new Date().toISOString() })
      .eq("id", profileId);

    const durationMs = Date.now() - startTime;

    await supabaseAdmin
      .from("import_runs")
      .update({
        status: "completed",
        new_count: newCount,
        updated_count: updatedCount,
        skipped_count: skippedCount,
        failed_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    res.json({
      run_id: runId,
      new_count: newCount,
      updated_count: updatedCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      status: "completed",
      errors: errors.slice(0, 10),
      duration_ms: durationMs,
    });
  } catch (err) {
    req.log.error({ err }, "Import failed");

    await supabaseAdmin
      .from("import_runs")
      .update({ status: "failed" })
      .eq("id", runId);

    res.status(500).json({
      run_id: runId,
      new_count: 0,
      updated_count: 0,
      skipped_count: 0,
      failed_count: 1,
      status: "failed",
      errors: [String(err)],
      duration_ms: Date.now() - startTime,
    });
  }
});

router.get("/import/runs", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const parsed = ListImportRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("import_runs")
    .select("*")
    .eq("profile_id", parsed.data.profileId)
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    req.log.error({ error }, "Failed to list import runs");
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(
    (data || []).map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      provider: r.provider,
      status: r.status,
      new_count: r.new_count ?? null,
      updated_count: r.updated_count ?? null,
      skipped_count: r.skipped_count ?? null,
      failed_count: r.failed_count ?? null,
      created_at: r.created_at,
      completed_at: r.completed_at ?? null,
    }))
  );
});

export default router;
