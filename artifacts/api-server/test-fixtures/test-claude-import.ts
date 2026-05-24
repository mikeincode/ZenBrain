/**
 * Manual integration test for the Claude parser + dedup logic.
 *
 * Run with:
 *   npx tsx artifacts/api-server/test-fixtures/test-claude-import.ts
 *
 * Does NOT touch Supabase. Tests the parser and dedup helpers in isolation.
 */

import { parseClaudeExport, claudeConversationToMarkdown } from "../src/lib/claude-parser";
import { sha256 } from "../src/lib/chatgpt-parser";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "sample-claude-conversations.json");

// ---------------------------------------------------------------------------
// Helpers
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
  messages: Array<{ external_id: string; content_hash: string; role: string; content: string }>;
}

const db: StoredConversation[] = [];

function findConv(externalId: string): StoredConversation | undefined {
  return db.find((c) => c.external_id === externalId);
}

function dedupeMessages(
  incoming: Array<{ id: string; contentHash: string; role: string; content: string }>,
  existing: Array<{ external_id: string; content_hash: string }>
) {
  // Mirror production import.ts: ID-only cross-import dedup.
  // Hash-based cross-import dedup was removed to preserve legitimately repeated
  // messages that share content but have distinct IDs.
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
  parsed: unknown
): { newCount: number; updatedCount: number; skippedCount: number } {
  const convs = parseClaudeExport(parsed);
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
// Load fixture
// ---------------------------------------------------------------------------

const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Tests: sha256 (shared util — confirm it works from claude-parser re-export)
// ---------------------------------------------------------------------------

console.log("\nTest: sha256() via shared util");
assert("produces 64-char hex", sha256("hello").length === 64);
assert("is stable", sha256("hello") === sha256("hello"));

// ---------------------------------------------------------------------------
// Tests: parseClaudeExport()
// ---------------------------------------------------------------------------

console.log("\nTest: parseClaudeExport() — basic shape");
const convs = parseClaudeExport(raw);
assert("parses 2 conversations", convs.length === 2, `got ${convs.length}`);
assert(
  "first conv has correct title",
  convs[0].title === "Claude Fixture Conversation Alpha",
  `got "${convs[0].title}"`
);
assert(
  "first conv externalId = uuid",
  convs[0].externalId === "claude-conv-fixture-001",
  `got "${convs[0].externalId}"`
);
assert("first conv has 2 messages", convs[0].messages.length === 2, `got ${convs[0].messages.length}`);
assert("first message role is user", convs[0].messages[0].role === "user");
assert("second message role is assistant", convs[0].messages[1].role === "assistant");
assert(
  "user message content correct",
  convs[0].messages[0].content === "What is the speed of light?",
  `got "${convs[0].messages[0].content}"`
);
assert(
  "assistant message content correct",
  convs[0].messages[1].content.includes("299,792,458"),
  `got "${convs[0].messages[1].content}"`
);
assert(
  "message uuid used as id",
  convs[0].messages[0].id === "claude-msg-001",
  `got "${convs[0].messages[0].id}"`
);
assert(
  "contentHash is SHA-256 (64 chars)",
  convs[0].messages[0].contentHash.length === 64
);
assert(
  "createdAt parsed to unix seconds",
  convs[0].createdAt !== null && convs[0].createdAt > 0,
  `got ${convs[0].createdAt}`
);
assert(
  "createdAt is 2024-01-15",
  new Date((convs[0].createdAt ?? 0) * 1000).toISOString().startsWith("2024-01-15"),
  `got ${new Date((convs[0].createdAt ?? 0) * 1000).toISOString()}`
);
assert(
  "second conv has correct title",
  convs[1].title === "Claude Fixture Conversation Beta",
  `got "${convs[1].title}"`
);
assert("second conv has 2 messages", convs[1].messages.length === 2, `got ${convs[1].messages.length}`);

// ---------------------------------------------------------------------------
// Tests: content block extraction vs text fallback
// ---------------------------------------------------------------------------

console.log("\nTest: parseClaudeExport() — content block extraction");
const textOnlyRaw = [
  {
    uuid: "text-only-conv",
    name: "Text Only Conv",
    created_at: "2024-02-01T00:00:00.000000+00:00",
    updated_at: "2024-02-01T00:00:00.000000+00:00",
    chat_messages: [
      {
        uuid: "t-msg-001",
        sender: "human",
        created_at: "2024-02-01T00:00:00.000000+00:00",
        updated_at: "2024-02-01T00:00:00.000000+00:00",
        text: "Fallback text content",
        content: null, // null content → fall back to text field
        files: [],
        attachments: [],
      },
    ],
  },
];
const textOnlyConvs = parseClaudeExport(textOnlyRaw);
assert(
  "falls back to text field when content is null",
  textOnlyConvs[0].messages[0].content === "Fallback text content",
  `got "${textOnlyConvs[0].messages[0].content}"`
);

const multiBlockRaw = [
  {
    uuid: "multi-block-conv",
    name: "Multi Block Conv",
    created_at: "2024-02-01T00:00:00.000000+00:00",
    updated_at: "2024-02-01T00:00:00.000000+00:00",
    chat_messages: [
      {
        uuid: "mb-msg-001",
        sender: "assistant",
        created_at: "2024-02-01T00:00:00.000000+00:00",
        updated_at: "2024-02-01T00:00:00.000000+00:00",
        text: "Combined text",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "tool_use", id: "tu-1", name: "search" }, // → gets placeholder
          { type: "text", text: "Second paragraph." },
          { type: "thinking", thinking: "internal reasoning" }, // → gets placeholder
        ],
        files: [],
        attachments: [],
      },
    ],
  },
];
const multiBlockConvs = parseClaudeExport(multiBlockRaw);
const mbc = multiBlockConvs[0].messages[0].content;
assert(
  "joins multiple text blocks with placeholders",
  mbc === "First paragraph.\n\n[Tool use omitted]\n\nSecond paragraph.\n\n[Thinking block omitted]",
  `got "${mbc}"`
);
assert("tool_use block produces placeholder", mbc.includes("[Tool use omitted]"));
assert("tool internals not leaked", !mbc.includes("search"));
assert("thinking block produces placeholder", mbc.includes("[Thinking block omitted]"));
assert("thinking internals not leaked", !mbc.includes("internal reasoning"));

