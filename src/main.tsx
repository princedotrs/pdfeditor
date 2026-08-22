/**
 * React entry point.
 *
 * The engine is resolved lazily rather than imported, so the shell renders
 * instantly and a missing or broken engine module surfaces as a readable
 * error on the file the user just dropped instead of a blank page. See
 * `ui/engineLoader.ts` for why the indirection exists at all.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import type { EngineFactory } from './ui/engineLoader'
import { resolveEngineFactory } from './ui/engineLoader'
import './ui/styles.css'

let cached: Promise<EngineFactory> | null = null

const loadEngine: EngineFactory = async (file, signal) => {
  if (!cached) {
    cached = resolveEngineFactory().catch((err: unknown) => {
      // Do not cache a failure: a dev-server reload may fix it.
      cached = null
      throw err
    })
  }
  const factory = await cached
  return factory(file, signal)
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('index.html is missing its #root element')
}

createRoot(container).render(
  <StrictMode>
    <App loadEngine={loadEngine} />
  </StrictMode>
)
