-- card_number is `text`, so the original `order by s.name, c.card_number` in search_cards
-- (0003_search.sql) sorted lexicographically: "10" came before "2". Re-create the function
-- ordering by a zero-padded version of card_number instead, so numeric card numbers sort
-- numerically while still tolerating non-numeric card numbers (e.g. combo/checklist cards)
-- by falling back to plain text comparison for those.

create or replace function search_cards(query text)
returns table (
  card_id uuid,
  set_id uuid,
  set_name text,
  card_number text,
  player_or_subject_name text,
  collection_type collection_type,
  owned boolean
)
language sql stable as $$
  select
    c.id as card_id,
    s.id as set_id,
    s.name as set_name,
    c.card_number,
    c.player_or_subject_name,
    col.type as collection_type,
    c.owned
  from cards c
  join sets s on s.id = c.set_id
  join collections col on col.id = s.collection_id
  where
    c.player_or_subject_name ilike '%' || query || '%'
    or c.card_number ilike '%' || query || '%'
    or s.name ilike '%' || query || '%'
    or s.manufacturer ilike '%' || query || '%'
    or s.year::text ilike '%' || query || '%'
  order by
    s.name,
    case when c.card_number ~ '^\d+$' then lpad(c.card_number, 10, '0') else c.card_number end
  limit 100;
$$;
