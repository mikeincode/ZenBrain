# ZenBrain

**ZenBrain** is a private AI memory vault for importing, organizing, and exporting AI conversation history.

It is part of the **ZenUtils** ecosystem — useful tools, zero clutter.

ZenBrain lets users create separate profiles for different AI accounts, import their exported chat data, and turn conversations into clean Markdown files that can be searched, opened, renamed, downloaded, and stored privately.

---

## Current Status

ZenBrain currently supports:

- ChatGPT exports
- Claude exports
- Raw `conversations.json`
- `.zip` exports containing `conversations.json`
- Provider profiles, such as `PersonalGPT`, `WorkGPT`, `Claude Work`, etc.
- Duplicate-safe re-imports
- Markdown generation
- Supabase Auth
- Supabase Postgres metadata storage
- Supabase Storage for generated Markdown files
- Private storage bucket support
- End-to-end smoke tests

Gemini support is planned next using Google Takeout `MyActivity.html`.

---

## Why ZenBrain Exists

AI conversations often contain:

- app ideas
- code debugging sessions
- business plans
- research notes
- prompts
- personal workflows
- forgotten project context

But that history is usually trapped inside separate AI platforms.

ZenBrain helps turn that history into a private, organized, exportable memory vault.

---

## Features

### Provider Profiles

Users can organize imports by AI provider and profile.

Example:

```txt
ChatGPT
  - PersonalGPT
  - WorkGPT

Claude
  - Personal Claude
  - Project Claude

Gemini
  - Planned

Import Flow

1. Choose provider


2. Choose or create a profile


3. Upload an export file


4. ZenBrain parses conversations


5. Conversations are stored as metadata + Markdown


6. Duplicate-safe re-import prevents repeated chats/messages



Supported Import Formats

Provider	Status	Supported Files

ChatGPT	Supported	conversations.json, .zip containing conversations.json
Claude	Supported	conversations.json, .zip containing conversations.json
Gemini	Planned	Google Takeout MyActivity.html



---

ChatGPT Import

ChatGPT exports use a nested mapping graph instead of a simple message array.

ZenBrain handles:

mapping graph traversal

root node detection

latest branch path

message role extraction

text parts

image placeholders

model metadata

timestamps

deterministic fallback IDs

SHA-256 content hashing

duplicate-safe re-imports



---

Claude Import

Claude exports use a linear chat_messages structure.

ZenBrain handles:

conversation UUIDs

message UUIDs

fallback deterministic IDs

repeated identical messages

structured text blocks

attachment/tool/thinking placeholders

timestamps

duplicate-safe re-imports



---

Privacy

ZenBrain is designed for private AI history.

Important privacy choices:

User-owned rows are protected with Supabase RLS.

Markdown files are stored in a private Supabase Storage bucket.

Service role keys are server-side only.

No secrets should ever be committed to GitHub.

Raw exports are parsed for conversation import; generated Markdown becomes the stored readable format.



---

Tech Stack

React

Vite

TypeScript

Tailwind

Supabase Auth

Supabase Postgres

Supabase Storage

Node API server

JSZip

Markdown rendering



---

Environment Variables

Create these secrets in Replit or your deployment environment:

VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

Never expose SUPABASE_SERVICE_ROLE_KEY in frontend code.


---

Supabase Setup

Run the SQL schema included in the project:

supabase-schema.sql

Then create a private Supabase Storage bucket named:

markdown-files

The bucket must be private.


---

Local / Replit Setup

Install dependencies:

npm install

Start the app using the Replit workflows or the project’s configured frontend/API commands.

Before adding new features, confirm the existing tests pass.


---

Testing

Current test coverage includes:

ChatGPT parser tests

Claude parser tests

duplicate re-import tests

repeated message preservation

ZIP import support

Supabase end-to-end smoke test

Markdown storage and download checks


Recent passing test counts:

ChatGPT tests: 55/55
Claude tests: 101/101
Full e2e smoke test: 82/82


---

Roadmap

Next

Gemini import support from Google Takeout MyActivity.html

Gemini attachment placeholders

Gemini ZIP parsing


Later

Full-text search

Tags and collections

Bulk export

Obsidian-compatible vault export

Semantic search with embeddings

Ask-your-history AI memory layer

Manual merge/grouping for Gemini activity entries

Attachment importing



---

ZenUtils

ZenBrain is part of ZenUtils, a growing collection of practical AI-assisted utility apps.

Useful tools. Zero clutter.