const emptyMsgRaw = [
  {
    uuid: "empty-msg-conv",
    name: "Empty Msg Conv",
    created_at: "2024-02-01T00:00:00.000000+00:00",
    updated_at: "2024-02-01T00:00:00.000000+00:00",
    chat_messages: [
      {
        uuid: "em-001",
        sender: "human",
        created_at: "2024-02-01T00:00:00.000000+00:00",
        updated_at: "2024-02-01T00:00:00.000000+00:00",
        text: "",
        content: [], // empty content array + empty text → truly no renderable output
        files: [],
        attachments: [],
      },
      {
        uuid: "em-002",
        sender: "assistant",
        created_at: "2024-02-01T00:00:00.000000+00:00",
        updated_at: "2024-02-01T00:00:00.000000+00:00",
        text: "Valid response",
        content: [{ type: "text", text: "Valid response" }],
        files: [],
        attachments: [],
      },
    ],
  },
];
const emptyMsgConvs = parseClaudeExport(emptyMsgRaw);
assert(
  "skips messages with no renderable content",
  emptyMsgConvs[0].messages.length === 1,
  `got ${emptyMsgConvs[0].messages.length}`
);
assert(
  "only valid message kept",
  emptyMsgConvs[0].messages[0].content === "Valid response"
);

// ---------------------------------------------------------------------------
// Tests: deterministic fallback external_id
// ---------------------------------------------------------------------------

