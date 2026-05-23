import { createHash } from "crypto";

export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  contentHash: string;
  timestamp: number | null;
}

export interface NormalizedConversation {
  externalId: string;
  title: string;
  messages: NormalizedMessage[];
  createdAt: number | null;
  updatedAt: number | null;
}

export function sha256(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

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

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: string }).type === "text" &&
          "text" in part
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "parts" in content) {
    const parts = (content as { parts: unknown[] }).parts;
    return parts.map((p) => (typeof p === "string" ? p : "")).join("");
  }
  return "";
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

export function parseChatGPTExport(raw: unknown): NormalizedConversation[] {
  if (!Array.isArray(raw)) {
    throw new Error("ChatGPT export must be a JSON array");
  }

  const conversations: NormalizedConversation[] = [];

  for (const conv of raw) {
    if (!conv || typeof conv !== "object") continue;

    const c = conv as Record<string, unknown>;

    const rawId = typeof c["id"] === "string" && c["id"].trim() ? c["id"].trim() : null;
    const title =
      typeof c["title"] === "string" && c["title"].trim()
        ? c["title"].trim()
        : "Untitled Conversation";
    const createdAt =
      typeof c["create_time"] === "number" ? c["create_time"] : null;
    const updatedAt =
      typeof c["update_time"] === "number" ? c["update_time"] : null;

    const messages: NormalizedMessage[] = [];

    const mapping = c["mapping"];
    if (mapping && typeof mapping === "object") {
      const nodes = Object.values(mapping as Record<string, unknown>);

      const nodeMap = new Map<string, Record<string, unknown>>();
      for (const node of nodes) {
        if (node && typeof node === "object") {
          const n = node as Record<string, unknown>;
          if (typeof n["id"] === "string") {
            nodeMap.set(n["id"], n);
          }
        }
      }

      let currentId: string | null = null;
      for (const node of nodes) {
        if (node && typeof node === "object") {
          const n = node as Record<string, unknown>;
          if (!n["parent"]) {
            currentId = typeof n["id"] === "string" ? n["id"] : null;
            break;
          }
        }
      }

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
            const msgId =
              typeof msg["id"] === "string" ? msg["id"] : visited.size.toString();
            const ts =
              typeof msg["create_time"] === "number" ? msg["create_time"] : null;
            messages.push({
              id: msgId,
              role: mapRole(role),
              content: contentParts,
              contentHash: sha256(contentParts),
              timestamp: ts,
            });
          }
        }

        const children = node["children"];
        if (Array.isArray(children) && children.length > 0) {
          currentId = children[children.length - 1] as string;
        } else {
          currentId = null;
        }
      }
    }

    const externalId =
      rawId ?? deterministicExternalId("chatgpt", title, createdAt, updatedAt, messages);

    conversations.push({
      externalId,
      title,
      messages,
      createdAt,
      updatedAt,
    });
  }

  return conversations;
}

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
    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
