-- Adds condition tracking to individual cards. The original project brief
-- (CardCollector.md) explicitly called this out of scope, but Joe asked for it
-- directly: a simple flag for "damaged" / "poor" condition cards, distinct from
-- owned/missing. Not full professional grading (no PSA-style 1-10 scale) — just
-- enough to flag cards whose insurance value should be discounted.

create type card_condition as enum ('good', 'damaged', 'poor');

alter table cards add column condition card_condition not null default 'good';
create index cards_condition_idx on cards(condition);