console.log("\nTest: deterministic fallback external_id");
const noIdRaw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
delete noIdRaw[0].uuid;
const convNoId1 = parseClaudeExport(noIdRaw);
const convNoId2 = parseClaudeExport(noIdRaw);
assert("fallback ID starts with 'det:'", convNoId1[0].externalId.startsWith("det:"));
assert(
  "fallback ID is stable across calls",
  convNoId1[0].externalId === convNoId2[0].externalId
);
assert(
  "fallback ID differs between conversations",
  convNoId1[0].externalId !== convNoId1[1].externalId
);

// Msg without uuid — fallback uses sha256(role|content)
const noMsgIdRaw = [
  {
    uuid: "conv-no-msg-id",
    name: "No Msg ID Conv",
    created_at: "2024-03-01T00:00:00.000000+00:00",
    updated_at: "2024-03-01T00:00:00.000000+00:00",
    chat_messages: [
      {
        // no uuid field
        sender: "human",
        created_at: "2024-03-01T00:00:00.000000+00:00",
        updated_at: "2024-03-01T00:00:00.000000+00:00",
        text: "No ID message",
        content: [{ type: "text", text: "No ID message" }],
      },
    ],
  },
];
const noMsgIdConvs1 = parseClaudeExport(noMsgIdRaw);
const noMsgIdConvs2 = parseClaudeExport(noMsgIdRaw);
assert(
  "msg without uuid gets stable derived id",
  noMsgIdConvs1[0].messages[0].id === noMsgIdConvs2[0].messages[0].id
);
assert(
  "msg derived id is non-empty",
  noMsgIdConvs1[0].messages[0].id.length > 0
);

// ---------------------------------------------------------------------------
// Tests: claudeConversationToMarkdown()
// ---------------------------------------------------------------------------

console.log("\nTest: claudeConversationToMarkdown()");
const md = claudeConversationToMarkdown(convs[0]);
assert("starts with # title", md.startsWith("# Claude Fixture Conversation Alpha"));
assert("contains provider label", md.includes("*Provider: Claude*"));
assert("contains created date", md.includes("2024-01-15"));
assert("contains updated date", md.includes("2024-01-15"));
assert("contains You label for human", md.includes("**You**"));
assert("contains Claude label for assistant", md.includes("**Claude**"));
assert("does not contain generic Assistant label", !md.includes("**Assistant**"));
assert("contains user message content", md.includes("What is the speed of light?"));
assert("contains assistant message content", md.includes("299,792,458"));

// ---------------------------------------------------------------------------
// Tests: Import scenarios (dedup)
// ---------------------------------------------------------------------------

console.log("\nTest: First import (all new)");
const run1 = simulateImport(raw);
assert("newCount = 2", run1.newCount === 2, `got ${run1.newCount}`);
assert("updatedCount = 0", run1.updatedCount === 0, `got ${run1.updatedCount}`);
assert("skippedCount = 0", run1.skippedCount === 0, `got ${run1.skippedCount}`);
assert("db has 2 conversations", db.length === 2);
assert("conv alpha has 2 messages", db[0].messages.length === 2, `got ${db[0].messages.length}`);
assert("conv beta has 2 messages", db[1].messages.length === 2, `got ${db[1].messages.length}`);

console.log("\nTest: Second import (identical — all skipped)");
const run2 = simulateImport(raw);
assert("newCount = 0", run2.newCount === 0, `got ${run2.newCount}`);
assert("updatedCount = 0", run2.updatedCount === 0, `got ${run2.updatedCount}`);
assert("skippedCount = 2", run2.skippedCount === 2, `got ${run2.skippedCount}`);
assert("db still has 2 conversations", db.length === 2);

console.log("\nTest: Third import (conv alpha gets a new message)");
const rawModified = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
rawModified[0].chat_messages.push({
  uuid: "claude-msg-003",
  sender: "human",
  created_at: "2024-01-15T10:40:00.000000+00:00",
  updated_at: "2024-01-15T10:40:00.000000+00:00",
  text: "What about Planck's constant?",
  content: [{ type: "text", text: "What about Planck's constant?" }],
  files: [],
  attachments: [],
});
rawModified[0].updated_at = "2024-01-15T10:40:00.000000+00:00";

