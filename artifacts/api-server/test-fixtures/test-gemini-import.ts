/**
 * Unit tests for the Gemini parser + dedup logic.
 *
 * Run with:
 *   npx tsx artifacts/api-server/test-fixtures/test-gemini-import.ts
 *
 * Does NOT touch Supabase. Tests the parser and ZIP extractor in isolation.
 */

import {
  parseGeminiActivityHtml,
  geminiConversationToMarkdown,
  extractGeminiHtmlFromBuffer,
} from "../src/lib/gemini-parser";
import { sha256 } from "../src/lib/chatgpt-parser";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "sample-gemini-activity.html");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Simulate in-memory DB for dedup (mirrors import.ts logic)
// ---------------------------------------------------------------------------

interface StoredConversation {
  id: string;
  external_id: string;
  display_title: string;
  messages: Array<{
    external_id: string;
    content_hash: string;
    role: string;
    content: string;
  }>;
}

const db: StoredConversation[] = [];

function findConv(externalId: string): StoredConversation | undefined {
  return db.find((c) => c.external_id === externalId);
}

function dedupeMessages(
  incoming: Array<{ id: string; contentHash: string; role: string; content: string }>,
  existing: Array<{ external_id: string; content_hash: string }>
) {
  const existingIds = new Set<string>();
  for (const m of existing) {
    if (m.external_id) existingIds.add(m.external_id);
  }
  const batchIds = new Set<string>();
  const result = [];
  for (const m of incoming) {
    if (existingIds.has(m.id)) continue;
    if (batchIds.has(m.id)) continue;
    result.push(m);
    batchIds.add(m.id);
  }
  return result;
}

function simulateImport(
  convs: ReturnType<typeof parseGeminiActivityHtml>
): { newCount: number; updatedCount: number; skippedCount: number } {
  let newCount = 0,
    updatedCount = 0,
    skippedCount = 0;

  for (const conv of convs) {
    const existing = findConv(conv.externalId);

    if (existing) {
      const newMsgs = dedupeMessages(
        conv.messages,
        existing.messages.map((m) => ({
          external_id: m.external_id,
          content_hash: m.content_hash,
        }))
      );
      if (newMsgs.length > 0) {
        existing.display_title = conv.title;
        existing.messages.push(
          ...newMsgs.map((m) => ({
            external_id: m.id,
            content_hash: m.contentHash,
            role: m.role,
            content: m.content,
          }))
        );
        updatedCount++;
      } else {
        skippedCount++;
      }
    } else {
      const unique = dedupeMessages(conv.messages, []);
      db.push({
        id: `db-${db.length + 1}`,
        external_id: conv.externalId,
        display_title: conv.title,
        messages: unique.map((m) => ({
          external_id: m.id,
          content_hash: m.contentHash,
          role: m.role,
          content: m.content,
        })),
      });
      newCount++;
    }
  }

  return { newCount, updatedCount, skippedCount };
}

// ---------------------------------------------------------------------------
// Async main — all tests run here
// ---------------------------------------------------------------------------

