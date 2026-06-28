-- Full-text search across player/subject name, card number, set name, manufacturer, and year.

create extension if not exists pg_trgm;

create function search_cards(query text)
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
  order by s.name, c.card_number
  limit 100;
$$;

-- Trigram indexes so ILIKE searches above stay fast as the collection grows.
create index cards_player_trgm_idx on cards using gin (player_or_subject_name gin_trgm_ops);
create index sets_name_trgm_idx on sets using gin (name gin_trgm_ops);
