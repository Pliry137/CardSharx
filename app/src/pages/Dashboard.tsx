import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CollectionType, SetWithProgress } from '../types'
import SetProgressCard from '../components/SetProgressCard'

type SortKey = 'value' | 'completion'

const COLLECTION_TYPES: Array<CollectionType | 'all'> = [
  'all',
  'baseball',
  'football',
  'basketball',
  'non-sport',
]

export default function Dashboard() {
  const [sets, setSets] = useState<SetWithProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<CollectionType | 'all'>('all')
  const [ownerFilter, setOwnerFilter] = useState<string | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('value')

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      // This queries a `sets_with_progress` view (see supabase/migrations/0002_views.sql)
      // that pre-aggregates owned_count / total_value / owned_value / completion_pct
      // per set, joined against the collection's type for filtering.
      const { data, error } = await supabase
        .from('sets_with_progress')
        .select('*')

      if (cancelled) return
      if (error) {
        setError(error.message)
      } else {
        setSets((data as SetWithProgress[]) ?? [])
      }
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const owners = useMemo(
    () => Array.from(new Set(sets.map((s) => s.owner).filter((o): o is string => !!o))).sort(),
    [sets],
  )

  const filteredAndSorted = useMemo(() => {
    let filtered =
      typeFilter === 'all'
        ? sets
        : sets.filter((s) => (s as SetWithProgress & { collection_type?: string }).collection_type === typeFilter)

    if (ownerFilter !== 'all') {
      filtered = filtered.filter((s) => s.owner === ownerFilter)
    }

    return [...filtered].sort((a, b) =>
      sortKey === 'value' ? b.owned_value - a.owned_value : b.completion_pct - a.completion_pct,
    )
  }, [sets, typeFilter, ownerFilter, sortKey])

  const totalValue = useMemo(
    () => filteredAndSorted.reduce((sum, s) => sum + s.owned_value, 0),
    [filteredAndSorted],
  )

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
        <p className="text-sm text-slate-500">Total collection value (owned)</p>
        <p className="text-3xl font-semibold mt-1">
          {totalValue.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
        </p>
      </section>

      <section className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {COLLECTION_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`text-xs px-3 py-1.5 rounded-full border ${
                typeFilter === t
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="text-xs border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1.5 bg-transparent"
        >
          <option value="value">Sort: most valuable</option>
          <option value="completion">Sort: closest to complete</option>
        </select>
      </section>

      {owners.length > 0 && (
        <section className="flex flex-wrap gap-1 items-center">
          <span className="text-xs text-slate-500 mr-1">Owner:</span>
          <button
            onClick={() => setOwnerFilter('all')}
            className={`text-xs px-3 py-1.5 rounded-full border ${
              ownerFilter === 'all'
                ? 'bg-brand-600 text-white border-brand-600'
                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            all
          </button>
          {owners.map((o) => (
            <button
              key={o}
              onClick={() => setOwnerFilter(o)}
              className={`text-xs px-3 py-1.5 rounded-full border ${
                ownerFilter === o
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              {o}
            </button>
          ))}
        </section>
      )}

      {loading && <p className="text-sm text-slate-400">Loading sets…</p>}
      {error && (
        <p className="text-sm text-red-500">
          Couldn't load sets ({error}). Have you run the Supabase migrations and set your .env?
        </p>
      )}
      {!loading && !error && filteredAndSorted.length === 0 && (
        <p className="text-sm text-slate-400">
          No sets yet. Use the Capture tab to scan a checklist and add your first set.
        </p>
      )}

      <section className="space-y-3">
        {filteredAndSorted.map((set) => (
          <SetProgressCard key={set.id} set={set} />
        ))}
      </section>
    </div>
  )
}
