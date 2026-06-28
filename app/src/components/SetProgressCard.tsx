import { Link } from 'react-router-dom'
import type { SetWithProgress } from '../types'

function formatCurrency(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function SetProgressCard({ set }: { set: SetWithProgress }) {
  return (
    <Link
      to={`/sets/${set.id}`}
      className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:border-indigo-400 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{set.name}</h3>
          <p className="text-sm text-slate-500">
            {set.year ?? '—'} · {set.manufacturer ?? 'Unknown manufacturer'}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold">{formatCurrency(set.owned_value)}</p>
          <p className="text-xs text-slate-400">of {formatCurrency(set.total_value)}</p>
        </div>
      </div>

      <div className="mt-3 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className="h-full bg-indigo-500"
          style={{ width: `${Math.min(100, set.completion_pct)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {set.owned_count} / {set.total_card_count ?? '?'} cards ({set.completion_pct.toFixed(0)}%)
      </p>
    </Link>
  )
}
