-- Tracks whether a background checklist generation (api/checklist-lookup.ts tier 3,
-- kicked off via waitUntil() — see 0009_generated_checklists.sql + the "Decouple checklist
-- generation from Save" fix) is still in flight, finished, or failed for a given
-- sport/year/manufacturer slug. Needed because generation now happens AFTER the save
-- response is sent (to avoid the 60s Vercel function timeout large sets were hitting), so
-- something has to record in-progress state for the dashboard/set-detail "checklist
-- generating..." badge to read.
--
-- Existing rows predate this column and are already fully-populated checklists, so they
-- default to 'ready'.
alter table generated_checklists
  add column status text not null default 'ready'
  check (status in ('pending', 'ready', 'failed'));
