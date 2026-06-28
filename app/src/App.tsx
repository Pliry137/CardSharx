import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import SetDetail from './pages/SetDetail'
import Capture from './pages/Capture'
import Search from './pages/Search'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="sets/:setId" element={<SetDetail />} />
          <Route path="capture" element={<Capture />} />
          <Route path="search" element={<Search />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
