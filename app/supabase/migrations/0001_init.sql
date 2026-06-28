-- CardSharx initial schema
-- Mirrors the data model in CardCollector.md (collections, sets, cards, card_prices, data_source_config)

create extension if not exists "pgcrypto";

create type collection_type as enum ('baseball', 'football', 'basketball', 'non-sport');
create type price_source as enum ('beckett', 'psa', 'vcp', 'ebay');
create type source_type as enum ('scraper', 'api');

create table collections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type collection_type not null,
  description text,
  created_at timestamptz not null default now()
);

create table sets (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references collections(id) on delete cascade,
  name text not null,
  year int,
  manufacturer text,
  total_card_count int,
  source_checklist_url text,
  created_at timestamptz not null default now()
);
create index sets_collection_id_idx on sets(collection_id);

create table cards (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references sets(id) on delete cascade,
  card_number text not null,
  player_or_subject_name text not null,
  owned boolean not null default false,
  date_added timestamptz,
  notes text,
  unique (set_id, card_number)
);
create index cards_set_id_idx on cards(set_id);
create index cards_owned_idx on cards(owned);

create table card_prices (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id) on delete cascade,
  price numeric(10, 2) not null,
  source price_source not null,
  date_fetched timestamptz not null default now()
);
create index card_prices_card_id_idx on card_prices(card_id);
create index card_prices_card_id_date_idx on card_prices(card_id, date_fetched desc);

-- Drives which scraper(s)/API to use for a given collection type, in priority order.
-- e.g. baseball -> beckett (priority 1); non-sport -> vcp (1), ebay (2), psa (3)
create table data_source_config (
  id uuid primary key default gen_random_uuid(),
  collection_type collection_type not null,
  source_name price_source not null,
  source_type source_type not null default 'scraper',
  config_details jsonb not null default '{}'::jsonb,
  priority int not null default 1,
  unique (collection_type, source_name)
);

-- Seed the starting source mapping described in the project brief.
insert into data_source_config (collection_type, source_name, source_type, priority, config_details) values
  ('baseball', 'beckett', 'scraper', 1, '{}'),
  ('football', 'beckett', 'scraper', 1, '{}'),
  ('basketball', 'beckett', 'scraper', 1, '{}'),
  ('non-sport', 'vcp', 'scraper', 1, '{}'),
  ('non-sport', 'ebay', 'scraper', 2, '{}'),
  ('non-sport', 'psa', 'scraper', 3, '{}');
