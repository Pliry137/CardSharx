import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Card, CardCondition, CardSet, CollectionType } from '../types'
import { COLUMNS_PER_ROW, cardNumberForCell } from '../lib/checklistGrid'
import ChecklistStatusBadge from '../components/ChecklistStatusBadge'

interface CardRow extends Card {
  latest_price: number | null
}

type OwnedFilter = 'all' | 'owned' | 'missing'
type ConditionFilter = 'all' | CardCondition

const CONDITION_LABEL: Record<CardCondition, string> = {
  good: 'Good',
  damaged: 'Damaged',
  poor: 'Poor',
}

export default function SetDetail() {
  const { setId } = useParams()
  const navigate = useNavigate()
  const [set, setSet] = useState<CardSet | null>(null)
  // Looked up separately via the set's collection_id — checklist-lookup needs the sport,
  // which isn't on the `sets` row itself (it lives on the parent `collections` row).
  const [sport, setSport] = useState<CollectionType | null>(null)
  const [cards, setCards] = useState<CardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingNames, setRefreshingNames] = useState(false)
  const [namesRefreshMsg, setNamesRefreshMsg] = useState<string | null>(null)
  // card.id of the row currently being saved, so we can disable just that row and
  // show a quick spinner-ish state instead of locking the whole page.
  const [togglingCardId, setTogglingCardId] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  // List filters — purely client-side over the already-loaded cards array, since a
  // set tops out around a few hundred cards (no need to re-query Supabase per filter).
  const [ownedFilter, setOwnedFilter] = useState<OwnedFilter>('all')
  const [conditionFilter, setConditionFilter] = useState<ConditionFilter>('all')

  // Same template-style grid view used in the Capture review screen, so the same
  // physical-sheet layout can be used here for quick include/exclude clicks after the
  // set has already been saved, not just during the initial scan review.
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [lastTappedCardId, setLastTappedCardId] = useState<string | null>(null)

  // condition update is its own per-card async action, separate from the owned toggle,
  // so a card can be flipped owned/missing and have its condition changed independently.
  const [updatingConditionId, setUpdatingConditionId] = useState<string | null>(null)
  const [conditionError, setConditionError] = useState<string | null>(null)

  // Delete-set confirmation flow. Deleting a set is permanent (cascades to its cards
  // and price history via the FK constraints in 0001_init.sql) so it's gated behind
  // an explicit warning and a typed "confirm" rather than a single click.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (!setId) return
    let cancelled = false

    async function load() {
      setLoading(true)
      const [setRes, cardsRes] = await Promise.all([
        supabase.from('sets').select('*').eq('id', setId).single(),
        // `cards_with_latest_price` view joins cards -> most recent card_prices row per card.
        // card_number is `text`, so ordering server-side sorts lexicographically ("10"
        // before "2") — sort numerically client-side instead, below.
        supabase.from('cards_with_latest_price').select('*').eq('set_id', setId),
      ])

      if (cancelled) return
      if (setRes.data) {
        const loadedSet = setRes.data as CardSet
        setSet(loadedSet)
        const { data: collectionData } = await supabase
          .from('collections')
          .select('type')
          .eq('id', loadedSet.collection_id)
          .single()
        if (!cancelled && collectionData) setSport(collectionData.type as CollectionType)
      }
      if (cardsRes.data) {
        const sorted = [...(cardsRes.data as CardRow[])].sort((a, b) => {
          const an = parseInt(a.card_number, 10)
          const bn = parseInt(b.card_number, 10)
          if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
          return a.card_number.localeCompare(b.card_number, undefined, { numeric: true })
        })
        setCards(sorted)
      }
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [setId])

  async function refreshPricing() {
    if (!setId) return
    setRefreshing(true)
    try {
      // Ad-hoc pricing refresh — hits the serverless pricing endpoint (api/pricing/run.ts)
      // which looks up the right scraper(s) via data_source_config for this set's collection type.
      await fetch('/api/pricing/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_id: setId }),
      })
    } finally {
      setRefreshing(false)
    }
  }

  // Backfills real player names onto cards that already exist in this set. This exists
  // because checklist-lookup's tier-3 generation now runs in the background (api/checklist-
  // lookup.ts, to avoid the 60s Vercel function timeout a synchronous generation call could
  // hit) — the set's *original* save never gets those names, since generation wasn't done
  // yet when it ran. This button re-runs the same lookup (now a fast cache hit once
  // generation finishes) and writes any real names straight onto the existing card rows.
  async function refreshNames() {
    if (!set || !sport) return
    setRefreshingNames(true)
    setNamesRefreshMsg(null)
    try {
      const lookupRes = await fetch('/api/checklist-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sport, year: set.year, manufacturer: set.manufacturer }),
      })
      if (!lookupRes.ok) {
        setNamesRefreshMsg("Couldn't check for a checklist right now — try again shortly.")
        return
      }
      const lookupData = await lookupRes.json()
      if (!lookupData.found) {
        setNamesRefreshMsg(
          lookupData.generating
            ? 'Still generating a checklist for this set in the background — try again in a minute or two.'
            : 'No checklist found yet for this set.',
        )
        return
      }
      const names: Record<string, string> = lookupData.names ?? {}
      const updates = cards.filter((c) => names[c.card_number] && names[c.card_number] !== c.player_or_subject_name)
      if (updates.length === 0) {
        setNamesRefreshMsg('Names are already up to date.')
        return
      }
      const results = await Promise.all(
        updates.map((c) => supabase.from('cards').update({ player_or_subject_name: names[c.card_number] }).eq('id', c.id)),
      )
      const failed = results.filter((r) => r.error)
      setCards((prev) =>
        prev.map((c) => (names[c.card_number] ? { ...c, player_or_subject_name: names[c.card_number] } : c)),
      )
      const sourceNote = lookupData.verified
        ? 'the bundled checklist'
        : 'a Claude-generated checklist (trained knowledge, not yet manually verified)'
      setNamesRefreshMsg(
        failed.length > 0
          ? `Updated ${updates.length - failed.length}/${updates.length} card names from ${sourceNote} — ${failed.length} failed to save.`
          : `Updated ${updates.length} card name${updates.length === 1 ? '' : 's'} from ${sourceNote}.`,
      )
    } catch {
      setNamesRefreshMsg('Network error checking for a checklist.')
    } finally {
      setRefreshingNames(false)
    }
  }

  // Toggling owned/not-owned is a quick, instantly-reversible action (click again to
  // flip it back) so unlike set deletion it doesn't need a confirmation step — just
  // an optimistic update with rollback if the write fails.
  async function toggleOwned(card: CardRow) {
    setToggleError(null)
    setTogglingCardId(card.id)
    const nextOwned = !card.owned

    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, owned: nextOwned } : c)))

    const { error } = await supabase.from('cards').update({ owned: nextOwned }).eq('id', card.id)

    if (error) {
      // Roll back the optimistic update and surface the failure.
      setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, owned: card.owned } : c)))
      setToggleError(`Couldn't update #${card.card_number} (${error.message})`)
    }
    setTogglingCardId(null)
  }

  // Same optimistic-update-with-rollback pattern as toggleOwned — a condition change
  // is just as easily reversible (pick a different option), so no confirmation needed.
  async function setCondition(card: CardRow, condition: CardCondition) {
    if (condition === card.condition) return
    setConditionError(null)
    setUpdatingConditionId(card.id)
    const previous = card.condition

    setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, condition } : c)))

    const { error } = await supabase.from('cards').update({ condition }).eq('id', card.id)

    if (error) {
      setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, condition: previous } : c)))
      setConditionError(`Couldn't update #${card.card_number} (${error.message})`)
    }
    setUpdatingConditionId(null)
  }

  async function deleteSet() {
    if (!setId || !set) return
    setDeleting(true)
    setDeleteError(null)

    const { error } = await supabase.from('sets').delete().eq('id', setId)

    if (error) {
      setDeleteError(error.message)
      setDeleting(false)
      return
    }

    navigate('/')
  }

  const deleteConfirmReady = deleteConfirmText.trim().toLowerCase() === 'confirm'

  function closeDeleteConfirm() {
    setShowDeleteConfirm(false)
    setDeleteConfirmText('')
    setDeleteError(null)
  }

  const missing = useMemo(() => cards.filter((c) => !c.owned), [cards])

  const visibleCards = useMemo(
    () =>
      cards.filter((c) => {
        if (ownedFilter === 'owned' && !c.owned) return false
        if (ownedFilter === 'missing' && c.owned) return false
        if (conditionFilter !== 'all' && c.condition !== conditionFilter) return false
        return true
      }),
    [cards, ownedFilter, conditionFilter],
  )

  // Grid view always lays out every card at its true sheet position (cardNumberForCell)
  // regardless of the active filters — pulling cards out would break the physical
  // layout this view exists to mirror. Filtered-out cards are dimmed instead of hidden.
  const cardIndexByNumber = useMemo(() => {
    const map = new Map<string, number>()
    cards.forEach((c, i) => map.set(c.card_number, i))
    return map
  }, [cards])

  const visibleCardIds = useMemo(() => new Set(visibleCards.map((c) => c.id)), [visibleCards])

  const gridRows = useMemo(() => {
    const maxCardNumber = cards.reduce((max, c) => Math.max(max, parseInt(c.card_number, 10) || 0), 0)
    return Math.max(1, Math.ceil(maxCardNumber / COLUMNS_PER_ROW) + 1)
  }, [cards])

  const lastTapped = cards.find((c) => c.id === lastTappedCardId) ?? null

  if (loading) return <p className="text-sm text-slate-400">Loading set…</p>
  if (!set) return <p className="text-sm text-slate-400">Set not found.</p>

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{set.name}</h1>
            <ChecklistStatusBadge sport={sport} year={set.year} manufacturer={set.manufacturer} />
          </div>
          <p className="text-sm text-slate-500">
            {set.year ?? '—'} · {set.manufacturer ?? 'Unknown manufacturer'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshNames}
            disabled={refreshingNames || !sport}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 disabled:opacity-50"
          >
            {refreshingNames ? 'Checking…' : 'Refresh names'}
          </button>
          <button
            onClick={refreshPricing}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh pricing'}
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-600 dark:border-red-800 dark:text-red-400"
          >
            Delete set
          </button>
        </div>
      </div>

      <p className="text-sm text-slate-500">
        {cards.filter((c) => c.owned).length} / {set.total_card_count ?? cards.length} owned ·{' '}
        {missing.length} missing
      </p>

      {namesRefreshMsg && <p className="text-xs text-slate-500">{namesRefreshMsg}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-slate-300 dark:border-slate-700 overflow-hidden text-xs">
          {(['all', 'owned', 'missing'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setOwnedFilter(f)}
              className={`px-2.5 py-1 capitalize ${
                ownedFilter === f
                  ? 'bg-indigo-600 text-white'
                  : 'bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <select
          value={conditionFilter}
          onChange={(e) => setConditionFilter(e.target.value as ConditionFilter)}
          className="text-xs border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 bg-transparent"
        >
          <option value="all">Any condition</option>
          <option value="good">Good only</option>
          <option value="damaged">Damaged only</option>
          <option value="poor">Poor only</option>
        </select>
        <span className="text-xs text-slate-400">
          {visibleCards.length} of {cards.length} shown
        </span>
        <div className="flex gap-1 ml-auto">
          <button
            onClick={() => setView('grid')}
            className={`text-xs px-2 py-1 rounded-md border ${
              view === 'grid'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            Grid
          </button>
          <button
            onClick={() => setView('list')}
            className={`text-xs px-2 py-1 rounded-md border ${
              view === 'list'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            List
          </button>
        </div>
      </div>

      {toggleError && <p className="text-sm text-red-500">{toggleError}</p>}
      {conditionError && <p className="text-sm text-red-500">{conditionError}</p>}

      {view === 'grid' ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Laid out like the checklist sheet (32 per row). Tap a cell to flip it owned / missing.
            {(ownedFilter !== 'all' || conditionFilter !== 'all') &&
              ' Cards outside the current filter are dimmed, not hidden, so the sheet layout stays intact.'}
          </p>
          <div
            className="grid w-full gap-px bg-slate-200 dark:bg-slate-800 p-px rounded"
            style={{ gridTemplateColumns: `repeat(${COLUMNS_PER_ROW}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: gridRows }).flatMap((_, rowIdx) =>
              Array.from({ length: COLUMNS_PER_ROW }).map((__, colIdx) => {
                const row = rowIdx + 1
                const col = colIdx + 1
                const num = cardNumberForCell(row, col)
                const idx = cardIndexByNumber.get(String(num))

                if (idx === undefined) {
                  return <div key={`${row}-${col}`} className="aspect-square bg-white dark:bg-slate-950" />
                }

                const c = cards[idx]
                const dimmed = !visibleCardIds.has(c.id)
                return (
                  <button
                    key={`${row}-${col}`}
                    type="button"
                    onClick={() => {
                      toggleOwned(c)
                      setLastTappedCardId(c.id)
                    }}
                    disabled={togglingCardId === c.id}
                    aria-label={`Card ${c.card_number}, ${c.owned ? 'owned' : 'missing'}, condition ${c.condition}`}
                    className={`aspect-square min-w-0 text-[8px] sm:text-[10px] leading-none flex items-center justify-center overflow-hidden disabled:opacity-50 ${
                      c.owned ? 'bg-emerald-500 text-white' : 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-200'
                    } ${dimmed ? 'opacity-25' : ''} ${
                      c.condition === 'poor'
                        ? 'ring-2 ring-red-500 ring-inset'
                        : c.condition === 'damaged'
                          ? 'ring-2 ring-amber-400 ring-inset'
                          : ''
                    } ${lastTappedCardId === c.id ? 'outline outline-2 outline-indigo-500' : ''}`}
                  >
                    <span className="hidden sm:inline">{c.card_number}</span>
                  </button>
                )
              }),
            )}
          </div>

          {lastTapped && (
            <p className="text-xs bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 rounded px-2 py-1">
              #{lastTapped.card_number} {lastTapped.player_or_subject_name} — now set to:{' '}
              <strong>{lastTapped.owned ? 'owned' : 'missing'}</strong>
              {lastTapped.condition !== 'good' && <> ({CONDITION_LABEL[lastTapped.condition]})</>}
            </p>
          )}

          <p className="text-xs text-slate-400 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> owned
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-400" /> missing
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm ring-2 ring-amber-400 ring-inset" /> damaged
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm ring-2 ring-red-500 ring-inset" /> poor
            </span>
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-400">
            Click a card to mark it owned / not owned. Use the dropdown on the right to flag condition.
          </p>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
        {visibleCards.map((card) => (
          <li key={card.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900">
            <button
              type="button"
              onClick={() => toggleOwned(card)}
              disabled={togglingCardId === card.id}
              className="flex-1 flex items-center justify-between text-left disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <span className={card.owned ? '' : 'text-slate-400'}>#{card.card_number}</span>
                <span className={card.owned ? '' : 'text-slate-400 line-through'}>
                  {card.player_or_subject_name}
                </span>
                <span
                  className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    card.owned
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  {togglingCardId === card.id ? 'saving…' : card.owned ? 'owned' : 'missing'}
                </span>
                {card.condition !== 'good' && (
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      card.condition === 'poor'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                    }`}
                  >
                    {CONDITION_LABEL[card.condition]}
                  </span>
                )}
              </div>
              <span className="text-slate-500">
                {card.latest_price != null
                  ? card.latest_price.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                  : '—'}
              </span>
            </button>
            <select
              value={card.condition}
              disabled={updatingConditionId === card.id}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setCondition(card, e.target.value as CardCondition)}
              className="text-xs border border-slate-300 dark:border-slate-700 rounded-md px-1.5 py-1 bg-transparent disabled:opacity-50"
            >
              <option value="good">Good</option>
              <option value="damaged">Damaged</option>
              <option value="poor">Poor</option>
            </select>
          </li>
        ))}
        {visibleCards.length === 0 && cards.length > 0 && (
          <li className="px-3 py-3 text-sm text-slate-400">No cards match the current filters.</li>
        )}
        {cards.length === 0 && (
          <li className="px-3 py-3 text-sm text-slate-400">
            No cards in this set yet. Scan a checklist from the Capture tab.
          </li>
        )}
          </ul>
        </>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-lg border border-red-300 dark:border-red-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <h2 className="text-base font-semibold text-red-600 dark:text-red-400">Delete "{set.name}"?</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              This permanently deletes this set, all {cards.length} of its cards, and all of their price
              history. This cannot be undone.
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Type <span className="font-mono font-semibold">confirm</span> below to proceed.
            </p>
            <input
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="confirm"
              className="w-full text-sm border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1.5 bg-transparent"
            />
            {deleteError && <p className="text-sm text-red-500">Couldn't delete set: {deleteError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={closeDeleteConfirm}
                disabled={deleting}
                className="text-xs px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteSet}
                disabled={!deleteConfirmReady || deleting}
                className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
