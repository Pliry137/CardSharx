import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Card, CardSet } from '../types'

interface CardRow extends Card {
  latest_price: number | null
}

export default function SetDetail() {
  const { setId } = useParams()
  const navigate = useNavigate()
  const [set, setSet] = useState<CardSet | null>(null)
  const [cards, setCards] = useState<CardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // card.id of the row currently being saved, so we can disable just that row and
  // show a quick spinner-ish state instead of locking the whole page.
  const [togglingCardId, setTogglingCardId] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

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
      if (setRes.data) setSet(setRes.data as CardSet)
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

  if (loading) return <p className="text-sm text-slate-400">Loading set…</p>
  if (!set) return <p className="text-sm text-slate-400">Set not found.</p>

  const missing = cards.filter((c) => !c.owned)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{set.name}</h1>
          <p className="text-sm text-slate-500">
            {set.year ?? '—'} · {set.manufacturer ?? 'Unknown manufacturer'}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      <p className="text-xs text-slate-400">Click a card to mark it owned / not owned.</p>
      {toggleError && <p className="text-sm text-red-500">{toggleError}</p>}

      <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
        {cards.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => toggleOwned(card)}
              disabled={togglingCardId === card.id}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-slate-50 dark:hover:bg-slate-900 disabled:opacity-50"
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
              </div>
              <span className="text-slate-500">
                {card.latest_price != null
                  ? card.latest_price.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                  : '—'}
              </span>
            </button>
          </li>
        ))}
        {cards.length === 0 && (
          <li className="px-3 py-3 text-sm text-slate-400">
            No cards in this set yet. Scan a checklist from the Capture tab.
          </li>
        )}
      </ul>

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
