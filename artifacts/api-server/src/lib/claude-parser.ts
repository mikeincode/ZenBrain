import { sha256, type NormalizedConversation, type NormalizedMessage } from "./chatgpt-parser";

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
    default:
      return "assistant";
  }
}

/**
 * Extract renderable text from a Claude message.
 * Prefers structured content blocks; falls back to the top-level text field.
 * Skips tool_use, tool_result, and thinking blocks — they are not readable prose.
 */
function extractClaudeContent(msg: Record<string, unknown>): string {
  const content = msg["content"];
  if (Array.isArray(content) && content.length > 0) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        parts.push(b["text"]);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  if (typeof msg["text"] === "string" && msg["text"].trim()) {
    return msg["text"];
  }
  return "";
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
 *               chat_messages: [{ uuid, sender, created_at, content: [{type,text}], text }] }
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
    // If the conversation has a uuid, use it directly.
    // Otherwise derive one from title + created_at so it is stable across re-imports.
    const convKey =
      typeof c["uuid"] === "string" && c["uuid"].trim()
        ? c["uuid"].trim()
        : sha256(
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
        // valid repeated messages from being collapsed during dedup.
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
    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
