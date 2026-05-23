-- ZenBrain Supabase Schema
-- Run this in your Supabase project's SQL Editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Profiles table
create table if not exists public.profiles (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('chatgpt', 'claude', 'gemini')),
  name text not null,
  description text,
  last_import_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_user_id_idx on public.profiles(user_id);
create index if not exists profiles_provider_idx on public.profiles(provider);

-- Import runs table
create table if not exists public.import_runs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  new_count integer,
  updated_count integer,
  skipped_count integer,
  failed_count integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists import_runs_profile_id_idx on public.import_runs(profile_id);
create index if not exists import_runs_user_id_idx on public.import_runs(user_id);

-- Conversations table
create table if not exists public.conversations (
  id uuid primary key default uuid_generate_v4(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  external_id text,
  display_title text not null,
  storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, external_id)
);

create index if not exists conversations_profile_id_idx on public.conversations(profile_id);
create index if not exists conversations_external_id_idx on public.conversations(external_id);
create index if not exists conversations_updated_at_idx on public.conversations(updated_at desc);

-- Messages table
create table if not exists public.messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  external_id text,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  content_hash text,
  message_timestamp timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx on public.messages(conversation_id);
create index if not exists messages_profile_id_idx on public.messages(profile_id);
create index if not exists messages_content_hash_idx on public.messages(content_hash);

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.import_runs enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

-- RLS Policies for profiles
create policy "Users can read own profiles" on public.profiles
  for select using (auth.uid() = user_id);

create policy "Users can insert own profiles" on public.profiles
  for insert with check (auth.uid() = user_id);

create policy "Users can update own profiles" on public.profiles
  for update using (auth.uid() = user_id);

create policy "Users can delete own profiles" on public.profiles
  for delete using (auth.uid() = user_id);

-- RLS Policies for import_runs
create policy "Users can read own import runs" on public.import_runs
  for select using (auth.uid() = user_id);

create policy "Users can insert own import runs" on public.import_runs
  for insert with check (auth.uid() = user_id);

create policy "Users can update own import runs" on public.import_runs
  for update using (auth.uid() = user_id);

-- RLS Policies for conversations (via profile ownership)
create policy "Users can read own conversations" on public.conversations
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = conversations.profile_id and p.user_id = auth.uid()
    )
  );

create policy "Users can insert own conversations" on public.conversations
  for insert with check (
    exists (
      select 1 from public.profiles p
      where p.id = conversations.profile_id and p.user_id = auth.uid()
    )
  );

create policy "Users can update own conversations" on public.conversations
  for update using (
    exists (
      select 1 from public.profiles p
      where p.id = conversations.profile_id and p.user_id = auth.uid()
    )
  );

create policy "Users can delete own conversations" on public.conversations
  for delete using (
    exists (
      select 1 from public.profiles p
      where p.id = conversations.profile_id and p.user_id = auth.uid()
    )
  );

-- RLS Policies for messages (via profile ownership)
create policy "Users can read own messages" on public.messages
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = messages.profile_id and p.user_id = auth.uid()
    )
  );

create policy "Users can insert own messages" on public.messages
  for insert with check (
    exists (
      select 1 from public.profiles p
        where p.id = messages.profile_id and p.user_id = auth.uid()
    )
  );

create policy "Users can delete own messages" on public.messages
  for delete using (
    exists (
      select 1 from public.profiles p
        where p.id = messages.profile_id and p.user_id = auth.uid()
    )
  );

-- Storage bucket for markdown files
-- Run this separately if the bucket doesn't exist:
-- insert into storage.buckets (id, name, public) values ('markdown-files', 'markdown-files', false);

-- Storage RLS policies (run after creating the bucket)
create policy "Users can upload own markdown files" on storage.objects
  for insert with check (
    bucket_id = 'markdown-files' and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can read own markdown files" on storage.objects
  for select using (
    bucket_id = 'markdown-files' and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update own markdown files" on storage.objects
  for update using (
    bucket_id = 'markdown-files' and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete own markdown files" on storage.objects
  for delete using (
    bucket_id = 'markdown-files' and auth.uid()::text = (storage.foldername(name))[1]
  );