async function main() {
  const fixtureHtml = readFileSync(FIXTURE_PATH, "utf-8");

  // ── Test: sha256 utility (used in parser) ──────────────────────────────────
  console.log("\nTest: sha256() via shared util");
  assert("produces 64-char hex", sha256("hello").length === 64);
  assert("is stable", sha256("hello") === sha256("hello"));

  // ── Test: parseGeminiActivityHtml() — basic shape ─────────────────────────
  console.log("\nTest: parseGeminiActivityHtml() — basic shape");
  const convs = parseGeminiActivityHtml(fixtureHtml);
  assert("parses 2 conversations", convs.length === 2, `got ${convs.length}`);

  // Card 1 — plain prompt
  const c1 = convs[0];
  assert(
    "card 1 title = first 80 chars of prompt",
    c1.title === "What is the speed of light?",
    `got "${c1.title}"`
  );
  assert(
    "card 1 externalId starts with det:",
    c1.externalId.startsWith("det:"),
    `got "${c1.externalId}"`
  );
  assert("card 1 externalId is 36 chars", c1.externalId.length === 36, `len=${c1.externalId.length}`);
  assert("card 1 has 2 messages", c1.messages.length === 2, `got ${c1.messages.length}`);
  assert("card 1 user role", c1.messages[0].role === "user");
  assert("card 1 assistant role", c1.messages[1].role === "assistant");
  assert(
    "card 1 user content = prompt",
    c1.messages[0].content === "What is the speed of light?",
    `got "${c1.messages[0].content}"`
  );
  assert(
    "card 1 assistant content contains 299,792,458",
    c1.messages[1].content.includes("299,792,458"),
    `got "${c1.messages[1].content}"`
  );
  assert("card 1 createdAt is non-null", c1.createdAt !== null, "null");
  assert("card 1 updatedAt === createdAt", c1.createdAt === c1.updatedAt);
  assert(
    "card 1 user contentHash is SHA-256 (64 chars)",
    c1.messages[0].contentHash.length === 64
  );

  // Card 2 — attachments + image preview
  const c2 = convs[1];
  assert(
    "card 2 title = first 80 chars of prompt",
    c2.title === "Can you analyze this dataset for trends?",
    `got "${c2.title}"`
  );
  assert("card 2 has 2 messages", c2.messages.length === 2, `got ${c2.messages.length}`);
  assert("card 2 user role", c2.messages[0].role === "user");
  assert("card 2 assistant role", c2.messages[1].role === "assistant");
  assert(
    "card 2 user content contains prompt",
    c2.messages[0].content.includes("Can you analyze this dataset for trends?"),
    `got "${c2.messages[0].content.slice(0, 100)}"`
  );
  assert(
    "card 2 user content has [Attached files:] block",
    c2.messages[0].content.includes("[Attached files:"),
    `got "${c2.messages[0].content}"`
  );
  assert(
    "card 2 attachment: Screenshot (69).png listed",
    c2.messages[0].content.includes("Screenshot (69).png"),
    `got "${c2.messages[0].content}"`
  );
  assert(
    "card 2 attachment: data-abc.json listed",
    c2.messages[0].content.includes("data-abc.json"),
    `got "${c2.messages[0].content}"`
  );
  assert(
    "card 2 image preview NOT included in assistant content",
    !c2.messages[1].content.includes("data:image"),
    `assistant content leaked image data`
  );
  assert(
    "card 2 caption NOT included in assistant content",
    !c2.messages[1].content.includes("Why is this here"),
    `caption leaked into assistant`
  );
  assert(
    "card 2 assistant content = trend analysis",
    c2.messages[1].content.includes("Q1") && c2.messages[1].content.includes("Q2"),
    `got "${c2.messages[1].content}"`
  );

  // ── Test: externalId stability ─────────────────────────────────────────────
  console.log("\nTest: externalId stability across re-parses");
  const convs2 = parseGeminiActivityHtml(fixtureHtml);
  assert(
    "card 1 externalId is stable",
    convs[0].externalId === convs2[0].externalId,
    `${convs[0].externalId} vs ${convs2[0].externalId}`
  );
  assert(
    "card 2 externalId is stable",
    convs[1].externalId === convs2[1].externalId,
    `${convs[1].externalId} vs ${convs2[1].externalId}`
  );
  assert(
    "card 1 and card 2 have distinct externalIds",
    convs[0].externalId !== convs[1].externalId
  );
  assert(
    "card 1 user message ID is stable",
    convs[0].messages[0].id === convs2[0].messages[0].id
  );
  assert(
    "card 1 assistant message ID is stable",
    convs[0].messages[1].id === convs2[0].messages[1].id
  );

  // ── Test: geminiConversationToMarkdown() ──────────────────────────────────
  console.log("\nTest: geminiConversationToMarkdown() — card 1");
  const md1 = geminiConversationToMarkdown(c1);
  assert(
    "starts with # title",
    md1.startsWith("# What is the speed of light?"),
    `got "${md1.slice(0, 60)}"`
  );
  assert("contains *Provider: Gemini*", md1.includes("*Provider: Gemini*"));
  assert("contains *Created:", md1.includes("*Created:"));
  assert("contains **You**", md1.includes("**You**"));
  assert("contains **Gemini**", md1.includes("**Gemini**"));
  assert("does not say **Assistant**", !md1.includes("**Assistant**"));
  assert("contains prompt content", md1.includes("What is the speed of light?"));
  assert("contains response content", md1.includes("299,792,458"));

  console.log("\nTest: geminiConversationToMarkdown() — card 2 (attachments)");
  const md2 = geminiConversationToMarkdown(c2);
  assert("card 2 title in markdown", md2.startsWith("# Can you analyze this dataset for trends?"));
  assert("card 2 attachment block in markdown", md2.includes("[Attached files:"));
  assert("card 2 screenshot in markdown", md2.includes("Screenshot (69).png"));
  assert("card 2 json file in markdown", md2.includes("data-abc.json"));
  assert("card 2 response in markdown", md2.includes("Q1") && md2.includes("Q2"));

  // ── Test: Dedup — first import (all new) ──────────────────────────────────
  console.log("\nTest: First import (all new)");
  const run1 = simulateImport(convs);
  assert("newCount = 2", run1.newCount === 2, `got ${run1.newCount}`);
  assert("updatedCount = 0", run1.updatedCount === 0, `got ${run1.updatedCount}`);
  assert("skippedCount = 0", run1.skippedCount === 0, `got ${run1.skippedCount}`);
  assert("db has 2 conversations", db.length === 2);
  assert("card 1 has 2 messages", db[0].messages.length === 2, `got ${db[0].messages.length}`);
  assert("card 2 has 2 messages", db[1].messages.length === 2, `got ${db[1].messages.length}`);

  // ── Test: Dedup — second import identical (all skipped) ───────────────────
  console.log("\nTest: Second import (identical — all skipped)");
  const run2 = simulateImport(parseGeminiActivityHtml(fixtureHtml));
  assert("newCount = 0", run2.newCount === 0, `got ${run2.newCount}`);
  assert("updatedCount = 0", run2.updatedCount === 0, `got ${run2.updatedCount}`);
  assert("skippedCount = 2", run2.skippedCount === 2, `got ${run2.skippedCount}`);
  assert("db still has 2 conversations", db.length === 2);

  // ── Test: Dedup — modified import (response updated for card 1) ───────────
  console.log("\nTest: Third import (card 1 response updated)");
  const modifiedHtml = fixtureHtml.replace(
    "The speed of light in a vacuum is approximately 299,792,458 meters per second.",
    "The speed of light in a vacuum is approximately 299,792,458 meters per second. It is denoted by c."
  );
  const modifiedConvs = parseGeminiActivityHtml(modifiedHtml);

  // externalId must differ when response changes (response hash is part of the ID)
  assert(
    "modified card 1 has different externalId (response changed → new card)",
    modifiedConvs[0].externalId !== convs[0].externalId,
    `both got "${modifiedConvs[0].externalId}"`
  );
  // Card 2 is unchanged → same externalId
  assert(
    "unmodified card 2 keeps same externalId",
    modifiedConvs[1].externalId === convs[1].externalId
  );

  const run3 = simulateImport(modifiedConvs);
  // modified card 1 is a NEW conversation (different externalId = different activity entry)
  // card 2 is skipped (identical)
  assert("run3 newCount = 1 (modified card is new)", run3.newCount === 1, `got ${run3.newCount}`);
  assert("run3 skippedCount = 1", run3.skippedCount === 1, `got ${run3.skippedCount}`);

  // ── Test: ZIP import with nested path ─────────────────────────────────────
  console.log("\nTest: ZIP import (Takeout/My Activity/Gemini Apps/MyActivity.html)");
  const zip = new JSZip();
  zip.file("Takeout/My Activity/Gemini Apps/MyActivity.html", fixtureHtml);
  zip.file("Takeout/My Activity/Gemini Apps/attachments/Screenshot (69).png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.file("Takeout/My Activity/Gemini Apps/attachments/data-abc.json", '{"x":1}');
  zip.file("Takeout/My Activity/Gemini Apps/attachments/analysis.py", "import pandas as pd");
  zip.file("Takeout/My Activity/Search/MyActivity.html", "<html><body>not gemini</body></html>");

  const zipBuffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  const extractedHtml = await extractGeminiHtmlFromBuffer(zipBuffer);
  const zipConvs = parseGeminiActivityHtml(extractedHtml);

  assert("ZIP: extracted correct MyActivity.html (Gemini preferred)", zipConvs.length === 2, `got ${zipConvs.length}`);
  assert(
    "ZIP: attachment PNGs NOT imported as conversations",
    zipConvs.every((c) => c.messages[0].role === "user")
  );
  assert(
    "ZIP: card 1 externalId matches raw HTML parse",
    zipConvs[0].externalId === convs[0].externalId,
    `zip=${zipConvs[0].externalId} raw=${convs[0].externalId}`
  );
  assert(
    "ZIP: card 2 externalId matches raw HTML parse",
    zipConvs[1].externalId === convs[1].externalId
  );

  // ── Test: ZIP with no MyActivity.html → clear error ───────────────────────
  console.log("\nTest: ZIP with no MyActivity.html throws a clear error");
  const emptyZip = new JSZip();
  emptyZip.file("some-random-file.json", "{}");
  const emptyZipBuf = Buffer.from(await emptyZip.generateAsync({ type: "nodebuffer" }));
  let zipErrorMsg = "";
  try {
    await extractGeminiHtmlFromBuffer(emptyZipBuf);
  } catch (e) {
    zipErrorMsg = String(e);
  }
  assert(
    "missing MyActivity.html throws an error",
    zipErrorMsg.includes("MyActivity.html"),
    `got "${zipErrorMsg}"`
  );

  // ── Test: Raw HTML buffer (non-ZIP) ───────────────────────────────────────
  console.log("\nTest: Raw HTML buffer (non-ZIP)");
  const rawBuf = Buffer.from(fixtureHtml, "utf-8");
  const rawExtracted = await extractGeminiHtmlFromBuffer(rawBuf);
  const rawConvs = parseGeminiActivityHtml(rawExtracted);
  assert("raw HTML: 2 conversations", rawConvs.length === 2, `got ${rawConvs.length}`);
  assert(
    "raw HTML: same externalId as fixture parse",
    rawConvs[0].externalId === convs[0].externalId
  );

  // ── Test: Repeated identical prompts with different timestamps ────────────
  // Two cards with the same prompt + response but different timestamps must
  // produce distinct externalIds (since rawTimestamp is part of the hash)
  // and both must survive the first import.
  console.log("\nTest: Repeated identical prompts, different timestamps → both preserved");
  const repeatedHtml = `
<!DOCTYPE html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="mdl-cell mdl-cell--12-col header-cell"><p>Gemini Apps</p></div>
    <div class="content-cell mdl-cell mdl-cell--6-col">
      <p><b>Prompted</b> Tell me a fun fact.</p>
      <p>Apr 17, 2025, 9:00:00 AM PDT</p>
      <p>Honey never spoils.</p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-cell--2-col-tablet"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col caption-cell"></div>
  </div>
</div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="mdl-cell mdl-cell--12-col header-cell"><p>Gemini Apps</p></div>
    <div class="content-cell mdl-cell mdl-cell--6-col">
      <p><b>Prompted</b> Tell me a fun fact.</p>
      <p>Apr 18, 2025, 3:00:00 PM PDT</p>
      <p>Honey never spoils.</p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-cell--2-col-tablet"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col caption-cell"></div>
  </div>
</div>
</body></html>`;

  const repeatedConvs = parseGeminiActivityHtml(repeatedHtml);
  assert("repeated: 2 conversations parsed", repeatedConvs.length === 2, `got ${repeatedConvs.length}`);
  assert(
    "repeated: same prompt text",
    repeatedConvs[0].messages[0].content === repeatedConvs[1].messages[0].content
  );
  assert(
    "repeated: different externalIds (timestamps differ)",
    repeatedConvs[0].externalId !== repeatedConvs[1].externalId,
    `both got "${repeatedConvs[0].externalId}"`
  );

  const dbRepeated: StoredConversation[] = [];
  function findRepeated(eid: string) {
    return dbRepeated.find((c) => c.external_id === eid);
  }
  function simImportRepeated(convList: typeof repeatedConvs) {
    let newC = 0, skippedC = 0;
    for (const conv of convList) {
      const ex = findRepeated(conv.externalId);
      if (ex) { skippedC++; }
      else {
        dbRepeated.push({
          id: `r-${dbRepeated.length + 1}`,
          external_id: conv.externalId,
          display_title: conv.title,
          messages: conv.messages.map((m) => ({
            external_id: m.id, content_hash: m.contentHash, role: m.role, content: m.content,
          })),
        });
        newC++;
      }
    }
    return { newCount: newC, skippedCount: skippedC };
  }

  const rrRun1 = simImportRepeated(repeatedConvs);
  assert("repeated first import: newCount = 2", rrRun1.newCount === 2, `got ${rrRun1.newCount}`);
  assert("repeated first import: both stored", dbRepeated.length === 2);

  const rrRun2 = simImportRepeated(parseGeminiActivityHtml(repeatedHtml));
  assert("repeated re-import: newCount = 0", rrRun2.newCount === 0, `got ${rrRun2.newCount}`);
  assert("repeated re-import: skippedCount = 2", rrRun2.skippedCount === 2, `got ${rrRun2.skippedCount}`);

  // ── Test: Card with no response still parses user message ─────────────────
  console.log("\nTest: Card with no Gemini response — only user message stored");
  const noResponseHtml = `
<!DOCTYPE html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="mdl-cell mdl-cell--12-col header-cell"><p>Gemini Apps</p></div>
    <div class="content-cell mdl-cell mdl-cell--6-col">
      <p><b>Prompted</b> This one has no response yet.</p>
      <p>Apr 19, 2025, 8:00:00 AM PDT</p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-cell--2-col-tablet"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col caption-cell"></div>
  </div>
</div>
</body></html>`;
  const noRespConvs = parseGeminiActivityHtml(noResponseHtml);
  assert("no-response card: 1 conversation", noRespConvs.length === 1, `got ${noRespConvs.length}`);
  assert("no-response card: 1 message (user only)", noRespConvs[0].messages.length === 1, `got ${noRespConvs[0].messages.length}`);
  assert("no-response card: message is user role", noRespConvs[0].messages[0].role === "user");

  // ── Test: Non-Gemini outer-cell cards are skipped (no "Prompted") ─────────
  console.log("\nTest: Non-Gemini cards without Prompted are skipped");
  const mixedHtml = `
<!DOCTYPE html><html><body>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="mdl-cell mdl-cell--12-col header-cell"><p>YouTube</p></div>
    <div class="content-cell mdl-cell mdl-cell--6-col">
      <p>Watched a video about cats.</p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-cell--2-col-tablet"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col caption-cell"></div>
  </div>
</div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="mdl-cell mdl-cell--12-col header-cell"><p>Gemini Apps</p></div>
    <div class="content-cell mdl-cell mdl-cell--6-col">
      <p><b>Prompted</b> What is 2 + 2?</p>
      <p>Apr 20, 2025, 12:00:00 PM PDT</p>
      <p>2 + 2 equals 4.</p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-cell--2-col-tablet"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col caption-cell"></div>
  </div>
</div>
</body></html>`;
  const mixedConvs = parseGeminiActivityHtml(mixedHtml);
  assert(
    "non-Gemini card skipped: only 1 conversation",
    mixedConvs.length === 1,
    `got ${mixedConvs.length}`
  );
  assert(
    "only Gemini card imported",
    mixedConvs[0].messages[0].content === "What is 2 + 2?",
    `got "${mixedConvs[0].messages[0].content}"`
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
