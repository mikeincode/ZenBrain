# ZenBrain

A private AI memory vault PWA for importing and browsing AI conversation history from ChatGPT, Claude, and Gemini exports.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/zenbrain run dev` — run the frontend (port 20856)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind + shadcn/ui + Wouter
- Auth: Supabase Auth (email/password)
- DB: Supabase Postgres (managed via Supabase dashboard)
- Storage: Supabase Storage bucket `markdown-files`
- API: Express 5 with Supabase service role client
- Validation: Zod (`zod/v4`), Orval codegen from OpenAPI spec
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract source of truth
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/` — generated Zod schemas for server validation
- `artifacts/zenbrain/src/` — React PWA frontend
  - `pages/` — home, provider, profile, conversation, import, auth
  - `lib/supabase.ts` — Supabase client (uses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
  - `hooks/use-auth.ts` — Supabase auth hook
- `artifacts/api-server/src/` — Express API server
  - `routes/profiles.ts` — CRUD for provider profiles
  - `routes/conversations.ts` — conversation list, detail, update, download
  - `routes/import.ts` — file upload + ChatGPT parser + dedup logic
  - `routes/library.ts` — home page summary stats
  - `lib/chatgpt-parser.ts` — ChatGPT conversations.json parser
  - `lib/supabase.ts` — Supabase admin client (uses SUPABASE_SERVICE_ROLE_KEY)
  - `middlewares/auth.ts` — JWT verification middleware
- `supabase-schema.sql` — Full DB schema + RLS policies to run in Supabase SQL Editor

## Database Setup (one-time)

1. In your Supabase project dashboard, go to **Storage** → create a bucket named `markdown-files` (private)
2. Go to **SQL Editor** → run the contents of `supabase-schema.sql`
3. This creates: `profiles`, `import_runs`, `conversations`, `messages` tables with RLS

## Architecture decisions

- Supabase service role key is used server-side only (never exposed to frontend)
- JWT from Supabase Auth is forwarded to the API server via `Authorization: Bearer` header, injected globally via `window.__supabaseToken` into the Orval custom-fetch
- Import deduplication uses: `external_id` (provider conversation ID) → `content_hash` fallback
- Markdown is generated server-side and stored in Supabase Storage; the API returns signed URLs for downloads
- ChatGPT parser handles the mapping/node graph format; Claude/Gemini adapters can be added in `lib/chatgpt-parser.ts` pattern

## Product

- Home page: three provider cards (ChatGPT, Claude, Gemini) showing profile/conversation counts
- Provider page: profile list + create profile
- Profile page: conversation list with search, stats, import button, zip download
- Conversation page: rendered markdown, rename title, download markdown
- Import page: file upload → parse → deduplicate → store → import report

## User preferences

- Mobile-first PWA
- Blue/white clean utility style, ZenBrain / ZenUtils branding
- No emojis in UI

## Gotchas

- Run `supabase-schema.sql` in the Supabase SQL Editor before using the app
- Create the `markdown-files` storage bucket manually in Supabase Storage
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are used in the frontend (Vite exposes VITE_ prefixed vars)
- `SUPABASE_SERVICE_ROLE_KEY` is used server-side only
- Import accepts `.json` (ChatGPT `conversations.json`) and `.zip` files
- After adding new routes, restart the API server workflow

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- API routes follow OpenAPI spec in `lib/api-spec/openapi.yaml`
