import { load } from "cheerio";
import JSZip from "jszip";
import { sha256, type NormalizedConversation, type NormalizedMessage } from "./normalized";

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------
// Handles: "Apr 17, 2025, 9:31:30 PM PDT"  (also without tz suffix)

const GEMINI_TS_RE =
  /([A-Z][a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [AP]M)(?:\s+[A-Z]{2,5})?/;

/**
 * Parse a Gemini activity timestamp string to Unix seconds (best-effort).
 * The raw string is kept separately for use in the deterministic externalId
 * so the ID is stable across environments with different local timezones.
 */
function parseGeminiTimestamp(text: string): number | null {
  const m = text.match(GEMINI_TS_RE);
  if (!m) return null;
  // Strip commas so V8 accepts the date: "Apr 17, 2025, 9:31:30 PM" → "Apr 17 2025 9:31:30 PM"
  const cleaned = m[1].replace(/,/g, "");
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Extract the raw timestamp string from cell text (for stable externalId).
 */
function extractRawTimestamp(text: string): string | null {
  const m = text.match(GEMINI_TS_RE);
  return m ? m[0].trim() : null;
}

// ---------------------------------------------------------------------------
// Deterministic external ID
// ---------------------------------------------------------------------------
// Uses the raw timestamp string (not parsed Unix seconds) so the ID is stable
// across deployments in different local-time zones.

function deterministicGeminiExternalId(
  rawTimestamp: string | null,
  promptHash: string,
  responseHash: string,
  attachmentKey: string
): string {
  const input = [
    "gemini",
    rawTimestamp ?? "",
    promptHash,
    responseHash,
    attachmentKey,
  ].join("|");
  return `det:${sha256(input).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function getTagName(el: { type: string; name?: string }): string {
  return el.type === "tag" && el.name ? el.name.toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// ZIP / HTML extraction
// ---------------------------------------------------------------------------

/**
 * Accept either a raw MyActivity.html buffer or a ZIP containing it.
 *
 * ZIP search order:
 *  1. Path segments include "Gemini" AND ends with "MyActivity.html"
 *  2. Any path ending with "MyActivity.html" (shortest wins)
 *
 * Throws a descriptive error if no MyActivity.html is found.
 */
export async function extractGeminiHtmlFromBuffer(buffer: Buffer): Promise<string> {
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;

  if (!isZip) {
    return buffer.toString("utf-8");
  }

  const zip = await JSZip.loadAsync(buffer);

  type Candidate = { name: string; file: JSZip.JSZipObject };
  const candidates: Candidate[] = [];

  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith("MyActivity.html")) {
      candidates.push({ name: relativePath, file });
    }
  });

  if (candidates.length === 0) {
    throw new Error(
      "MyActivity.html not found in the uploaded ZIP. " +
        "Expected path: Takeout/My Activity/Gemini Apps/MyActivity.html"
    );
  }

  // Prefer the path that mentions "Gemini", then shortest path.
  candidates.sort((a, b) => {
    const aGemini = a.name.includes("Gemini") ? 0 : 1;
    const bGemini = b.name.includes("Gemini") ? 0 : 1;
    if (aGemini !== bGemini) return aGemini - bGemini;
    return a.name.length - b.name.length;
  });

  return candidates[0].file.async("string");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Google Takeout Gemini Apps MyActivity.html into NormalizedConversation[].
 *
 * Each outer-cell div represents one activity (one prompt/response pair).
 * Only cells whose main content cell contains "Prompted" are processed.
 * Caption cells (12-col inner) and right image cells (2-col-tablet) are ignored.
 */
export function parseGeminiActivityHtml(html: string): NormalizedConversation[] {
  const $ = load(html);
  const conversations: NormalizedConversation[] = [];

  $(".outer-cell.mdl-cell--12-col.mdl-shadow--2dp").each((_, cardEl) => {
    const card = $(cardEl);

    // ── Find the main content cell ────────────────────────────────────────
    // The main cell contains "Prompted". Exclude:
    //   - right/image cell: has class mdl-cell--2-col-tablet
    //   - caption cell:     has class mdl-cell--12-col  (inner, not the outer card)
    let mainCell: ReturnType<typeof $> | null = null;

    card.find(".content-cell").each((_, cellEl) => {
      const cell = $(cellEl);
      if (cell.hasClass("mdl-cell--2-col-tablet")) return;
      if (cell.hasClass("mdl-cell--12-col")) return;
      if (!mainCell && cell.text().includes("Prompted")) {
        mainCell = cell as unknown as ReturnType<typeof $>;
      }
    });

    if (!mainCell) return;

    // ── Walk child elements in document order ─────────────────────────────
    let promptText = "";
    const attachmentNames: string[] = [];
    let rawTimestamp: string | null = null;
    let createdAt: number | null = null;
    const responseParts: string[] = [];

    type Phase = "before_prompt" | "after_prompt" | "response";
    let phase: Phase = "before_prompt";

    (mainCell as ReturnType<typeof $>).children().each((_, el) => {
      const $el = $(el);
      const tag = getTagName(el as { type: string; name?: string });
      const text = $el.text().trim();

      // ── Phase: looking for the "Prompted" paragraph ─────────────────────
      if (phase === "before_prompt") {
        const hasPromptedBold = $el
          .find("b, strong")
          .toArray()
          .some((b) => $(b).text().trim() === "Prompted");
        const rawStartsWithPrompted =
          text.startsWith("Prompted") && text.length > "Prompted".length;

        if (hasPromptedBold || rawStartsWithPrompted) {
          promptText = text.replace(/^Prompted\s*/i, "").trim();
          phase = "after_prompt";
        }
        return;
      }

      // ── Phase: prompt found, collecting attachments then timestamp ───────
      if (phase === "after_prompt") {
        // "Attached N files" label — informational only, skip
        if (/^Attached \d+ files?/i.test(text)) return;

        // Attachment list: <ul> or <ol> with one <a> per file
        if (tag === "ul" || tag === "ol") {
          $el.find("a").each((_, a) => {
            const name = $(a).text().trim();
            if (name) attachmentNames.push(name);
          });
          return;
        }

        // Try to find a timestamp in this element's text
        const raw = extractRawTimestamp(text);
        if (raw !== null) {
          rawTimestamp = raw;
          createdAt = parseGeminiTimestamp(text);
          phase = "response";
          return;
        }

        // Not a timestamp and not an attachment list — skip (e.g. "Attached 1 file" inline)
        return;
      }

      // ── Phase: collect Gemini response text ───────────────────────────────
      if (phase === "response") {
        if (text) responseParts.push(text);
      }
    });

    if (!promptText) return; // no parseable prompt → skip card

    const responseText = responseParts.join("\n\n");

    // ── Build user message content ────────────────────────────────────────
    let userContent = promptText;
    if (attachmentNames.length > 0) {
      const list = attachmentNames.map((n) => `- ${n}`).join("\n");
      userContent += `\n\n[Attached files:\n${list}\n]`;
    }

    // ── Deterministic IDs ─────────────────────────────────────────────────
    const promptHash = sha256(promptText);
    const responseHash = sha256(responseText);
    const attachmentKey = attachmentNames.slice().sort().join(",");
    const externalId = deterministicGeminiExternalId(
      rawTimestamp,
      promptHash,
      responseHash,
      attachmentKey
    );

    // Message IDs are derived from externalId + role — stable across re-imports.
    const userMsgId = sha256([externalId, "user"].join("|")).slice(0, 32);
    const asstMsgId = sha256([externalId, "assistant"].join("|")).slice(0, 32);

    // ── Title: first 80 chars of prompt ──────────────────────────────────
    const title =
      promptText.length > 0 ? promptText.slice(0, 80).trim() : "Gemini Activity";

    // ── Build message list ────────────────────────────────────────────────
    const messages: NormalizedMessage[] = [];

    messages.push({
      id: userMsgId,
      role: "user",
      content: userContent,
      contentHash: sha256(userContent),
      timestamp: createdAt,
    });

    if (responseText.trim()) {
      messages.push({
        id: asstMsgId,
        role: "assistant",
        content: responseText,
        contentHash: sha256(responseText),
        timestamp: createdAt,
      });
    }

    conversations.push({
      externalId,
      title,
      messages,
      createdAt,
      updatedAt: createdAt,
    });
  });

  return conversations;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a NormalizedConversation from Gemini into a Markdown string.
 * Uses "**Gemini**" as the assistant label and includes a provider line.
 */
export function geminiConversationToMarkdown(conv: NormalizedConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");
  lines.push("*Provider: Gemini*");
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
          ? "**Gemini**"
          : "**System**";

    lines.push(`### ${roleLabel}`);
    lines.push("");

    if (msg.timestamp) {
      const ts =
        new Date(msg.timestamp * 1000).toISOString().replace("T", " ").split(".")[0] +
        " UTC";
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
