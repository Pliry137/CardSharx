# Card Collection Inventory App — Project Brief

## Overview
A mobile-first web app to digitize and manage a physical trading card collection (starting with baseball, expanding to football, basketball, and non-sports sets like Desert Storm cards). The app tracks what cards are owned vs. what should exist in a full set, estimates market value (primarily for insurance purposes), and lets the user search/filter across the whole collection.

**Primary use case driving design decisions:** insurance valuation of the collection — favor standardized, defensible pricing sources over noisy live marketplace data where possible.

---

## Tech Stack
- **Frontend:** React, mobile-first responsive design (must also work well on desktop)
- **Backend / DB:** Supabase (same pattern as the "Dive In" and "Fuel Log" projects)
- **Deployment:** Vercel
- **Card data capture:** Claude Vision API (same pattern as Fuel Log) — user takes a photo, Claude extracts structured data
- **Pricing data:** Custom scraper(s), run **ad hoc** (on demand), not on a schedule — same pattern as the DiveMeets scraper built for Dive In

---

## Core Features

### 1. Inventory Management
- Track owned cards by **set, make/manufacturer, year, card number**
- One paper checklist = one set (user scans one sheet at a time)
- Manual add / edit / remove of individual cards (e.g., to correct a bad scan or log a sale)
- No condition/grading tracking needed (out of scope intentionally)

### 2. Checklist Capture (OCR via Claude Vision API)
- User photographs a paper checklist (or the card itself, front or back) with phone camera
- Claude Vision API parses the image into structured card data (set, card numbers, names)
- App attempts to **auto-detect the set** from the image
- If set can't be auto-detected, user can manually select/enter it as a fallback
- This mirrors the Fuel Log pattern: photo → Claude API call → structured data → Supabase

### 3. Set Completion Tracking
- For any set, pull the **full official checklist** (what *should* exist in the set) from a public data source
- Compare against what the user actually owns
- Dashboard shows:
  - Full set checklist
  - Which cards are missing
  - Individual card market values
  - Total value of the complete set (reference) and total value of the user's owned cards within that set
  - Overall collection value across all sets

### 4. Pricing Data
- **Sports cards (baseball, football, basketball):** Beckett is the primary source.
  - Why Beckett over eBay: Beckett provides one standardized, curated price per card — more defensible for insurance purposes. eBay sold-listing averages are noisier (condition, seller, timing variance) and harder to justify to an insurer.
  - Beckett does not offer a public API — pricing/checklist data needs to be scraped. (Note: Beckett has pursued legal action against at least one third party for scraping/reusing their data — see "Open Considerations" below.)
- **Non-sports cards (e.g., Desert Storm, 1991 Topps/Pro Set):** Beckett doesn't cover these. Use:
  - **PSA** (Auction Prices Realized / PSA Price Guide)
  - **VCP — Vintage Card Prices** (aggregates eBay historical sold data)
  - **eBay** sold listings directly
- **Pricing refresh model:** No scheduled job. User triggers a pricing lookup/refresh **ad hoc** when they want updated values — same low-maintenance approach used for the DiveMeets scraper in Dive In.

### 5. Multi-Sport / Multi-Collection-Type Support
- Each collection has a **type** (baseball, football, basketball, non-sport, etc.)
- Dashboard can filter by collection type
- Architecture should be **flexible/extensible**: a configuration table mapping collection type → applicable pricing/checklist data source(s), so new collection types (and their data sources) can be added without code rewrites
- Example mapping:
  - Baseball / Football / Basketball → Beckett
  - Desert Storm / other non-sport → PSA, VCP, eBay

### 6. Search, Filter, and Sort
- Full-text search across **all data points**: player name, card name, set name, card number, manufacturer, year
- Filter by player name, card number, set, collection type
- Sort sets by:
  - Total value (most valuable set first)
  - Completion percentage (closest to completing a set)

---

## Suggested Data Model (starting point — refine in Cowork)

**collections**
- id, name, type (baseball/football/basketball/non-sport/...), description

