/**
 * End-to-end smoke test for ZenBrain import flow.
 * Run with: node artifacts/api-server/test-fixtures/e2e-smoke-test.mjs
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY env vars.
 */

import { readFileSync, createReadStream, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API = "http://localhost:80/api";
const FIXTURE = join(__dirname, "sample-conversations.json");
const CLAUDE_FIXTURE = join(__dirname, "sample-claude-conversations.json");

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error("Missing required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  PASS  ${label}`);
  passed++;
}

function fail(label, detail = "") {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

function assertEq(label, actual, expected) {
  if (String(actual) === String(expected)) {
    pass(`${label} (${actual})`);
  } else {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(label, value, detail = "") {
  if (value) pass(label);
  else fail(label, detail);
}

// ---------------------------------------------------------------------------
// HTTP helpers using native fetch (Node 18+)
// ---------------------------------------------------------------------------

async function api(method, path, { auth, body, json } = {}) {
  const headers = {};
  if (auth) headers["Authorization"] = `Bearer ${auth}`;

  let bodyData;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyData = JSON.stringify(json);
  } else if (body) {
    bodyData = body;
  }

  const res = await fetch(`${API}${path}`, { method, headers, body: bodyData });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function uploadFile(auth, profileId, provider, fileBuffer, filename, mimeType) {
  const boundary = `----FormBoundary${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16)}`;
  const CRLF = "\r\n";

  const fieldPart = (name, value) =>
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;

  const header = fieldPart("profileId", profileId) + fieldPart("provider", provider) +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`;
  const footer = `${CRLF}--${boundary}--${CRLF}`;

  const headerBuf = Buffer.from(header, "utf-8");
  const footerBuf = Buffer.from(footer, "utf-8");
  const combined = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

  const res = await fetch(`${API}/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: combined,
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Build a minimal ZIP in pure JS (no external dep)
// Uses the Node built-in zlib for deflate, but for simplicity uses STORE method
// ---------------------------------------------------------------------------

function buildZip(files) {
  // files: [{ name, data: Buffer }]
  // Simple ZIP with STORE (no compression), sufficient for testing
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf-8");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // sig
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0, 6);           // flags
    localHeader.writeUInt16LE(0, 8);           // compression (STORE)
    localHeader.writeUInt16LE(0, 10);          // mod time
    localHeader.writeUInt16LE(0, 12);          // mod date
    localHeader.writeUInt32LE(crc, 14);        // crc32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // name length
    localHeader.writeUInt16LE(0, 28);          // extra length
    nameBuf.copy(localHeader, 30);

    const cdEntry = Buffer.alloc(46 + nameBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // central dir sig
    cdEntry.writeUInt16LE(20, 4);          // version made by
    cdEntry.writeUInt16LE(20, 6);          // version needed
    cdEntry.writeUInt16LE(0, 8);           // flags
    cdEntry.writeUInt16LE(0, 10);          // compression
    cdEntry.writeUInt16LE(0, 12);          // mod time
    cdEntry.writeUInt16LE(0, 14);          // mod date
    cdEntry.writeUInt32LE(crc, 16);        // crc32
    cdEntry.writeUInt32LE(data.length, 20); // compressed size
    cdEntry.writeUInt32LE(data.length, 24); // uncompressed size
    cdEntry.writeUInt16LE(nameBuf.length, 28); // name length
    cdEntry.writeUInt16LE(0, 30);          // extra length
    cdEntry.writeUInt16LE(0, 32);          // comment length
    cdEntry.writeUInt16LE(0, 34);          // disk start
    cdEntry.writeUInt16LE(0, 36);          // internal attrs
    cdEntry.writeUInt32LE(0, 38);          // external attrs
    cdEntry.writeUInt32LE(offset, 42);     // local header offset
    nameBuf.copy(cdEntry, 46);

    parts.push(localHeader, data);
    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // end of central dir sig
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // start disk
  eocd.writeUInt16LE(files.length, 8);         // entries on disk
  eocd.writeUInt16LE(files.length, 10);        // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);        // central dir size
  eocd.writeUInt32LE(offset, 16);              // central dir offset
  eocd.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([...parts, cdBuf, eocd]);
}

function crc32(buf) {
  const table = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------

let token = "";
let userId = "";
let profileId = "";
let profileZipId = "";
let firstConvId = "";
let alphaConvId = "";
let claudeProfileId = "";
let claudeZipProfileId = "";

const fixtureData = readFileSync(FIXTURE);
const fixtureJson = JSON.parse(fixtureData.toString());
const claudeFixtureData = readFileSync(CLAUDE_FIXTURE);
const claudeFixtureJson = JSON.parse(claudeFixtureData.toString());

async function main() {
  // ── Step 1: Sign up / sign in ────────────────────────────────────────────
  console.log("\n=== Step 1: Sign up / sign in ===");
  // Override via env vars to avoid committing credentials:
  //   E2E_TEST_EMAIL=you@example.com E2E_TEST_PASS=yourpass node e2e-smoke-test.mjs
  const testEmail = process.env.E2E_TEST_EMAIL ?? "zenbrain-smoketest-throwaway@example.com";
  const testPass = process.env.E2E_TEST_PASS ?? `TestOnly-${createHash("sha256").update(SUPABASE_URL).digest("hex").slice(0, 12)}`;

  // Use Admin API to create user with email pre-confirmed (bypasses email verification)
  const adminCreateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPass,
      email_confirm: true,
    }),
  });
  const adminCreateData = await adminCreateRes.json();
  // If user already exists (409), that's fine — just proceed to sign in
  if (adminCreateRes.status !== 201 && adminCreateRes.status !== 422 && adminCreateRes.status !== 409) {
    console.log(`  Admin create response ${adminCreateRes.status}:`, JSON.stringify(adminCreateData).slice(0, 200));
  } else if (adminCreateRes.status === 422 || adminCreateRes.status === 409) {
    // User already exists — update password to ensure it matches
    const existingId = adminCreateData?.id || adminCreateData?.user?.id;
    if (existingId) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existingId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ password: testPass, email_confirm: true }),
      });
    }
  }

  // Sign in with anon key to get a valid JWT
  const signinRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPass }),
  });
  const authData = await signinRes.json();

  token = authData.access_token || "";
  userId = authData.user?.id || "";
  assertTruthy("Got JWT access token", token, JSON.stringify(authData).slice(0, 200));
  assertTruthy("Got user ID", userId);

  // ── Step 2: Library summary (empty or existing) ──────────────────────────
  console.log("\n=== Step 2: Library summary ===");
  const { status: s2, data: d2 } = await api("GET", "/library/summary", { auth: token });
  assertEq("Library summary HTTP 200", s2, 200);
  assertTruthy("total_conversations field present", d2?.total_conversations !== undefined);
  console.log(`  Info: total_conversations=${d2?.total_conversations}, total_profiles=${d2?.total_profiles}`);

  // ── Step 3: Create profile ───────────────────────────────────────────────
  console.log("\n=== Step 3: Create ChatGPT profile 'TestGPT' ===");
  const { status: s3, data: d3 } = await api("POST", "/profiles", {
    auth: token, json: { name: "TestGPT", provider: "chatgpt", description: "E2E smoke test" },
  });
  assertEq("Create profile HTTP 201", s3, 201);
  profileId = d3?.id || "";
  assertTruthy("Profile ID returned", profileId, JSON.stringify(d3));
  console.log(`  Profile ID: ${profileId}`);

  // ── Step 4: First import ─────────────────────────────────────────────────
  console.log("\n=== Step 4: First import (conversations.json) ===");
  const { status: s4, data: d4 } = await uploadFile(token, profileId, "chatgpt", fixtureData, "conversations.json", "application/json");
  assertEq("Import 1 HTTP 200", s4, 200);
  assertEq("Import 1 status=completed", d4?.status, "completed");
  assertEq("Import 1 new_count=2", d4?.new_count, 2);
  assertEq("Import 1 skipped_count=0", d4?.skipped_count, 0);
  assertEq("Import 1 failed_count=0", d4?.failed_count, 0);
  if (d4?.errors?.length) console.log("  Errors:", d4.errors);

  // ── Step 5: Verify Supabase DB rows ─────────────────────────────────────
  console.log("\n=== Step 5: Verify DB conversations ===");
  const { status: s5, data: d5 } = await api("GET", `/conversations?profileId=${profileId}`, { auth: token });
  assertEq("Conversations list HTTP 200", s5, 200);
  assertEq("Total conversations in DB = 2", d5?.total, 2);
  firstConvId = d5?.conversations?.[0]?.id || "";
  // Track Alpha specifically (needed for message count check after update)
  alphaConvId = d5?.conversations?.find(c => c.display_title === "Fixture Conversation Alpha")?.id || firstConvId;
  assertTruthy("First conversation ID present", firstConvId);
  assertTruthy("Alpha conversation ID found", alphaConvId);
  const allHaveStorage = d5?.conversations?.every(c => c.storage_path);
  assertTruthy("All conversations have storage_path", allHaveStorage, "some storage_path is null");
  console.log(`  Titles: ${d5?.conversations?.map(c => c.display_title).join(" | ")}`);

  // ── Step 6: Open conversation — markdown content ─────────────────────────
  console.log("\n=== Step 6: Open conversation — markdown loads ===");
  const { status: s6, data: d6 } = await api("GET", `/conversations/${firstConvId}`, { auth: token });
  assertEq("Conversation detail HTTP 200", s6, 200);
  assertTruthy("markdown_content present", d6?.markdown_content, "null or empty");
  assertTruthy("Markdown starts with # title", d6?.markdown_content?.startsWith("# "));
  assertTruthy("Markdown contains **You**", d6?.markdown_content?.includes("**You**"));
  assertTruthy("Markdown contains **Assistant**", d6?.markdown_content?.includes("**Assistant**"));
  assertTruthy("message_count >= 2", (d6?.message_count ?? 0) >= 2, `got ${d6?.message_count}`);
  console.log(`  Markdown preview: ${d6?.markdown_content?.slice(0, 80).replace(/\n/g, "\\n")}...`);

  // ── Step 7: Second import — all skipped ─────────────────────────────────
  console.log("\n=== Step 7: Second import (identical — expect all skipped) ===");
  const { status: s7, data: d7 } = await uploadFile(token, profileId, "chatgpt", fixtureData, "conversations.json", "application/json");
  assertEq("Import 2 status=completed", d7?.status, "completed");
  assertEq("Import 2 new_count=0", d7?.new_count, 0);
  assertEq("Import 2 skipped_count=2", d7?.skipped_count, 2);
  assertEq("Import 2 failed_count=0", d7?.failed_count, 0);

  const { data: d7b } = await api("GET", `/conversations?profileId=${profileId}`, { auth: token });
  assertEq("Still exactly 2 conversations (no duplicates created)", d7b?.total, 2);

  // ── Step 8: Modified import — one updated ────────────────────────────────
  console.log("\n=== Step 8: Modified import (add message to conv alpha) ===");
  const modified = JSON.parse(JSON.stringify(fixtureJson));
  modified[0].mapping["msg-002"].children = ["msg-003"];
  modified[0].mapping["msg-003"] = {
    id: "msg-003", parent: "msg-002", children: [],
    message: {
      id: "msg-003", author: { role: "user" }, create_time: 1700000300,
      content: { parts: ["What about 3 + 3?"] },
    },
  };
  modified[0].update_time = 1700001500;
  const modifiedBuf = Buffer.from(JSON.stringify(modified));

  const { data: d8 } = await uploadFile(token, profileId, "chatgpt", modifiedBuf, "conversations.json", "application/json");
  assertEq("Import 3 status=completed", d8?.status, "completed");
  assertEq("Import 3 updated_count=1", d8?.updated_count, 1);
  assertEq("Import 3 skipped_count=1", d8?.skipped_count, 1);
  assertEq("Import 3 new_count=0", d8?.new_count, 0);

  // ── Step 8b: Re-import modified — no duplicates ──────────────────────────
  console.log("\n=== Step 8b: Re-import modified — verify no duplicate messages ===");
  const { data: d8b } = await uploadFile(token, profileId, "chatgpt", modifiedBuf, "conversations.json", "application/json");
  assertEq("Import 3b new_count=0", d8b?.new_count, 0);
  assertEq("Import 3b updated_count=0", d8b?.updated_count, 0);
  assertEq("Import 3b skipped_count=2", d8b?.skipped_count, 2);

  // Verify message count in DB — check Alpha specifically (it got the new message)
  const { data: d8c } = await api("GET", `/conversations/${alphaConvId}`, { auth: token });
  assertTruthy("Conv alpha has 3 messages after update", (d8c?.message_count ?? 0) >= 3, `got ${d8c?.message_count}`);

  // ── Step 9: ZIP import ───────────────────────────────────────────────────
  console.log("\n=== Step 9: ZIP import (conversations.json inside nested folder) ===");
  const zipBuf = buildZip([
    { name: "chatgpt-export-2024/conversations.json", data: fixtureData },
    { name: "chatgpt-export-2024/user.json", data: Buffer.from('{"email":"test@example.com"}') },
  ]);

  const { status: s9p, data: d9p } = await api("POST", "/profiles", {
    auth: token, json: { name: "TestGPT-ZIP", provider: "chatgpt" },
  });
  profileZipId = d9p?.id || "";
  assertTruthy("ZIP test profile created", profileZipId, JSON.stringify(d9p));

  const { status: s9, data: d9 } = await uploadFile(token, profileZipId, "chatgpt", zipBuf, "export.zip", "application/zip");
  assertEq("ZIP import HTTP 200", s9, 200);
  assertEq("ZIP import status=completed", d9?.status, "completed");
  assertEq("ZIP import new_count=2", d9?.new_count, 2);
  assertEq("ZIP import failed_count=0", d9?.failed_count, 0);
  if (d9?.errors?.length) console.log("  ZIP errors:", d9.errors);

  // ── Step 10: Rename conversation ─────────────────────────────────────────
  console.log("\n=== Step 10: Rename conversation ===");
  const { status: s10, data: d10 } = await api("PATCH", `/conversations/${firstConvId}`, {
    auth: token, json: { display_title: "Renamed Smoke Test Conversation" },
  });
  assertEq("Rename HTTP 200", s10, 200);
  assertEq("Renamed title correct", d10?.display_title, "Renamed Smoke Test Conversation");

  // ── Step 11: Markdown download signed URL ─────────────────────────────────
  console.log("\n=== Step 11: Markdown download signed URL ===");
  const { status: s11, data: d11 } = await api("GET", `/conversations/${firstConvId}/download`, { auth: token });
  assertEq("Download HTTP 200", s11, 200);
  assertTruthy("Signed URL returned", d11?.url?.startsWith("https://"), `got: ${d11?.url}`);
  console.log(`  URL preview: ${(d11?.url || "").slice(0, 70)}...`);

  // Fetch the signed URL and verify markdown content
  const mdRes = await fetch(d11.url);
  const mdText = await mdRes.text();
  assertTruthy("Signed URL actually serves markdown", mdText.startsWith("# "), `got: ${mdText.slice(0, 100)}`);

  // ── Step 12: Library summary final ───────────────────────────────────────
  console.log("\n=== Step 12: Library summary final check ===");
  const { data: d12 } = await api("GET", "/library/summary", { auth: token });
  const cgpStats = d12?.providers?.find(p => p.provider === "chatgpt");
  assertTruthy("ChatGPT appears in providers", cgpStats, JSON.stringify(d12?.providers));
  assertTruthy("ChatGPT conversation_count >= 2", (cgpStats?.conversation_count ?? 0) >= 2, `got ${cgpStats?.conversation_count}`);
  console.log(`  ChatGPT: ${cgpStats?.profile_count} profiles, ${cgpStats?.conversation_count} conversations`);

  // ── Step 13: Verify Storage files via Service Role ────────────────────────
  console.log("\n=== Step 13: Verify Supabase Storage files ===");
  const storageRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/markdown-files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix: `${userId}/`, limit: 50 }),
  });
  const storageData = await storageRes.json();
  const fileCount = Array.isArray(storageData) ? storageData.length : 0;
  assertTruthy(`Storage: ${fileCount} files found under user/${userId.slice(0, 8)}/`, fileCount >= 2, JSON.stringify(storageData).slice(0, 200));
  if (Array.isArray(storageData)) {
    storageData.slice(0, 3).forEach(f => console.log(`  File: ${f.name}`));
  }

  // ── Steps 15–19: Claude import tests ─────────────────────────────────────

  // ── Step 15: Create Claude profile ───────────────────────────────────────
  console.log("\n=== Step 15: Create Claude profile ===");
  const { status: s15, data: d15 } = await api("POST", "/profiles", {
    auth: token, json: { name: "TestClaude", provider: "claude" },
  });
  claudeProfileId = d15?.id || "";
  assertEq("Create Claude profile HTTP 201", s15, 201);
  assertTruthy("Claude profile ID returned", claudeProfileId, JSON.stringify(d15));

  // ── Step 16: First Claude import (JSON) ───────────────────────────────────
  console.log("\n=== Step 16: First Claude import (conversations.json) ===");
  const { status: s16, data: d16 } = await uploadFile(
    token, claudeProfileId, "claude", claudeFixtureData, "conversations.json", "application/json"
  );
  assertEq("Claude import 1 HTTP 200", s16, 200);
  assertEq("Claude import 1 status=completed", d16?.status, "completed");
  assertEq("Claude import 1 new_count=2", d16?.new_count, 2);
  assertEq("Claude import 1 skipped_count=0", d16?.skipped_count, 0);
  assertEq("Claude import 1 failed_count=0", d16?.failed_count, 0);
  if (d16?.errors?.length) console.log("  Errors:", d16.errors);

  // Verify DB rows
  const { data: d16v } = await api("GET", `/conversations?profileId=${claudeProfileId}`, { auth: token });
  assertEq("Claude: 2 conversations in DB", d16v?.total, 2);
  const claudeAlphaId = d16v?.conversations?.find(c => c.display_title === "Claude Fixture Conversation Alpha")?.id || "";
  assertTruthy("Claude alpha ID found", claudeAlphaId);
  const claudeAllHaveStorage = d16v?.conversations?.every(c => c.storage_path);
  assertTruthy("Claude: all conversations have storage_path", claudeAllHaveStorage);

  // Verify markdown content
  const { data: d16md } = await api("GET", `/conversations/${claudeAlphaId}`, { auth: token });
  assertTruthy("Claude markdown present", d16md?.markdown_content, "null or empty");
  assertTruthy("Claude markdown starts with # title", d16md?.markdown_content?.startsWith("# Claude Fixture"));
  assertTruthy("Claude markdown contains provider label", d16md?.markdown_content?.includes("*Provider: Claude*"));
  assertTruthy("Claude markdown contains **You**", d16md?.markdown_content?.includes("**You**"));
  assertTruthy("Claude markdown contains **Claude**", d16md?.markdown_content?.includes("**Claude**"));
  console.log(`  Markdown preview: ${d16md?.markdown_content?.slice(0, 80).replace(/\n/g, "\\n")}...`);

  // ── Step 17: Duplicate Claude import (all skipped) ────────────────────────
  console.log("\n=== Step 17: Duplicate Claude import (expect all skipped) ===");
  const { data: d17 } = await uploadFile(
    token, claudeProfileId, "claude", claudeFixtureData, "conversations.json", "application/json"
  );
  assertEq("Claude import 2 status=completed", d17?.status, "completed");
  assertEq("Claude import 2 new_count=0", d17?.new_count, 0);
  assertEq("Claude import 2 skipped_count=2", d17?.skipped_count, 2);
  assertEq("Claude import 2 failed_count=0", d17?.failed_count, 0);
  const { data: d17v } = await api("GET", `/conversations?profileId=${claudeProfileId}`, { auth: token });
  assertEq("Claude: still exactly 2 conversations (no duplicates)", d17v?.total, 2);

  // ── Step 18: Modified Claude import (add message to alpha) ───────────────
  console.log("\n=== Step 18: Modified Claude import (add message to alpha) ===");
  const claudeModified = JSON.parse(JSON.stringify(claudeFixtureJson));
  claudeModified[0].chat_messages.push({
    uuid: "claude-msg-003-e2e",
    sender: "human",
    created_at: "2024-01-15T10:40:00.000000+00:00",
    updated_at: "2024-01-15T10:40:00.000000+00:00",
    text: "What about Planck's constant?",
    content: [{ type: "text", text: "What about Planck's constant?" }],
    files: [],
    attachments: [],
  });
  claudeModified[0].updated_at = "2024-01-15T10:40:00.000000+00:00";
  const claudeModifiedBuf = Buffer.from(JSON.stringify(claudeModified));

  const { data: d18 } = await uploadFile(
    token, claudeProfileId, "claude", claudeModifiedBuf, "conversations.json", "application/json"
  );
  assertEq("Claude import 3 status=completed", d18?.status, "completed");
  assertEq("Claude import 3 updated_count=1", d18?.updated_count, 1);
  assertEq("Claude import 3 skipped_count=1", d18?.skipped_count, 1);
  assertEq("Claude import 3 new_count=0", d18?.new_count, 0);

  // ── Step 18b: Re-import modified — no duplicates ──────────────────────────
  console.log("\n=== Step 18b: Re-import modified Claude — no duplicate messages ===");
  const { data: d18b } = await uploadFile(
    token, claudeProfileId, "claude", claudeModifiedBuf, "conversations.json", "application/json"
  );
  assertEq("Claude import 3b new_count=0", d18b?.new_count, 0);
  assertEq("Claude import 3b updated_count=0", d18b?.updated_count, 0);
  assertEq("Claude import 3b skipped_count=2", d18b?.skipped_count, 2);

  const { data: d18c } = await api("GET", `/conversations/${claudeAlphaId}`, { auth: token });
  assertTruthy("Claude alpha has 3 messages after update", (d18c?.message_count ?? 0) >= 3, `got ${d18c?.message_count}`);

  // ── Step 19: Claude ZIP import ────────────────────────────────────────────
  console.log("\n=== Step 19: Claude ZIP import (conversations.json inside nested folder) ===");
  const claudeZipBuf = buildZip([
    { name: "claude-export-2024/conversations.json", data: claudeFixtureData },
  ]);

  const { status: s19p, data: d19p } = await api("POST", "/profiles", {
    auth: token, json: { name: "TestClaude-ZIP", provider: "claude" },
  });
  claudeZipProfileId = d19p?.id || "";
  assertTruthy("Claude ZIP profile created", claudeZipProfileId, JSON.stringify(d19p));

  const { status: s19, data: d19 } = await uploadFile(
    token, claudeZipProfileId, "claude", claudeZipBuf, "claude-export.zip", "application/zip"
  );
  assertEq("Claude ZIP import HTTP 200", s19, 200);
  assertEq("Claude ZIP import status=completed", d19?.status, "completed");
  assertEq("Claude ZIP import new_count=2", d19?.new_count, 2);
  assertEq("Claude ZIP import failed_count=0", d19?.failed_count, 0);
  if (d19?.errors?.length) console.log("  Claude ZIP errors:", d19.errors);

  // ── Step 14: Cleanup ──────────────────────────────────────────────────────
  console.log("\n=== Step 14: Cleanup ===");
  await api("DELETE", `/profiles/${profileId}`, { auth: token });
  await api("DELETE", `/profiles/${profileZipId}`, { auth: token });
  await api("DELETE", `/profiles/${claudeProfileId}`, { auth: token });
  await api("DELETE", `/profiles/${claudeZipProfileId}`, { auth: token });
  pass("Profiles deleted (cascades conversations + messages)");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(50));
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
