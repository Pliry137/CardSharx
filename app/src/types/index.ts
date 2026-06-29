// Core data model types — mirrors the Supabase schema in supabase/migrations/0001_init.sql

export type CollectionType = 'baseball' | 'football' | 'basketball' | 'non-sport'

export interface Collection {
  id: string
  name: string
  type: CollectionType
  description: string | null
  created_at: string
}

export interface CardSet {
  id: string
  collection_id: string
  name: string
  year: number | null
  manufacturer: string | null
  total_card_count: number | null
  source_checklist_url: string | null
  owner: string | null
  created_at: string
}

export type CardCondition = 'good' | 'damaged' | 'poor'

export interface Card {
  id: string
  set_id: string
  card_number: string
  player_or_subject_name: string
  owned: boolean
  condition: CardCondition
  date_added: string | null
  notes: string | null
}

export type PriceSource = 'beckett' | 'psa' | 'vcp' | 'ebay'

export interface CardPrice {
  id: string
  card_id: string
  price: number
  source: PriceSource
  date_fetched: string
}

export type SourceType = 'scraper' | 'api'

export interface DataSourceConfig {
  id: string
  collection_type: CollectionType
  source_name: PriceSource
  source_type: SourceType
  config_details: Record<string, unknown>
  priority: number
}

// Derived / view-model types used by the dashboard

export interface SetWithProgress extends CardSet {
  owned_count: number
  total_value: number
  owned_value: number
  completion_pct: number
}

// One row per owner, aggregated across all of their sets (see owner_summary
// view in supabase/migrations/0004_owner.sql)
export interface OwnerSummary {
  owner: string
  set_count: number
  total_owned_cards: number
  total_owned_value: number
}

// Shape returned by the Claude Vision capture endpoint (api/vision-capture.ts)
export interface VisionCaptureResult {
  detected_set_name: string | null
  detected_set_confidence: number
  manufacturer: string | null
  year: number | null
  // Handwritten name in the corner of the checklist identifying whose
  // collection this set belongs to (e.g. "Joe", "Paul", "Tim", "Dan").
  owner_name: string | null
  owner_confidence: number
  cards: Array<{
    card_number: string
    player_or_subject_name: string
    // Per-card confidence that the X/blank mark was read correctly. Cards
    // below the confirmation threshold get flagged in Capture.tsx for the
    // user to manually confirm present/absent before saving.
    presence_confidence: number
    owned: boolean
  }>
}

// Mirrors supabase/migrations/0008_scan_batches.sql. A batch tracks one multi-page
// PDF upload (e.g. a whole binder scanned at once) so its sheets can be reviewed/
// saved one at a time and resumed later, from any device.
export interface ScanBatch {
  id: string
  created_at: string
  original_filename: string | null
  total_pages: number
  storage_path: string
  status: 'in_progress' | 'completed'
  owner: string | null
}

export interface ScanBatchPage {
  id: string
  batch_id: string
  page_number: number
  status: 'pending' | 'processed' | 'skipped'
  set_id: string | null
  processed_at: string | null
}

// Shape returned by api/scan-batch-page.ts — the same fields as VisionCaptureResult
// plus which batch/page they came from.
export interface ScanBatchPageResult extends VisionCaptureResult {
  batch_id: string
  page_number: number
  total_pages: number
}
