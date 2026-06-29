-- Multi-page scan support. A single PDF upload can contain several checklist
-- sheets (e.g. one owner's whole binder scanned at once). A "batch" tracks the
-- original upload and lets the user review/save one sheet at a time, leave and
-- come back later, and pick up exactly where they left off.
--
-- The original PDF itself is kept in Supabase Storage (bucket below), not in a
-- DB column — only the storage_path is stored here. Storage access is done
-- server-side with the service-role key (api/lib/supabaseAdmin.ts), so the
-- bucket is private; no anon storage policy is needed.

create table scan_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  original_filename text,
  total_pages int not null,
  storage_path text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  owner text
);

create table scan_batch_pages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references scan_batches(id) on delete cascade,
  page_number int not null,
  status text not null default 'pending' check (status in ('pending', 'processed', 'skipped')),
  set_id uuid references sets(id) on delete set null,
  processed_at timestamptz,
  unique (batch_id, page_number)
);

create index scan_batch_pages_batch_id_idx on scan_batch_pages(batch_id);

-- Same "no auth layer yet, anon key only" posture as 0005_rls_open_access.sql.
-- These two tables hold only batch/page metadata (filenames, status, which set a
-- page produced) — never the scan image bytes themselves, so open access here
-- doesn't expose anything storage-sensitive.
alter table scan_batches enable row level security;
alter table scan_batch_pages enable row level security;

drop policy if exists "anon full access" on scan_batches;
create policy "anon full access" on scan_batches for all using (true) with check (true);

drop policy if exists "anon full access" on scan_batch_pages;
create policy "anon full access" on scan_batch_pages for all using (true) with check (true);

-- Private bucket for original multi-page scan PDFs. Not public, and no storage.*
-- RLS policy is added for it deliberately — with none defined, only the
-- service-role key (used exclusively server-side, in api/lib/supabaseAdmin.ts)
-- can read/write it. The anon key used by the browser never touches this bucket
-- directly; all access goes through the scan-batch-create/scan-batch-page API
-- routes.
insert into storage.buckets (id, name, public)
values ('scan-uploads', 'scan-uploads', false)
on conflict (id) do nothing;