const run3 = simulateImport(rawModified);
assert("newCount = 0", run3.newCount === 0, `got ${run3.newCount}`);
assert("updatedCount = 1", run3.updatedCount === 1, `got ${run3.updatedCount}`);
assert("skippedCount = 1", run3.skippedCount === 1, `got ${run3.skippedCount}`);
assert("alpha conv now has 3 messages", db[0].messages.length === 3, `got ${db[0].messages.length}`);
assert("beta conv unchanged at 2 messages", db[1].messages.length === 2, `got ${db[1].messages.length}`);
assert(
  "new message content correct",
  db[0].messages[2].content === "What about Planck's constant?",
  `got "${db[0].messages[2].content}"`
);

console.log("\nTest: Fourth import (re-import of modified — no duplicates)");
const run4 = simulateImport(rawModified);
assert("newCount = 0", run4.newCount === 0, `got ${run4.newCount}`);
assert("updatedCount = 0", run4.updatedCount === 0, `got ${run4.updatedCount}`);
assert("skippedCount = 2", run4.skippedCount === 2, `got ${run4.skippedCount}`);
assert(
  "alpha conv still has 3 messages (no duplicates)",
  db[0].messages.length === 3,
  `got ${db[0].messages.length}`
);

// ---------------------------------------------------------------------------
// Tests: repeated identical messages in the same conversation
// ---------------------------------------------------------------------------
//
// Scenario: a conversation where the user asks the same thing twice and the
// assistant gives the same answer twice (legitimately repeated content, no uuid).
// All four messages must survive the first import without being collapsed by
// hash-based dedup.  A subsequent re-import must produce zero new messages.

console.log("\nTest: Repeated identical messages — first import preserves all");

// Inline fixture — no uuid on messages to exercise the fallback ID path.
const repeatedRaw = [
  {
    uuid: "claude-repeat-conv-001",
    name: "Repeated Messages Conv",
    created_at: "2024-03-10T12:00:00.000000+00:00",
    updated_at: "2024-03-10T12:05:00.000000+00:00",
    chat_messages: [
      {
        // no uuid — fallback ID uses index 0
        sender: "human",
        created_at: "2024-03-10T12:00:00.000000+00:00",
        updated_at: "2024-03-10T12:00:00.000000+00:00",
        text: "Tell me a joke.",
        content: [{ type: "text", text: "Tell me a joke." }],
      },
      {
        // no uuid — fallback ID uses index 1
        sender: "assistant",
        created_at: "2024-03-10T12:01:00.000000+00:00",
        updated_at: "2024-03-10T12:01:00.000000+00:00",
        text: "Why did the chicken cross the road? To get to the other side.",
        content: [{ type: "text", text: "Why did the chicken cross the road? To get to the other side." }],
      },
      {
        // no uuid — same content as index 0, but index 2 → different fallback ID
        sender: "human",
        created_at: "2024-03-10T12:02:00.000000+00:00",
        updated_at: "2024-03-10T12:02:00.000000+00:00",
        text: "Tell me a joke.",
        content: [{ type: "text", text: "Tell me a joke." }],
      },
      {
        // no uuid — same content as index 1, but index 3 → different fallback ID
        sender: "assistant",
        created_at: "2024-03-10T12:03:00.000000+00:00",
        updated_at: "2024-03-10T12:03:00.000000+00:00",
        text: "Why did the chicken cross the road? To get to the other side.",
        content: [{ type: "text", text: "Why did the chicken cross the road? To get to the other side." }],
      },
    ],
  },
];

// Parse and confirm 4 distinct IDs are generated despite identical content.
const repeatedConvs = parseClaudeExport(repeatedRaw);
assert("repeated conv has 4 messages", repeatedConvs[0].messages.length === 4,
  `got ${repeatedConvs[0].messages.length}`);

