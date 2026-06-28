import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Card, CardSet } from '../types'

interface CardRow extends Card {
  latest_price: number | null
}

export default function SetDetail() {
  const { setId } = useParams()
  const [set, setSet] = useState<CardSet | null>(null)
  const [cards, setCards] = useState<CardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!setId) return
    let cancelled = false

    async function load() {
      setLoading(true)
      const [setRes, cardsRes] = await Promise.all([
        supabase.from('sets').select('*').eq('id', setId).single(),
        // `cards_with_latest_price` view joins cards -> most recent card_prices row per card
        supabase.from('cards_with_latest_price').select('*').eq('set_id', setId).order('card_number'),
      ])

      if (cancelled) return
      if (setRes.data) setSet(setRes.data as CardSet)
      if (cardsRes.data) setCards(cardsRes.data as CardRow[])
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
        <button
          onClick={refreshPricing}
          disabled={refreshing}
          className="text-xs px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh pricing'}
        </button>
      </div>

      <p className="text-sm text-slate-500">
        {cards.filter((c) => c.owned).length} / {set.total_card_count ?? cards.length} owned ·{' '}
        {missing.length} missing
      </p>

      <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
        {cards.map((card) => (
          <li key={card.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div className="flex items-center gap-3">
              <span className={card.owned ? '' : 'text-slate-400'}>#{card.card_number}</span>
              <span className={card.owned ? '' : 'text-slate-400 line-through'}>
                {card.player_or_subject_name}
              </span>
            </div>
            <span className="text-slate-500">
              {card.latest_price != null
                ? card.latest_price.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                : '—'}
            </span>
          </li>
        ))}
        {cards.length === 0 && (
          <li className="px-3 py-3 text-sm text-slate-400">
            No cards in this set yet. Scan a checklist from the Capture tab.
          </li>
        )}
      </ul>
    </div>
  )
}
