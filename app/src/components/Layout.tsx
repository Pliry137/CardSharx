import { NavLink, Outlet } from 'react-router-dom'

const tabs = [
  { to: '/', label: 'Dashboard' },
  { to: '/search', label: 'Search' },
  { to: '/capture', label: 'Capture' },
]

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center justify-between">
        <span className="font-semibold text-lg tracking-tight">CardSharx</span>
        <span className="text-xs text-slate-400">collection inventory & valuation</span>
      </header>

      <main className="flex-1 px-4 py-4 pb-20 max-w-3xl w-full mx-auto">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex justify-around py-2 max-w-3xl mx-auto w-full">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `text-sm px-3 py-1.5 rounded-md ${
                isActive
                  ? 'text-indigo-600 dark:text-indigo-400 font-medium'
                  : 'text-slate-500'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
