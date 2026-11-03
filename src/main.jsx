import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import HealthHud from './components/HealthHud.jsx'
import { start as startHealth } from './lib/health.js'

startHealth()  // begin main-thread freeze watchdog

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <HealthHud />
  </StrictMode>,
)