**sets**
- id, collection_id, name, year, manufacturer, total_card_count, source_checklist_url

**cards**
- id, set_id, card_number, player_or_subject_name, owned (bool), date_added, notes

**card_prices**
- id, card_id, price, source (beckett/psa/vcp/ebay), date_fetched

**data_source_config**
- id, collection_type, source_name, source_type (scraper/api), config_details (e.g., base URL, selectors)

---

## Open Considerations / Next Steps for Build
1. **Beckett scraping risk:** Beckett has previously sued at least one third party (COMC) over reuse of its checklist/pricing data. A personal-use, low-frequency, ad hoc scraper for a private collection app is a very different risk profile than a commercial product, but worth being mindful of Beckett's Terms of Service when building the scraper.
2. **Scraper design:** Follow the same architecture pattern as the DiveMeets scraper (Dive In project) — point-in-time fetch, structured parse, write to Supabase.
3. **Set auto-detection logic:** Decide what Claude Vision is given to work with (front of card, back of card, or checklist sheet) and how confident it needs to be before falling back to manual entry.
4. **Non-sport source integration order:** Start with eBay sold listings + VCP for Desert Storm (most accessible), add PSA Auction Prices Realized as a secondary source.
5. **Insurance reporting view:** Consider a dedicated "export/summary" view formatted for insurance documentation purposes (total value, valuation source, date valued).

---

## Reference: Prior Related Projects (for pattern reuse)
- **Dive In** (Henry's diving app): Supabase + React + Tailwind, hosted on Vercel; includes a custom scraper (DiveMeets.com) for historical data import.
- **Fuel Log**: Uses Claude API with image input to convert a photo into structured data for logging.

---

## Backlog
1. **Automated import of player names** — ~~when a new set is scanned/imported, look up and fill in real player/subject names for each card automatically instead of leaving placeholder values~~ **Done (2026-06-29).** `api/checklist-lookup.ts` now falls back through three tiers: bundled JSON library (verified) → cached auto-generated checklist (Supabase `generated_checklists`/`generated_checklist_entries`, migration `0009_generated_checklists.sql`) → fresh generation via Claude's trained knowledge (`api/_lib/checklistGenerate.ts`), cached for every future scan of that set. Auto-generated names are marked `verified: false` and Capture.tsx shows an amber "please double-check" note for them, since this is knowledge-based, not source-verified (scraping TCDB/Beckett for checklists was ruled out — their ToS forbids it, same issue as the pricing investigation below).
2. **Beckett pricing guide imports** — pull both the official checklist (full set, what *should* exist) and per-card pricing from Beckett for sports sets, per the "Pricing Data" section above. `api/pricing/_sources/beckett.ts` currently exists but returns no real data yet (no scraping logic implemented) — see "Beckett scraping risk" under Open Considerations before building this.
   - **Status (checked 2026-06-29): held, not started.** All four pricing sources are stubs (`api/pricing/_sources/{beckett,psa,vcp,ebay}.ts` each return `null`). Investigated the non-Beckett sources as a lower-risk starting point and hit real blockers on every one:
     - **eBay**: sold-listings search results are rendered client-side — a plain server-side fetch of the `LH_Complete=1&LH_Sold=1` search URL does not return real query results (confirmed by testing directly). Would need a headless browser (e.g. Playwright) running somewhere other than Vercel serverless functions, which can't host a browser process — real added infra/hosting cost, not a simple scraper.
     - **VCP (vintagecardprices.com)**: card-level valuations are gated behind a paid login (confirmed via their site — full pricing requires "JOIN VCP NOW"). A scraper would need an authenticated session, carrying similar ToS exposure to the Beckett risk already noted.
     - **PSA (Auction Prices Realized)**: same pattern as VCP — subscription-gated, not checked further.
   - Decision: held for now rather than building something fragile/risky. Next time this comes up, the options are (a) manual price-entry UI (look the price up yourself, type it in — no scraping, ships fast, works for any source), (b) take on real scraping infra (headless browser hosted off-Vercel) for eBay specifically, or (c) revisit if any of these sites add a public API.
