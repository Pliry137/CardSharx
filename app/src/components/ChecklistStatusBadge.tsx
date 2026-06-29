import { useEffect, useState } from 'react'
import type { ChecklistGenerationStatus, CollectionType } from '../types'

// Calls GET /api/checklist-lookup?sport=&year=&manufacturer= (status-only, no side effects
// — see api/checklist-lookup.ts) so sets needing a Claude-generated checklist (api/_lib/
// checklistGenerate.ts) show their state without anyone having to click "Refresh names"
// just to find out whether it's still generating in the background.
export default function ChecklistStatusBadge({
  sport,
  year,
  manufacturer,
}: {
  sport: CollectionType | null
  year: number | null
  manufacturer: string | null
}) {
  const [status, setStatus] = useState<ChecklistGenerationStatus | null>(null)
  const [verified, setVerified] = useState(true)

  useEffect(() => {
    if (!sport || !year || !manufacturer) return
    let cancelled = false

    const params = new URLSearchParams({ sport, year: String(year), manufacturer })
    fetch(`/api/checklist-lookup?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setStatus(data.status ?? 'none')
        setVerified(data.verified ?? true)
      })
      .catch(() => {
        // Badge is purely informational — a failed status check just means no badge shows.
      })

    return () => {
      cancelled = true
    }
  }, [sport, year, manufacturer])

  // Bundled (verified) checklists are applied automatically at save time — nothing for the
  // user to act on, so no badge. Same for "none" (never attempted) to avoid noise on every
  // set that's never needed generation.
  if (status === 'pending') {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
        generating names…
      </span>
    )
  }
  if (status === 'ready' && !verified) {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
        names ready — refresh
      </span>
    )
  }
  return null
}
