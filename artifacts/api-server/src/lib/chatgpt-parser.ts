// Re-export shared types and utilities so existing importers (import.ts, tests)
// that reference chatgpt-parser.ts do not need to change.
export { sha256, type NormalizedMessage, type NormalizedConversation } from "./normalized";

import { sha256, type NormalizedMessage, type NormalizedConversation } from "./normalized";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deterministicExternalId(
  provider: string,
  title: string,
  createdAt: number | null,
  updatedAt: number | null,
  messages: NormalizedMessage[]
): string {
  const firstMsgHash = messages[0]?.contentHash ?? "";
  const msgCount = String(messages.length);
  const input = [provider, title, String(createdAt ?? ""), String(updatedAt ?? ""), firstMsgHash, msgCount].join("|");
  return `det:${sha256(input).slice(0, 32)}`;
}

/**
 * Extract renderable text from a ChatGPT message content or parts array.
 *
 * Handles:
 *  - Plain strings
 *  - Arrays of strings and/or content-block objects ({ type:"text", text:"..." })
 *  - Objects with a "parts" array
 *  - image_asset_pointer objects → summarised as "[User uploaded X image(s)]"
 */
export function extractTextContent(content: unknown): string {
  const textParts: string[] = [];
  let imageCount = 0;

  function processPart(part: unknown): void {
    if (typeof part === "string") {
      if (part.trim()) textParts.push(part);
      return;
    }
    if (!part || typeof part !== "object") return;
    const p = part as Record<string, unknown>;

    // OpenAI content block: { type: "text", text: "..." }
    if (p["type"] === "text" && typeof p["text"] === "string") {
      if ((p["text"] as string).trim()) textParts.push(p["text"] as string);
      return;
    }

    // ChatGPT image attachment: { content_type: "image_asset_pointer", ... }
    if (p["content_type"] === "image_asset_pointer") {
      imageCount++;
      return;
    }
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    for (const part of content) processPart(part);
  } else if (content && typeof content === "object" && "parts" in content) {
    const parts = (content as { parts: unknown[] }).parts;
    for (const part of parts) processPart(part);
  }

  if (imageCount > 0) {
    textParts.push(`[User uploaded ${imageCount} image${imageCount === 1 ? "" : "s"}]`);
  }

  return textParts.join("");
}

