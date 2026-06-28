import { useState } from 'react'
import { supabase } from '../lib/supabase'

interface SearchHit {
  card_id: string
  set_id: string
  set_name: string
  card_number: string
  player_or_subject_name: string
  collection_type: string
  owned: boolean
}

export default function Search() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)

  async function runSearch(q: string) {
    setQuery(q)
    if (!q.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    // `search_cards` is a Postgres function (see supabase/migrations/0003_search.sql) that
    // full-text searches across player/subject name, card number, set name, manufacturer, and year.
    const { data } = await supabase.rpc('search_cards', { query: q })
    setResults((data as SearchHit[]) ?? [])
    setLoading(false)
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Search collection</h1>
      <input
        value={query}
        onChange={(e) => runSearch(e.target.value)}
        placeholder="Player, set, card number, manufacturer, year…"
        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm"
      />

      {loading && <p className="text-sm text-slate-400">Searching…</p>}

      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {results.map((hit) => (
          <li key={hit.card_id} className="py-2 text-sm flex justify-between">
            <div>
              <p className={hit.owned ? '' : 'text-slate-400'}>{hit.player_or_subject_name}</p>
              <p className="text-xs text-slate-400">
                {hit.set_name} · #{hit.card_number} · {hit.collection_type}
              </p>
            </div>
            {!hit.owned && <span className="text-xs text-amber-500">missing</span>}
          </li>
        ))}
        {!loading && query && results.length === 0 && (
          <li className="py-2 text-sm text-slate-400">No matches.</li>
        )}
      </ul>
    </div>
  )
}
