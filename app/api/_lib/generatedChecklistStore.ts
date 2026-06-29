// Supabase-backed cache for auto-generated checklists (api/_lib/checklistGenerate.ts),
// keyed the same way as the bundled JSON library (api/_lib/checklistLookup.ts) so both
// caches stay interchangeable from the caller's point of view. See
// supabase/migrations/0009_generated_checklists.sql for the table shapes and why these
// are admin-only (no anon RLS policy — read/written exclusively from here, server-side).
import { getSupabaseAdmin } from './supabaseAdmin.js'
import { buildSlug } from './checklistLookup.js'

export interface CachedGeneratedChecklist {
  total_card_count: number
  names: Record<string, string>
  verified: boolean
}

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

export async function saveGeneratedChecklist(
  sport: string,
  year: number,
  manufacturer: string,
  data: { total_card_count: number; names: Record<string, string> },
): Promise<void> {
  const slug = buildSlug(sport, year, manufacturer)
  const admin = getSupabaseAdmin()

  const { data: checklist, error } = await admin
    .from('generated_checklists')
    .insert({
      sport,
      year,
      manufacturer,
      slug,
      total_card_count: data.total_card_count,
      verified: false,
    })
    .select('id')
    .single()

  // A write failure here (e.g. a race between two concurrent saves of the same brand-new
  // set hitting the unique slug constraint) is non-fatal — the caller already has the
  // generated names in hand for the request that's in flight, this just means the next
  // request for this set regenerates instead of reading the cache.
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
