// Vercel serverless function: POST /api/pricing/run
// Body: { set_id: string }
//
// Ad hoc pricing refresh, triggered by the user (no scheduled job — same low-maintenance
// pattern as the DiveMeets scraper in Dive In). For every card in the set:
//   1. Look up the set's collection type.
//   2. Read data_source_config for that type, ordered by priority.
//   3. Try each configured source in order until one returns a price.
//   4. Write a new row to card_prices (history is kept; dashboard reads the latest one).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { beckettSource } from './sources/beckett.js'
import { psaSource } from './sources/psa.js'
import { vcpSource } from './sources/vcp.js'
import { ebaySource } from './sources/ebay.js'
import type { PricingSource } from './sources/types.js'

const sourcesByName: Record<string, PricingSource> = {
  beckett: beckettSource,
  psa: psaSource,
  vcp: vcpSource,
  ebay: ebaySource,
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  }
  // Service role key (not the anon key) since this writes card_prices server-side.
  return createClient(url, serviceKey)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { set_id } = req.body ?? {}
  if (!set_id) {
    res.status(400).json({ error: 'set_id is required' })
    return
  }

  try {
    const supabase = getServiceClient()

    const { data: set, error: setError } = await supabase
      .from('sets')
      .select('id, name, manufacturer, year, collections(type)')
      .eq('id', set_id)
      .single()
    if (setError || !set) throw new Error(setError?.message ?? 'Set not found')

    const collectionType = (set as unknown as { collections: { type: string } }).collections.type

    const { data: config } = await supabase
      .from('data_source_config')
      .select('*')
      .eq('collection_type', collectionType)
      .order('priority')
    const orderedSources = (config ?? [])
      .map((c) => sourcesByName[c.source_name])
      .filter(Boolean)

    const { data: cards } = await supabase.from('cards').select('*').eq('set_id', set_id)

    let updated = 0
    let skipped = 0

    for (const card of cards ?? []) {
      let found = false
      for (const source of orderedSources) {
        const result = await source.lookup({
          cardNumber: card.card_number,
          playerOrSubjectName: card.player_or_subject_name,
          setName: set.name,
          manufacturer: set.manufacturer,
          year: set.year,
          configDetails: {},
        })
        if (result) {
          await supabase.from('card_prices').insert({
            card_id: card.id,
            price: result.price,
            source: result.source,
          })
          updated += 1
          found = true
          break
        }
      }
      if (!found) skipped += 1
    }

    res.status(200).json({ set_id, cards_priced: updated, cards_skipped: skipped })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pricing run failed' })
  }
}
