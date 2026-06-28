-- Test data import — 1990 Topps + 1991 Fleer
--
-- HONEST STATUS, so you know exactly what you're looking at when testing:
--
-- 1990 Topps (792 cards, owner "Joe"):
--   - Cards 1-640: real transcription attempt from your photos. Missing list
--     below includes everything confirmed missing during review, PLUS a few
--     (600, 657) that were only my own lower-confidence read, never
--     confirmed by you, and PLUS 569/593/622/625 which I'd flagged as
--     uncertain — all of those are included as "missing" here since you
--     said go ahead with the errors. Treat 545-640 as lower confidence than
--     1-544.
--   - Cards 641-792: NEVER reviewed at all (we switched to the Fleer photo
--     before finishing this range). Defaulted to owned=true as a placeholder
--     — this is not real data, just lets the set render at 792 cards for
--     testing. Re-run the Capture/confirm flow on this range before trusting
--     it for anything real.
--
-- 1991 Fleer (720 cards, owner "Joe"):
--   - The photo had a shadow covering a large middle section and was never
--     fully transcribed. Every card here is set owned=true as a placeholder
--     so you can test the set/dashboard UI. None of this reflects an actual
--     read of the checklist — re-shoot and re-import for real data.

insert into collections (name, type)
select 'Baseball Cards', 'baseball'
where not exists (select 1 from collections where name = 'Baseball Cards');

-- 1990 Topps -----------------------------------------------------------

insert into sets (collection_id, name, year, manufacturer, total_card_count, owner)
select id, '1990 Topps', 1990, 'Topps', 792, 'Joe'
from collections
where name = 'Baseball Cards'
  and not exists (select 1 from sets where name = '1990 Topps' and owner = 'Joe');

insert into cards (set_id, card_number, player_or_subject_name, owned)
select
  s.id,
  gs::text,
  gs::text, -- checklist had no player names, just numbers — using the number as a placeholder label
  gs not in (
    1,2,3,4,5,6,7,15,73,95,134,135,151,153,166,193,195,220,
    266,281,283,285,287,414,504,535,600,657,569,593,622,625
  )
from sets s, generate_series(1, 792) gs
where s.name = '1990 Topps' and s.owner = 'Joe'
  and not exists (select 1 from cards c where c.set_id = s.id and c.card_number = gs::text);

-- 1991 Fleer -------------------------------------------------------------

insert into sets (collection_id, name, year, manufacturer, total_card_count, owner)
select id, '1991 Fleer', 1991, 'Fleer', 720, 'Joe'
from collections
where name = 'Baseball Cards'
  and not exists (select 1 from sets where name = '1991 Fleer' and owner = 'Joe');

insert into cards (set_id, card_number, player_or_subject_name, owned)
select
  s.id,
  gs::text,
  gs::text,
  true -- placeholder only — checklist was never actually transcribed
from sets s, generate_series(1, 720) gs
where s.name = '1991 Fleer' and s.owner = 'Joe'
  and not exists (select 1 from cards c where c.set_id = s.id and c.card_number = gs::text);
