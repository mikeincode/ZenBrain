import { sha256, type NormalizedConversation, type NormalizedMessage } from "./normalized";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseIsoToUnixSeconds(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? ts / 1000 : null;
}

function mapClaudeRole(sender: string): "user" | "assistant" | "system" | "tool" {
  switch (sender) {
    case "human":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
    case "tool_result":
      return "tool";
    default:
      return "assistant";
  }
}

/**
 * Extract renderable text from a Claude message.
 *
 * Content block types handled:
 *  - "text"        → rendered as-is
 *  - "thinking"    → "[Thinking block omitted]"
 *  - "tool_use"    → "[Tool use omitted]"
 *  - "tool_result" → "[Tool result omitted]"
 *  - anything else → "[<type> block omitted]" if type is a non-empty string,
 *                    otherwise silently skipped
 *
 * Falls back to the top-level "text" field when the content array is absent
 * or yields no renderable output.
 *
 * Attachments in the message-level "files" array are appended as
 * "[Image attachment]" or "[File attachment]" placeholders.
 */
function extractClaudeContent(msg: Record<string, unknown>): string {
  const parts: string[] = [];

  const content = msg["content"];
  if (Array.isArray(content) && content.length > 0) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const type = typeof b["type"] === "string" ? b["type"] : "";

      switch (type) {
        case "text":
          if (typeof b["text"] === "string" && b["text"].trim()) {
            parts.push(b["text"]);
          }
          break;
        case "thinking":
          parts.push("[Thinking block omitted]");
          break;
        case "tool_use":
          parts.push("[Tool use omitted]");
          break;
        case "tool_result":
          parts.push("[Tool result omitted]");
          break;
        default:
          if (type) parts.push(`[${type} block omitted]`);
      }
    }
  }

  // Fall back to top-level text field if content blocks yielded nothing.
  if (parts.length === 0 && typeof msg["text"] === "string" && msg["text"].trim()) {
    parts.push(msg["text"]);
  }

  // Append file/image attachment placeholders from the message-level files array.
  const files = msg["files"];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      const file = f as Record<string, unknown>;
      const fileType =
        typeof file["file_type"] === "string" ? file["file_type"] : "";
      if (fileType.startsWith("image/")) {
        parts.push("[Image attachment]");
      } else if (
        typeof file["file_name"] === "string" ||
        typeof file["extracted_content"] === "string"
      ) {
        parts.push("[File attachment]");
      }
    }
  }

  return parts.join("\n\n");
}

function deterministicExternalId(
  title: string,
  createdAt: number | null,
  updatedAt: number | null,
  messages: NormalizedMessage[]
): string {
  const firstMsgHash = messages[0]?.contentHash ?? "";
  const msgCount = String(messages.length);
  const input = ["claude", title, String(createdAt ?? ""), String(updatedAt ?? ""), firstMsgHash, msgCount].join("|");
  return `det:${sha256(input).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Claude conversations.json export into NormalizedConversation[].
 *
 * Claude format:
 *   Array of { uuid, name, created_at (ISO), updated_at (ISO),
 *               chat_messages: [{ uuid, sender, created_at, content: [{type,…}], text }] }
 */
export function parseClaudeExport(raw: unknown): NormalizedConversation[] {
  if (!Array.isArray(raw)) {
    throw new Error("Claude export must be a JSON array");
  }

  const conversations: NormalizedConversation[] = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== "object") continue;
    const c = conv as Record<string, unknown>;

    const rawId =
      typeof c["uuid"] === "string" && c["uuid"].trim() ? c["uuid"].trim() : null;

    const title =
      typeof c["name"] === "string" && c["name"].trim()
        ? c["name"].trim()
        : "Untitled Conversation";

    const createdAt = parseIsoToUnixSeconds(c["created_at"]);
    const updatedAt = parseIsoToUnixSeconds(c["updated_at"]);

    const messages: NormalizedMessage[] = [];

    // Stable conversation key for message fallback IDs.
    // Uses uuid if present; otherwise derives from title + created_at.
    const convKey =
      rawId ??
      sha256(
        [
          typeof c["name"] === "string" ? c["name"] : "",
          typeof c["created_at"] === "string" ? c["created_at"] : "",
        ].join("|")
      ).slice(0, 16);

    const chatMessages = c["chat_messages"];
    if (Array.isArray(chatMessages)) {
      for (let msgIdx = 0; msgIdx < chatMessages.length; msgIdx++) {
        const rawMsg = chatMessages[msgIdx];
        if (!rawMsg || typeof rawMsg !== "object") continue;
        const m = rawMsg as Record<string, unknown>;

        const msgId =
          typeof m["uuid"] === "string" && m["uuid"].trim()
            ? m["uuid"].trim()
            : null;

        const sender = typeof m["sender"] === "string" ? m["sender"] : "assistant";
        const role = mapClaudeRole(sender);
        const content = extractClaudeContent(m);
        const ts = parseIsoToUnixSeconds(m["created_at"]);

        if (!content.trim()) continue;

        // Fallback ID when no uuid is present.
        // Incorporates: provider prefix, conversation key, role, array index,
        // ISO timestamp (if present), and content hash.
        // Using the array index makes two identical messages at different
        // positions in the same conversation produce distinct IDs, preventing
        // legitimate repeated messages from being collapsed during dedup.
        const id =
          msgId ??
          sha256(
            [
              "claude",
              convKey,
              role,
              String(msgIdx),
              typeof m["created_at"] === "string" ? m["created_at"] : "",
              sha256(content),
            ].join("|")
          ).slice(0, 32);

        messages.push({
          id,
          role,
          content,
          contentHash: sha256(content),
          timestamp: ts,
        });
      }
    }

    const externalId =
      rawId ?? deterministicExternalId(title, createdAt, updatedAt, messages);

    conversations.push({ externalId, title, messages, createdAt, updatedAt });
  }

  return conversations;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a NormalizedConversation from Claude into a Markdown string.
 * Uses "**Claude**" as the assistant label and includes a provider line.
 */
export function claudeConversationToMarkdown(conv: NormalizedConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");
  lines.push("*Provider: Claude*");
  lines.push("");

  if (conv.createdAt) {
    const date = new Date(conv.createdAt * 1000).toISOString().split("T")[0];
    lines.push(`*Created: ${date}*`);
    lines.push("");
  }

  if (conv.updatedAt && conv.updatedAt !== conv.createdAt) {
    const date = new Date(conv.updatedAt * 1000).toISOString().split("T")[0];
    lines.push(`*Updated: ${date}*`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  for (const msg of conv.messages) {
    const roleLabel =
      msg.role === "user"
        ? "**You**"
        : msg.role === "assistant"
        ? "**Claude**"
        : msg.role === "system"
        ? "**System**"
        : "**Tool**";

    lines.push(`### ${roleLabel}`);
    lines.push("");

    // Per-message timestamp when available.
    if (msg.timestamp) {
      const ts =
        new Date(msg.timestamp * 1000).toISOString().replace("T", " ").split(".")[0] + " UTC";
      lines.push(`*${ts}*`);
      lines.push("");
    }

    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
