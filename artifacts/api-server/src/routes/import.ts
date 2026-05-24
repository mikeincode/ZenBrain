import { Router, type IRouter } from "express";
import multer from "multer";
import JSZip from "jszip";
import { supabaseAdmin } from "../lib/supabase";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import {
  parseChatGPTExport,
  conversationToMarkdown,
  sha256,
  type NormalizedConversation,
  type NormalizedMessage,
} from "../lib/chatgpt-parser";
import { parseClaudeExport, claudeConversationToMarkdown } from "../lib/claude-parser";
import { ListImportRunsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// ZIP / JSON extraction
// ---------------------------------------------------------------------------

function isZipBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

async function extractConversationsJson(buffer: Buffer): Promise<unknown> {
  if (isZipBuffer(buffer)) {
    const zip = await JSZip.loadAsync(buffer);

    // Collect all matching paths, prefer root-level first
    const candidates: JSZip.JSZipObject[] = [];
    zip.forEach((relativePath, file) => {
      if (!file.dir && relativePath.endsWith("conversations.json")) {
        candidates.push(file);
      }
    });

    if (candidates.length === 0) {
      throw new Error(
        "conversations.json not found in the uploaded ZIP. Expected it at root or inside a subfolder."
      );
    }

    // Prefer the shortest path (closest to root)
    candidates.sort((a, b) => a.name.length - b.name.length);
    const jsonContent = await candidates[0].async("string");

    try {
      return JSON.parse(jsonContent);
    } catch {
      throw new Error("conversations.json inside ZIP contains invalid JSON.");
    }
  }

  // Plain JSON file
  const text = buffer.toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Uploaded file is neither a valid ZIP nor valid JSON. Upload conversations.json or your ChatGPT export .zip."
    );
  }
}

// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------

interface ExistingMsgRef {
  external_id: string | null;
  content_hash: string | null;
}

function dedupeMessages(
  incoming: NormalizedMessage[],
  existing: ExistingMsgRef[]
): NormalizedMessage[] {
  // Cross-import dedup: build id and hash sets from rows already in the DB.
  // A message is skipped if its id OR content hash already exists there.
  // Hash matching handles the edge case where IDs differ between exports but
  // the content is identical (e.g. provider reformats IDs).
  const existingIds = new Set<string>();
  const existingHashes = new Set<string>();
  for (const m of existing) {
    if (m.external_id) existingIds.add(`id:${m.external_id}`);
    if (m.content_hash) existingHashes.add(`hash:${m.content_hash}`);
  }

  // Within-batch dedup: by ID only.
  // Deliberately does NOT deduplicate by hash within the batch so that a
  // conversation with two legitimately identical messages (same role, same
  // text at different positions) correctly preserves both.
  const batchIds = new Set<string>();
  const result: NormalizedMessage[] = [];
  for (const m of incoming) {
    const idKey = `id:${m.id}`;
    const hashKey = `hash:${m.contentHash}`;
    if (existingIds.has(idKey) || existingHashes.has(hashKey)) continue;
    if (batchIds.has(idKey)) continue;
    result.push(m);
    batchIds.add(idKey);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Import route
// ---------------------------------------------------------------------------

router.post(
  "/import",
  requireAuth,
  upload.single("file"),
  async (req: AuthenticatedRequest, res): Promise<void> => {
    const startTime = Date.now();
    const profileId = req.body?.profileId as string | undefined;
    const provider = req.body?.provider as string | undefined;

    if (!profileId || !provider) {
      res.status(400).json({ error: "profileId and provider are required" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    // Verify the profile belongs to the authenticated user
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

    // Create an import run record
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
      // --- Extract and parse ---
      let parsed: unknown;
      try {
        parsed = await extractConversationsJson(req.file.buffer);
      } catch (extractErr) {
        throw extractErr; // bubble to outer catch → mark run failed
      }

      let conversations: NormalizedConversation[] = [];
      if (provider === "chatgpt") {
        conversations = parseChatGPTExport(parsed);
      } else if (provider === "claude") {
        conversations = parseClaudeExport(parsed);
      } else {
        throw new Error(`Provider '${provider}' is not yet supported`);
      }

      req.log.info({ count: conversations.length }, "Parsed conversations");

      // --- Process each conversation ---
      for (const conv of conversations) {
        try {
          const externalId = conv.externalId;

          const { data: existing } = await supabaseAdmin
            .from("conversations")
            .select("id, updated_at")
            .eq("profile_id", profileId)
            .eq("external_id", externalId)
            .single();

          const markdown =
            provider === "claude"
              ? claudeConversationToMarkdown(conv)
              : conversationToMarkdown(conv);
          const markdownBuffer = Buffer.from(markdown, "utf-8");

          let conversationId: string;
          let storagePath: string;

          if (existing) {
            // --- Update path ---
            conversationId = existing.id;
            storagePath = `${req.userId}/${profileId}/${conversationId}.md`;

            const { error: uploadError } = await supabaseAdmin.storage
              .from("markdown-files")
              .upload(storagePath, markdownBuffer, {
                contentType: "text/markdown",
                upsert: true,
              });

            if (uploadError) {
              throw new Error(`Storage upload failed: ${uploadError.message}`);
            }

            await supabaseAdmin
              .from("conversations")
              .update({
                display_title: conv.title,
                updated_at: new Date().toISOString(),
                storage_path: storagePath,
              })
              .eq("id", conversationId);

            // Deduplicate messages against what is already stored
            let existingMsgs: ExistingMsgRef[] = [];
            if (conv.messages.length > 0) {
              const { data } = await supabaseAdmin
                .from("messages")
                .select("external_id, content_hash")
                .eq("conversation_id", conversationId);
              existingMsgs = (data ?? []) as ExistingMsgRef[];
            }

            const newMessages = dedupeMessages(conv.messages, existingMsgs);

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
            // --- New conversation path ---
            const { data: newConv, error: insertError } = await supabaseAdmin
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

            if (insertError || !newConv) {
              throw new Error(
                `Failed to insert conversation: ${insertError?.message ?? "unknown error"}`
              );
            }

            conversationId = newConv.id;
            storagePath = `${req.userId}/${profileId}/${conversationId}.md`;

            const { error: uploadError } = await supabaseAdmin.storage
              .from("markdown-files")
              .upload(storagePath, markdownBuffer, {
                contentType: "text/markdown",
                upsert: true,
              });

            if (uploadError) {
              // Roll back the conversation row so we don't leave a broken record
              await supabaseAdmin.from("conversations").delete().eq("id", conversationId);
              throw new Error(`Storage upload failed: ${uploadError.message}`);
            }

            await supabaseAdmin
              .from("conversations")
              .update({ storage_path: storagePath })
              .eq("id", conversationId);

            // Dedupe within the batch itself (handles exports with internal duplicates)
            const uniqueMessages = dedupeMessages(conv.messages, []);

            if (uniqueMessages.length > 0) {
              await supabaseAdmin.from("messages").insert(
                uniqueMessages.map((m) => ({
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
          const msg = `"${conv.title}": ${String(convErr)}`;
          errors.push(msg);
          req.log.warn({ convErr, title: conv.title }, "Failed to import conversation");
        }
      }

      await supabaseAdmin
        .from("profiles")
        .update({ last_import_at: new Date().toISOString() })
        .eq("id", profileId);

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
        duration_ms: Date.now() - startTime,
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
  }
);

// ---------------------------------------------------------------------------
// List import runs
// ---------------------------------------------------------------------------

router.get(
  "/import/runs",
  requireAuth,
  async (req: AuthenticatedRequest, res): Promise<void> => {
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
  }
);

export default router;
