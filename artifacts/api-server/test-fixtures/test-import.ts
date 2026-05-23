/**
 * Manual integration test for the ChatGPT parser + dedup logic.
 *
 * Run with:
 *   npx tsx artifacts/api-server/test-fixtures/test-import.ts
 *
 * Does NOT touch Supabase. Tests the parser and dedup helpers in isolation.
 */

import { parseChatGPTExport, conversationToMarkdown, sha256 } from "../src/lib/chatgpt-parser";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "sample-conversations.json");

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
// Simulate in-memory DB for dedup
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
  const seen = new Set<string>();
  for (const m of existing) {
    if (m.external_id) seen.add(`id:${m.external_id}`);
    if (m.content_hash) seen.add(`hash:${m.content_hash}`);
  }
  const result = [];
  for (const m of incoming) {
    if (seen.has(`id:${m.id}`) || seen.has(`hash:${m.contentHash}`)) continue;
    result.push(m);
    seen.add(`id:${m.id}`);
    seen.add(`hash:${m.contentHash}`);
  }
  return result;
}

function simulateImport(parsed: unknown): { newCount: number; updatedCount: number; skippedCount: number } {
  const convs = parseChatGPTExport(parsed);
  let newCount = 0, updatedCount = 0, skippedCount = 0;

  for (const conv of convs) {
    const existing = findConv(conv.externalId);

    if (existing) {
      const newMsgs = dedupeMessages(conv.messages, existing.messages.map((m) => ({
        external_id: m.external_id,
        content_hash: m.content_hash,
      })));
      if (newMsgs.length > 0) {
        existing.display_title = conv.title;
        existing.messages.push(...newMsgs.map((m) => ({
          external_id: m.id,
          content_hash: m.contentHash,
          role: m.role,
          content: m.content,
        })));
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
// Tests
// ---------------------------------------------------------------------------

const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

// ---- Test: SHA-256 hash is stable and non-empty ----
console.log("\nTest: sha256()");
assert("produces 64-char hex", sha256("hello").length === 64);
assert("is stable", sha256("hello") === sha256("hello"));
assert("differs on different input", sha256("hello") !== sha256("world"));

// ---- Test: Parser produces correct output ----
console.log("\nTest: parseChatGPTExport()");
const convs = parseChatGPTExport(raw);
assert("parses 2 conversations", convs.length === 2);
assert("first conv has correct title", convs[0].title === "Fixture Conversation Alpha");
assert("first conv has correct externalId", convs[0].externalId === "conv-fixture-001");
assert("first conv has 2 messages", convs[0].messages.length === 2);
assert("first message role is user", convs[0].messages[0].role === "user");
assert("second message role is assistant", convs[0].messages[1].role === "assistant");
assert("message content is correct", convs[0].messages[0].content === "Hello, what is 2 + 2?");
assert("contentHash is SHA-256 (64 chars)", convs[0].messages[0].contentHash.length === 64);
assert("second conv has correct title", convs[1].title === "Fixture Conversation Beta");
assert("second conv has 2 messages", convs[1].messages.length === 2);

// ---- Test: Deterministic fallback ID ----
console.log("\nTest: deterministic fallback external_id");
const noIdRaw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
delete noIdRaw[0].id;
const convNoId1 = parseChatGPTExport(noIdRaw);
const convNoId2 = parseChatGPTExport(noIdRaw);
assert("fallback ID starts with 'det:'", convNoId1[0].externalId.startsWith("det:"));
assert("fallback ID is stable across calls", convNoId1[0].externalId === convNoId2[0].externalId);
assert("fallback ID differs from other conv's", convNoId1[0].externalId !== convNoId1[1].externalId);

// ---- Test: Markdown output ----
console.log("\nTest: conversationToMarkdown()");
const md = conversationToMarkdown(convs[0]);
assert("starts with # title", md.startsWith("# Fixture Conversation Alpha"));
assert("contains You label", md.includes("**You**"));
assert("contains Assistant label", md.includes("**Assistant**"));
assert("contains message content", md.includes("Hello, what is 2 + 2?"));
assert("contains answer", md.includes("2 + 2 equals 4"));
assert("contains created date", md.includes("2023-11-14"));

// ---- Test: First import — all new ----
console.log("\nTest: First import (all new)");
const run1 = simulateImport(raw);
assert("newCount = 2", run1.newCount === 2, `got ${run1.newCount}`);
assert("updatedCount = 0", run1.updatedCount === 0, `got ${run1.updatedCount}`);
assert("skippedCount = 0", run1.skippedCount === 0, `got ${run1.skippedCount}`);
assert("db has 2 conversations", db.length === 2);
assert("conv alpha has 2 messages", db[0].messages.length === 2);
assert("conv beta has 2 messages", db[1].messages.length === 2);

// ---- Test: Second import — identical, all skipped ----
console.log("\nTest: Second import (identical — all skipped)");
const run2 = simulateImport(raw);
assert("newCount = 0", run2.newCount === 0, `got ${run2.newCount}`);
assert("updatedCount = 0", run2.updatedCount === 0, `got ${run2.updatedCount}`);
assert("skippedCount = 2", run2.skippedCount === 2, `got ${run2.skippedCount}`);
assert("db still has 2 conversations", db.length === 2);

// ---- Test: Third import — one conversation gets a new message ----
console.log("\nTest: Third import (one conv updated with new message)");
const rawModified = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
rawModified[0].mapping["msg-003"] = {
  id: "msg-003",
  parent: "msg-002",
  children: [],
  message: {
    id: "msg-003",
    author: { role: "user" },
    create_time: 1700000300,
    content: { parts: ["What about 3 + 3?"] },
  },
};
rawModified[0].mapping["msg-002"].children = ["msg-003"];
rawModified[0].update_time = 1700001500;

const run3 = simulateImport(rawModified);
assert("newCount = 0", run3.newCount === 0, `got ${run3.newCount}`);
assert("updatedCount = 1", run3.updatedCount === 1, `got ${run3.updatedCount}`);
assert("skippedCount = 1", run3.skippedCount === 1, `got ${run3.skippedCount}`);
assert("alpha conv now has 3 messages", db[0].messages.length === 3, `got ${db[0].messages.length}`);
assert("beta conv unchanged at 2 messages", db[1].messages.length === 2, `got ${db[1].messages.length}`);
assert("new message content correct", db[0].messages[2].content === "What about 3 + 3?");

// ---- Test: Re-import of modified — no duplicate new message ----
console.log("\nTest: Fourth import (re-import of modified — no duplicates)");
const run4 = simulateImport(rawModified);
assert("newCount = 0", run4.newCount === 0, `got ${run4.newCount}`);
assert("updatedCount = 0", run4.updatedCount === 0, `got ${run4.updatedCount}`);
assert("skippedCount = 2", run4.skippedCount === 2, `got ${run4.skippedCount}`);
assert("alpha conv still has 3 messages (no duplicates)", db[0].messages.length === 3, `got ${db[0].messages.length}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
