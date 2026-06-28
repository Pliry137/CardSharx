-- Add owner tracking to sets (the handwritten name in the corner of each
-- physical checklist sheet identifies whose collection that set belongs to).

alter table sets
  add column owner text;

comment on column sets.owner is 'Name handwritten on the physical checklist sheet (e.g. Joe, Paul, Tim, Dan) identifying whose collection this set belongs to.';

create index if not exists sets_owner_idx on sets (owner);

-- Postgres requires CREATE OR REPLACE VIEW to keep existing columns in their
-- original name+position; new columns can only be appended at the end. So
-- `owner` goes last, after the original column list, rather than next to the
-- other `sets` columns.
drop view if exists owner_summary;
drop view if exists sets_with_progress;
create view sets_with_progress as
select
  s.id,
  s.collection_id,
  s.name,
  s.year,
  s.manufacturer,
  s.total_card_count,
  s.source_checklist_url,
  s.created_at,
  c.type as collection_type,
  coalesce(count(cd.id) filter (where cd.owned), 0) as owned_count,
  coalesce(sum(lp.price), 0) as total_value,
  coalesce(sum(lp.price) filter (where cd.owned), 0) as owned_value,
  case
    when s.total_card_count > 0
      then round(100.0 * coalesce(count(cd.id) filter (where cd.owned), 0) / s.total_card_count, 1)
    else 0
  end as completion_pct,
  s.owner
from sets s
join collections c on c.id = s.collection_id
left join cards cd on cd.set_id = s.id
left join latest_card_prices lp on lp.card_id = cd.id
group by s.id, s.collection_id, s.name, s.year, s.manufacturer, s.total_card_count,
  s.source_checklist_url, s.created_at, s.owner, c.type;

-- One row per owner: total sets, total value, owned value -- powers an
-- owner-level dashboard / filter.
create or replace view owner_summary as
select
  owner,
  count(distinct id) as set_count,
  sum(owned_count) as total_owned_cards,
  sum(owned_value) as total_owned_value
from sets_with_progress
where owner is not null
group by owner;
