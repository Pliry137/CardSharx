-- Cache for auto-generated checklists (api/_lib/checklistGenerate.ts).
--
-- Background: real checklists were originally sourced "once, by Claude, ad hoc" and
-- hand-dropped as JSON files in api/_lib/checklists/ (see checklistLookup.ts). Scraping
-- a checklist site (TCDB, Beckett, etc.) to automate this was ruled out — their Terms of
-- Use explicitly forbid automated data extraction (see CardCollector.md Backlog). Instead,
-- api/checklist-lookup.ts now falls back to asking Claude to generate the checklist from
-- its own trained knowledge on the first scan of a never-seen set, and caches the result
-- here so every later scan of that same sport/year/manufacturer is instant and free.
--
-- These are NOT manually verified the way the bundled JSON files are — Claude's knowledge
-- of obscure inserts/variations can be wrong — hence the `verified` flag, surfaced in the
-- Capture.tsx save message so Joe knows to spot-check a newly-generated set's names.

create table generated_checklists (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sport text not null,
  year int not null,
  manufacturer text not null,
  slug text not null unique,
  total_card_count int not null,
  verified boolean not null default false
);

create table generated_checklist_entries (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references generated_checklists(id) on delete cascade,
  card_number text not null,
  player_name text not null,
  unique (checklist_id, card_number)
);

create index generated_checklist_entries_checklist_id_idx on generated_checklist_entries(checklist_id);

-- Server-only: read/written exclusively through api/checklist-lookup.ts using the
-- service-role client (api/_lib/supabaseAdmin.ts). No anon access policy is added —
-- same "private by default, no RLS policy" posture as the scan-uploads bucket in
-- 0008_scan_batches.sql. The browser's anon key never touches these tables directly.
alter table generated_checklists enable row level security;
alter table generated_checklist_entries enable row level security;
