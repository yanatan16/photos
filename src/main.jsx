import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { DevToolsProvider } from './context/DevToolsContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DevToolsProvider>
      <App />
    </DevToolsProvider>
  </StrictMode>,
)
