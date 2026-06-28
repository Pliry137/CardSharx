-- Views that back the dashboard and set-detail pages.
-- Pricing always uses each card's most recent fetched price (per source priority isn't
-- resolved here — that's a scraper-side decision when writing card_prices; this view just
-- takes the latest row per card).

create view latest_card_prices as
select distinct on (card_id)
  card_id,
  price,
  source,
  date_fetched
from card_prices
order by card_id, date_fetched desc;

create view cards_with_latest_price as
select
  c.*,
  lcp.price as latest_price,
  lcp.source as latest_price_source,
  lcp.date_fetched as latest_price_date
from cards c
left join latest_card_prices lcp on lcp.card_id = c.id;

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
  col.type as collection_type,
  count(c.id) filter (where c.owned) as owned_count,
  coalesce(sum(cwp.latest_price), 0) as total_value,
  coalesce(sum(cwp.latest_price) filter (where c.owned), 0) as owned_value,
  case
    when coalesce(s.total_card_count, count(c.id)) = 0 then 0
    else round(
      100.0 * count(c.id) filter (where c.owned) / coalesce(s.total_card_count, count(c.id)),
      1
    )
  end as completion_pct
from sets s
join collections col on col.id = s.collection_id
left join cards c on c.set_id = s.id
left join cards_with_latest_price cwp on cwp.id = c.id
group by s.id, col.type;