function mapRole(role: string): "user" | "assistant" | "system" | "tool" {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
    case "function":
      return "tool";
    default:
      return "assistant";
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseChatGPTExport(raw: unknown): NormalizedConversation[] {
  if (!Array.isArray(raw)) {
    throw new Error("ChatGPT export must be a JSON array");
  }

  const conversations: NormalizedConversation[] = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== "object") continue;
    const c = conv as Record<string, unknown>;

    const rawId =
      typeof c["id"] === "string" && c["id"].trim() ? c["id"].trim() : null;
    const title =
      typeof c["title"] === "string" && c["title"].trim()
        ? c["title"].trim()
        : "Untitled Conversation";
    const createdAt =
      typeof c["create_time"] === "number" ? c["create_time"] : null;
    const updatedAt =
      typeof c["update_time"] === "number" ? c["update_time"] : null;

    // Stable conversation-level key used in fallback message IDs.
    const convKey =
      rawId ??
      sha256([title, String(createdAt ?? ""), String(updatedAt ?? "")].join("|")).slice(0, 16);

    const messages: NormalizedMessage[] = [];

    const mapping = c["mapping"];
    if (mapping && typeof mapping === "object") {
      // Build the node map using Object.entries so the mapping key is always
      // available as a fallback when a node object does not carry its own id.
      const nodeMap = new Map<string, Record<string, unknown>>();
      for (const [key, node] of Object.entries(mapping as Record<string, unknown>)) {
        if (node && typeof node === "object") {
          const n = node as Record<string, unknown>;
          // Prefer the node's own id field; fall back to the mapping key.
          const nodeId =
            typeof n["id"] === "string" && n["id"].trim() ? n["id"].trim() : key;
          nodeMap.set(nodeId, n);
        }
      }

      // Find the root: the node whose parent is null or undefined.
      let currentId: string | null = null;
      for (const [key, node] of Object.entries(mapping as Record<string, unknown>)) {
        if (node && typeof node === "object") {
          const n = node as Record<string, unknown>;
          if (n["parent"] === null || n["parent"] === undefined) {
            currentId =
              typeof n["id"] === "string" && n["id"].trim() ? n["id"].trim() : key;
            break;
          }
        }
      }

      // Walk the conversation tree following the LAST child of each node.
      // ChatGPT branches when the user regenerates a reply; by always taking
      // the last child we follow the most recent (canonical) branch and discard
      // earlier alternatives. Only follow children that are valid string IDs
      // present in nodeMap to avoid dangling references.
      const visited = new Set<string>();
      while (currentId) {
        if (visited.has(currentId)) break;
        visited.add(currentId);

        const node = nodeMap.get(currentId);
        if (!node) break;

        const msg = node["message"] as Record<string, unknown> | null;
        if (msg) {
          const msgContent = msg["content"] as Record<string, unknown> | null;
          const role =
            typeof msg["author"] === "object" && msg["author"]
              ? ((msg["author"] as Record<string, unknown>)["role"] as string) || "assistant"
              : "assistant";
          const contentParts = msgContent
            ? extractTextContent(msgContent["parts"] || msgContent)
            : "";

          if (contentParts.trim()) {
            const rawMsgId =
              typeof msg["id"] === "string" && msg["id"].trim()
                ? msg["id"].trim()
                : null;
            const ts =
              typeof msg["create_time"] === "number" ? msg["create_time"] : null;

            // Fallback message ID: stable across re-imports and unique within
            // the conversation. Incorporates provider, conversation key, node
            // key (currentId), role, timestamp, and content hash so that two
            // different nodes with identical content still get distinct IDs.
            const msgId =
              rawMsgId ??
              sha256(
                ["chatgpt", convKey, currentId, mapRole(role), String(ts ?? ""), sha256(contentParts)].join("|")
              ).slice(0, 32);

            // Extract optional model_slug from message metadata.
            const rawMeta = msg["metadata"] as Record<string, unknown> | null;
            const metadata: Record<string, string> = {};
            if (rawMeta && typeof rawMeta["model_slug"] === "string") {
              metadata["model_slug"] = rawMeta["model_slug"] as string;
            }

            messages.push({
              id: msgId,
              role: mapRole(role),
              content: contentParts,
              contentHash: sha256(contentParts),
              timestamp: ts,
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            });
          }
        }

        const children = node["children"];
        if (Array.isArray(children)) {
          // Only follow children that exist in nodeMap.
          const validChildren = (children as unknown[]).filter(
            (ch): ch is string => typeof ch === "string" && nodeMap.has(ch)
          );
          currentId = validChildren.length > 0 ? validChildren[validChildren.length - 1] : null;
        } else {
          currentId = null;
        }
      }
    }

    const externalId =
      rawId ?? deterministicExternalId("chatgpt", title, createdAt, updatedAt, messages);

    conversations.push({ externalId, title, messages, createdAt, updatedAt });
  }

  return conversations;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function conversationToMarkdown(conv: NormalizedConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");

  if (conv.createdAt) {
    const date = new Date(conv.createdAt * 1000).toISOString().split("T")[0];
    lines.push(`*Created: ${date}*`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  for (const msg of conv.messages) {
    const roleLabel =
      msg.role === "user"
        ? "**You**"
        : msg.role === "assistant"
        ? "**Assistant**"
        : msg.role === "system"
        ? "**System**"
        : "**Tool**";

    lines.push(`### ${roleLabel}`);
    lines.push("");

    // Optional per-message metadata line: timestamp and/or model slug.
    const metaParts: string[] = [];
    if (msg.timestamp) {
      const ts =
        new Date(msg.timestamp * 1000).toISOString().replace("T", " ").split(".")[0] + " UTC";
      metaParts.push(ts);
    }
    if (msg.metadata?.["model_slug"]) {
      metaParts.push(`Model: ${msg.metadata["model_slug"]}`);
    }
    if (metaParts.length > 0) {
      lines.push(`*${metaParts.join(" · ")}*`);
      lines.push("");
    }

    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
