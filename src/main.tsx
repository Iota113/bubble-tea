import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { configError } from './api'
import PublicPage from './PublicPage'
import DoorPage from './DoorPage'
import './styles.css'

// Two routes only, so a pathname switch is enough. vercel.json / _redirects
// rewrite every path to index.html so /door works on refresh.
const path = window.location.pathname.replace(/\/+$/, '')
const Page = path === '/door' ? DoorPage : PublicPage

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {configError && <div className="banner banner-error">{configError}</div>}
    <Page />
  </StrictMode>,
)