const [rm0, rm1, rm2, rm3] = repeatedConvs[0].messages;
assert("msg 0 role = user",  rm0.role === "user");
assert("msg 1 role = assistant", rm1.role === "assistant");
assert("msg 2 role = user",  rm2.role === "user");
assert("msg 3 role = assistant", rm3.role === "assistant");
assert("msg 0 and msg 2 have same content",  rm0.content === rm2.content);
assert("msg 1 and msg 3 have same content",  rm1.content === rm3.content);
assert("msg 0 and msg 2 have different IDs", rm0.id !== rm2.id,
  `both got "${rm0.id}"`);
assert("msg 1 and msg 3 have different IDs", rm1.id !== rm3.id,
  `both got "${rm1.id}"`);
assert("all 4 IDs are unique", new Set([rm0.id, rm1.id, rm2.id, rm3.id]).size === 4,
  `IDs: ${[rm0.id, rm1.id, rm2.id, rm3.id].join(", ")}`);

// First import into a fresh in-memory DB — all 4 messages must be stored.
const dbRepeat: StoredConversation[] = [];
function findRepeatConv(eid: string) { return dbRepeat.find(c => c.external_id === eid); }

function simulateRepeatImport(parsed: unknown) {
  const convs = parseClaudeExport(parsed);
  let newCount = 0, updatedCount = 0, skippedCount = 0;
  for (const conv of convs) {
    const existing = findRepeatConv(conv.externalId);
    if (existing) {
      const newMsgs = dedupeMessages(conv.messages,
        existing.messages.map(m => ({ external_id: m.external_id, content_hash: m.content_hash })));
      if (newMsgs.length > 0) {
        existing.messages.push(...newMsgs.map(m => ({
          external_id: m.id, content_hash: m.contentHash, role: m.role, content: m.content,
        })));
        updatedCount++;
      } else { skippedCount++; }
    } else {
      const unique = dedupeMessages(conv.messages, []);
      dbRepeat.push({
        id: `dbr-${dbRepeat.length + 1}`,
        external_id: conv.externalId,
        display_title: conv.title,
        messages: unique.map(m => ({
          external_id: m.id, content_hash: m.contentHash, role: m.role, content: m.content,
        })),
      });
      newCount++;
    }
  }
  return { newCount, updatedCount, skippedCount };
}

const runR1 = simulateRepeatImport(repeatedRaw);
assert("first import: newCount = 1",     runR1.newCount === 1,     `got ${runR1.newCount}`);
assert("first import: updatedCount = 0", runR1.updatedCount === 0, `got ${runR1.updatedCount}`);
assert("first import: skippedCount = 0", runR1.skippedCount === 0, `got ${runR1.skippedCount}`);
assert("all 4 repeated messages stored", dbRepeat[0].messages.length === 4,
  `got ${dbRepeat[0].messages.length}`);
assert("stored msg 0 content correct",
  dbRepeat[0].messages[0].content === "Tell me a joke.");
assert("stored msg 2 content is also 'Tell me a joke.'",
  dbRepeat[0].messages[2].content === "Tell me a joke.");
assert("msg 0 and msg 2 have different stored IDs",
  dbRepeat[0].messages[0].external_id !== dbRepeat[0].messages[2].external_id);

console.log("\nTest: Repeated identical messages — re-import produces no duplicates");
const runR2 = simulateRepeatImport(repeatedRaw);
assert("re-import: newCount = 0",     runR2.newCount === 0,     `got ${runR2.newCount}`);
assert("re-import: updatedCount = 0", runR2.updatedCount === 0, `got ${runR2.updatedCount}`);
assert("re-import: skippedCount = 1", runR2.skippedCount === 1, `got ${runR2.skippedCount}`);
assert("still exactly 4 messages after re-import", dbRepeat[0].messages.length === 4,
  `got ${dbRepeat[0].messages.length}`);

// ---------------------------------------------------------------------------
// Tests: non-text block placeholders (comprehensive)
// ---------------------------------------------------------------------------

