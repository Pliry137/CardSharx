-- The app currently has no auth layer (anon key only, single user). Supabase
-- enabled Row Level Security on these tables with no policies attached,
-- which silently blocks the anon key from reading/writing the base tables
-- directly (e.g. SetDetail.tsx querying `sets` by id gets a 406 — 0 rows
-- visible — even though the row exists, because views created via the SQL
-- editor run as the table owner and bypass RLS, but direct anon queries do
-- not). This makes access explicit and open until real auth is added.

alter table collections enable row level security;
alter table sets enable row level security;
alter table cards enable row level security;
alter table card_prices enable row level security;
alter table data_source_config enable row level security;

drop policy if exists "anon full access" on collections;
create policy "anon full access" on collections for all using (true) with check (true);

drop policy if exists "anon full access" on sets;
create policy "anon full access" on sets for all using (true) with check (true);

drop policy if exists "anon full access" on cards;
create policy "anon full access" on cards for all using (true) with check (true);

drop policy if exists "anon full access" on card_prices;
create policy "anon full access" on card_prices for all using (true) with check (true);

drop policy if exists "anon full access" on data_source_config;
create policy "anon full access" on data_source_config for all using (true) with check (true);
