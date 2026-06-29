// Bundled-checklist auto-lookup.
//
// Why this exists: running a one-off SQL UPDATE every time a new set is scanned doesn't
// scale (Joe's explicit feedback) and live-scraping a checklist site on every save is
// fragile/legally murky (same caution as api/pricing/sources/beckett.ts). Instead, real
// checklists get sourced ONCE (by Claude, ad hoc, same approach used for 1991 Fleer) into a
// small bundled JSON library here. From then on, every future scan/import of that same
// year + manufacturer + sport set automatically pulls real player names with zero manual
// SQL — Capture.tsx calls this on save (see api/checklist-lookup.ts).
//
// To add a new set to the library: source its full checklist (card_number -> player name)
// and drop a new JSON file in this directory named `<sport>-<year>-<manufacturer-slug>.json`
// with the shape { sport, year, manufacturer, total_card_count, source, names }.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ChecklistDataset {
  sport: string
  year: number
  manufacturer: string
  total_card_count: number
  source: string
  names: Record<string, string>
}

// __dirname doesn't exist in ES modules (this package.json has "type": "module") — this
// is the ESM-safe equivalent, computed from the module's own URL instead.
const CHECKLISTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'checklists')

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function buildSlug(sport: string, year: number, manufacturer: string): string {
  return `${slugify(sport)}-${year}-${slugify(manufacturer)}`
}

let cache: Map<string, ChecklistDataset> | null = null

function loadAll(): Map<string, ChecklistDataset> {
  if (cache) return cache
  cache = new Map()
  let files: string[] = []
  try {
    files = readdirSync(CHECKLISTS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return cache
  }
  for (const file of files) {
    try {
      const raw = readFileSync(join(CHECKLISTS_DIR, file), 'utf-8')
      const data = JSON.parse(raw) as ChecklistDataset
      const slug = buildSlug(data.sport, data.year, data.manufacturer)
      cache.set(slug, data)
    } catch {
      // Skip malformed dataset files rather than failing the whole lookup.
      continue
    }
  }
  return cache
}

export interface LookupInput {
  sport: string
  year: number | null
  manufacturer: string | null
}

export interface LookupResult {
  found: boolean
  dataset?: ChecklistDataset
}

export function lookupChecklist(input: LookupInput): LookupResult {
  if (!input.year || !input.manufacturer) return { found: false }
  const slug = buildSlug(input.sport, input.year, input.manufacturer)
  const dataset = loadAll().get(slug)
  if (!dataset) return { found: false }
  return { found: true, dataset }
}

export function listAvailableChecklists(): Array<{ sport: string; year: number; manufacturer: string }> {
  return Array.from(loadAll().values()).map((d) => ({
    sport: d.sport,
    year: d.year,
    manufacturer: d.manufacturer,
  }))
}