console.log("\nTest: Claude non-text block placeholders");
const placeholderRaw = [
  {
    uuid: "claude-placeholder-conv",
    name: "Placeholder Conv",
    created_at: "2024-04-01T00:00:00.000000+00:00",
    updated_at: "2024-04-01T00:01:00.000000+00:00",
    chat_messages: [
      {
        uuid: "ph-msg-001",
        sender: "assistant",
        created_at: "2024-04-01T00:01:00.000000+00:00",
        updated_at: "2024-04-01T00:01:00.000000+00:00",
        text: "",
        content: [
          { type: "thinking", thinking: "Let me reason step by step." },
          { type: "text", text: "Here is my answer." },
          { type: "tool_use", id: "tool-001", name: "calculator", input: { expr: "2+2" } },
          { type: "tool_result", tool_use_id: "tool-001", content: "4" },
        ],
        files: [],
        attachments: [],
      },
    ],
  },
];
const placeholderConvs = parseClaudeExport(placeholderRaw);
assert(
  "placeholder conv has 1 message",
  placeholderConvs[0].messages.length === 1,
  `got ${placeholderConvs[0].messages.length}`
);
const pc = placeholderConvs[0].messages[0].content;
assert("thinking block gets placeholder", pc.includes("[Thinking block omitted]"), `got: "${pc}"`);
assert("thinking internals not in output", !pc.includes("step by step"));
assert("text content preserved",          pc.includes("Here is my answer."),        `got: "${pc}"`);
assert("tool_use gets placeholder",        pc.includes("[Tool use omitted]"),         `got: "${pc}"`);
assert("tool name not leaked",             !pc.includes("calculator"));
assert("tool_result gets placeholder",     pc.includes("[Tool result omitted]"),      `got: "${pc}"`);
assert("tool result value not leaked",     !pc.includes('"4"'));

// File attachment placeholder via the message-level "files" array.
const fileAttachRaw = [
  {
    uuid: "claude-file-attach-conv",
    name: "File Attach Conv",
    created_at: "2024-04-02T00:00:00.000000+00:00",
    updated_at: "2024-04-02T00:00:00.000000+00:00",
    chat_messages: [
      {
        uuid: "fa-msg-001",
        sender: "human",
        created_at: "2024-04-02T00:00:00.000000+00:00",
        updated_at: "2024-04-02T00:00:00.000000+00:00",
        text: "See attached.",
        content: [{ type: "text", text: "See attached." }],
        files: [
          { file_name: "report.pdf", file_type: "application/pdf", extracted_content: "..." },
          { file_name: "photo.jpg",  file_type: "image/jpeg" },
        ],
        attachments: [],
      },
    ],
  },
];
const fileAttachConvs = parseClaudeExport(fileAttachRaw);
const fac = fileAttachConvs[0].messages[0].content;
assert("text before attachments preserved", fac.includes("See attached."), `got: "${fac}"`);
assert("pdf file gets File attachment placeholder",   fac.includes("[File attachment]"),  `got: "${fac}"`);
assert("image file gets Image attachment placeholder", fac.includes("[Image attachment]"), `got: "${fac}"`);

// ---------------------------------------------------------------------------
// Tests: repeated identical message appended on a later import is preserved
// ---------------------------------------------------------------------------
//
// Scenario: first export has [A, B]. A later export adds C where content(C) ==
// content(A) but C has a fresh UUID. With hash-based cross-import dedup C would
// have been incorrectly skipped. With ID-only dedup it is correctly imported.

console.log("\nTest: Claude repeated-content message appended on later import");

const laterBase = [
  {
    uuid: "lr-conv-001",
    name: "Later Repeat Conv",
    created_at: "2024-05-01T00:00:00.000000+00:00",
    updated_at: "2024-05-01T00:05:00.000000+00:00",
    chat_messages: [
      {
        uuid: "lr-msg-001",
        sender: "human",
        created_at: "2024-05-01T00:01:00.000000+00:00",
        updated_at: "2024-05-01T00:01:00.000000+00:00",
        text: "Hello",
        content: [{ type: "text", text: "Hello" }],
        files: [],
        attachments: [],
      },
      {
        uuid: "lr-msg-002",
        sender: "assistant",
        created_at: "2024-05-01T00:02:00.000000+00:00",
        updated_at: "2024-05-01T00:02:00.000000+00:00",
        text: "Hi there!",
        content: [{ type: "text", text: "Hi there!" }],
        files: [],
        attachments: [],
      },
    ],
  },
];

