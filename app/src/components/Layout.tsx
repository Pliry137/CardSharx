import { NavLink, Outlet } from 'react-router-dom'
import logo from '../assets/cardsharx-logo.png'

const tabs = [
  { to: '/', label: 'Dashboard' },
  { to: '/search', label: 'Search' },
  { to: '/capture', label: 'Capture' },
]

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col bg-brand-ice text-brand-950 dark:bg-brand-950 dark:text-brand-ice">
      <header className="border-b border-brand-300/30 dark:border-brand-800 px-4 py-3 flex items-center justify-center">
        <img src={logo} alt="CardSharx" className="h-20 w-auto" />
      </header>

      <main className="flex-1 px-4 py-4 pb-20 max-w-3xl w-full mx-auto">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-brand-300/30 dark:border-brand-800 bg-white dark:bg-brand-950 flex justify-around py-2 max-w-3xl mx-auto w-full">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `text-sm px-3 py-1.5 rounded-md ${
                isActive
                  ? 'text-brand-600 dark:text-brand-cyan font-medium'
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
