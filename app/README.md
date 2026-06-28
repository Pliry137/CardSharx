# CardSharx

Mobile-first web app to digitize and manage a physical trading card collection, track set
completion, and estimate collection value for insurance purposes. Full spec: `../CardCollector.md`.

## Stack

- **Frontend:** React + Vite + TypeScript, Tailwind v4, React Router
- **Backend/DB:** Supabase (Postgres)
- **Deployment:** Vercel (serverless functions under `api/`)
- **Card capture:** Claude Vision API (photo → structured data)
- **Pricing:** ad hoc scrapers (Beckett / PSA / VCP / eBay), no scheduled job

## Project layout

```
app/
  src/
    pages/          Dashboard, SetDetail, Capture, Search
    components/     Layout, SetProgressCard
    lib/supabase.ts Supabase client (anon key, browser-side)
    types/          Shared TS types mirroring the DB schema
  api/
    vision-capture.ts        Claude Vision endpoint (STUB — see TODOs inside)
    pricing/run.ts            Ad hoc pricing refresh orchestrator
    pricing/sources/          One module per source (beckett/psa/vcp/ebay) — all STUBS
  supabase/migrations/        SQL migrations (schema, views, search function)
```

## Current state

This is a scaffold, not a finished app. What works:
- Full project structure, routing, Tailwind styling, build pipeline (`npm run build` passes)
- Complete Supabase schema + views + search function, ready to run as migrations
- Frontend pages wired to the expected Supabase views/RPC and API routes
- Pricing orchestrator (`api/pricing/run.ts`) that reads `data_source_config` and dispatches
  to the right scraper(s) in priority order — this is the extensibility hook described in
  the spec for adding new collection types without code rewrites

What's stubbed (intentionally, pending API keys / scraper build-out):
- `api/vision-capture.ts` — multipart parsing + the real Anthropic call aren't implemented yet
- `api/pricing/sources/*.ts` — each `lookup()` returns `null`; no scraping logic yet

## Setup

```bash
cd app
npm install
cp .env.example .env   # fill in Supabase + Anthropic keys
npm run dev
```

Run the migrations in `supabase/migrations/` against your Supabase project (in order) before
using the app — the dashboard reads from `sets_with_progress` and `cards_with_latest_price`,
both defined in `0002_views.sql`.

To type-check the serverless `api/` folder (not covered by the Vite build):
```bash
npx tsc --project tsconfig.api.check.json
```

## Next steps (see CardCollector.md "Open Considerations" for full list)

1. Wire up `ANTHROPIC_API_KEY` and implement multipart parsing + the real Vision call in
   `api/vision-capture.ts`.
2. Implement the Beckett scraper first (primary source for sports cards) — review Beckett's
   current Terms of Service first given their past scraping litigation.
3. Implement VCP + eBay for non-sport sets (Desert Storm etc.), then PSA as a third fallback.
4. Add a "save to collection" flow that writes Capture results into `cards`/`sets`.
5. Add an insurance-formatted export/summary view.
