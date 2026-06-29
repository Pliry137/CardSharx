// Vercel serverless function: POST /api/checklist-lookup
// Body: { sport: string, year: number, manufacturer: string }
//
// Called automatically by Capture.tsx right before saving a newly scanned set. Checks the
// bundled checklist library (api/lib/checklists/) for a real card_number -> player_name
// mapping matching this set's sport/year/manufacturer. This is what replaces the old
// "run a SQL UPDATE by hand for every new set" workflow — once a checklist is sourced once,
// it's bundled here and every future scan of that same set auto-applies it.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { lookupChecklist } from './lib/checklistLookup.js'

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { sport, year, manufacturer } = req.body ?? {}
  if (!sport) {
    res.status(400).json({ error: 'sport is required' })
    return
  }

  const result = lookupChecklist({ sport, year: year ?? null, manufacturer: manufacturer ?? null })

  if (!result.found || !result.dataset) {
    res.status(200).json({ found: false, names: {} })
    return
  }

  res.status(200).json({
    found: true,
    names: result.dataset.names,
    source: result.dataset.source,
    total_card_count: result.dataset.total_card_count,
  })
}