// Later export: same two messages PLUS a new one with content == msg-001.
const laterModified = [
  {
    ...laterBase[0],
    updated_at: "2024-05-01T00:10:00.000000+00:00",
    chat_messages: [
      ...laterBase[0].chat_messages,
      {
        uuid: "lr-msg-003", // NEW uuid — different from lr-msg-001
        sender: "human",
        created_at: "2024-05-01T00:09:00.000000+00:00",
        updated_at: "2024-05-01T00:09:00.000000+00:00",
        text: "Hello",           // identical content to lr-msg-001
        content: [{ type: "text", text: "Hello" }],
        files: [],
        attachments: [],
      },
    ],
  },
];

const dbLR: StoredConversation[] = [];
function findLRConv(eid: string) { return dbLR.find(c => c.external_id === eid); }
function simulateLRImport(parsed: unknown) {
  const convs = parseClaudeExport(parsed);
  let newCount = 0, updatedCount = 0, skippedCount = 0;
  for (const conv of convs) {
    const existing = findLRConv(conv.externalId);
    if (existing) {
      const newMsgs = dedupeMessages(conv.messages,
        existing.messages.map(m => ({ external_id: m.external_id, content_hash: m.content_hash })));
      if (newMsgs.length > 0) {
        existing.messages.push(...newMsgs.map(m => ({
          external_id: m.id, content_hash: m.contentHash, role: m.role, content: m.content,
        })));
        updatedCount++;
      } else { skippedCount++; }
    } else {
      const unique = dedupeMessages(conv.messages, []);
      dbLR.push({
        id: `dblr-${dbLR.length + 1}`,
        external_id: conv.externalId,
        display_title: conv.title,
        messages: unique.map(m => ({
          external_id: m.id, content_hash: m.contentHash, role: m.role, content: m.content,
        })),
      });
      newCount++;
    }
  }
  return { newCount, updatedCount, skippedCount };
}

const lrRun1 = simulateLRImport(laterBase);
assert("LR run1: newCount = 1",     lrRun1.newCount === 1,     `got ${lrRun1.newCount}`);
assert("LR run1: 2 messages stored", dbLR[0].messages.length === 2, `got ${dbLR[0].messages.length}`);

const lrRun2 = simulateLRImport(laterModified);
assert("LR run2: updatedCount = 1",    lrRun2.updatedCount === 1, `got ${lrRun2.updatedCount}`);
assert("LR run2: skippedCount = 0",    lrRun2.skippedCount === 0, `got ${lrRun2.skippedCount}`);
assert("LR run2: now 3 messages",      dbLR[0].messages.length === 3, `got ${dbLR[0].messages.length}`);
assert("LR run2: msg-003 stored",
  dbLR[0].messages[2].external_id === "lr-msg-003",
  `got "${dbLR[0].messages[2].external_id}"`);
assert("LR run2: content correct",
  dbLR[0].messages[2].content === "Hello",
  `got "${dbLR[0].messages[2].content}"`);
assert("LR run2: msg-001 and msg-003 are distinct stored entries",
  dbLR[0].messages[0].external_id !== dbLR[0].messages[2].external_id);

const lrRun3 = simulateLRImport(laterModified);
assert("LR run3 (re-import): updatedCount = 0", lrRun3.updatedCount === 0, `got ${lrRun3.updatedCount}`);
assert("LR run3 (re-import): skippedCount = 1", lrRun3.skippedCount === 1, `got ${lrRun3.skippedCount}`);
assert("LR run3 (re-import): still 3 messages",  dbLR[0].messages.length === 3, `got ${dbLR[0].messages.length}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
