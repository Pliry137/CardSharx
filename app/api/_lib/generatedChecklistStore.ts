// Supabase-backed cache for auto-generated checklists (api/_lib/checklistGenerate.ts),
// keyed the same way as the bundled JSON library (api/_lib/checklistLookup.ts) so both
// caches stay interchangeable from the caller's point of view. See
// supabase/migrations/0009_generated_checklists.sql for the table shapes and why these
// are admin-only (no anon RLS policy — read/written exclusively from here, server-side),
// and supabase/migrations/0010_checklist_generation_status.sql for the `status` column
// this file uses to track in-flight background generation (pending/ready/failed).
import { getSupabaseAdmin } from './supabaseAdmin.js'
import { buildSlug } from './checklistLookup.js'

export interface CachedGeneratedChecklist {
  total_card_count: number
  names: Record<string, string>
  verified: boolean
}

export type GenerationStatus = 'none' | 'pending' | 'ready' | 'failed'

export interface GenerationStatusResult {
  status: GenerationStatus
  verified: boolean
  total_card_count: number
}

// Only ever returns a hit for a fully-written ('ready') checklist — a pending or failed
// row has no usable entries yet, so it's treated the same as not-cached.
export async function getCachedGeneratedChecklist(
  sport: string,
  year: number,
  manufacturer: string,
): Promise<CachedGeneratedChecklist | null> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()

  const { data: checklist } = await admin
    .from('generated_checklists')
    .select('id, total_card_count, verified')
    .eq('slug', slug)
    .eq('status', 'ready')
    .maybeSingle()
  if (!checklist) return null

  const { data: entries } = await admin
    .from('generated_checklist_entries')
    .select('card_number, player_name')
    .eq('checklist_id', checklist.id)

  const names: Record<string, string> = {}
  for (const entry of entries ?? []) {
    names[entry.card_number as string] = entry.player_name as string
  }

  return {
    total_card_count: checklist.total_card_count as number,
    names,
    verified: checklist.verified as boolean,
  }
}

// Status-only read, no side effects — used both by checklist-lookup.ts (to avoid kicking
// off a second background generation while one is already pending) and by the dashboard/
// set-detail "checklist generating..." badge.
export async function getGenerationStatus(
  sport: string,
  year: number,
  manufacturer: string,
): Promise<GenerationStatusResult> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()

  const { data } = await admin
    .from('generated_checklists')
    .select('status, verified, total_card_count')
    .eq('slug', slug)
    .maybeSingle()

  if (!data) return { status: 'none', verified: false, total_card_count: 0 }
  return {
    status: data.status as GenerationStatus,
    verified: data.verified as boolean,
    total_card_count: (data.total_card_count as number) ?? 0,
  }
}

// Written synchronously (before the save response goes out) so the status is visible
// immediately, even though the actual generation call runs afterward via waitUntil().
// Upserts on slug so a retry after a previous 'failed'/cleared row doesn't hit the unique
// constraint.
export async function markGenerationPending(sport: string, year: number, manufacturer: string): Promise<void> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()
  await admin
    .from('generated_checklists')
    .upsert(
      { sport, year, manufacturer, slug, total_card_count: 0, verified: false, status: 'pending' },
      { onConflict: 'slug' },
    )
}

// Generation came back empty or threw. Delete the pending row rather than marking it
// 'failed' permanently — there's no real cost to the next save attempting generation again
// from scratch, and this avoids a slug getting stuck forever if a transient error caused it.
export async function clearPendingChecklist(sport: string, year: number, manufacturer: string): Promise<void> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()
  await admin.from('generated_checklists').delete().eq('slug', slug).eq('status', 'pending')
}

export async function saveGeneratedChecklist(
  sport: string,
  year: number,
  manufacturer: string,
  data: { total_card_count: number; names: Record<string, string> },
): Promise<void> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()

  // Upsert (not insert) — a 'pending' row for this slug was already written by
  // markGenerationPending before generation started, so this updates it in place to
  // 'ready' rather than colliding with the unique slug constraint.
  const { data: checklist, error } = await admin
    .from('generated_checklists')
    .upsert(
      { sport, year, manufacturer, slug, total_card_count: data.total_card_count, verified: false, status: 'ready' },
      { onConflict: 'slug' },
    )
    .select('id')
    .single()

  // A write failure here is non-fatal — the in-flight background job just won't have
  // cached its result, so the next save of this set regenerates instead of reading the cache.
  if (error || !checklist) return

  const rows = Object.entries(data.names).map(([card_number, player_name]) => ({
    checklist_id: checklist.id,
    card_number,
    player_name,
  }))
  if (rows.length > 0) {
    await admin.from('generated_checklist_entries').insert(rows)
  }
}
