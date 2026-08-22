/**
 * Getting hold of an `EditorEngine` instance.
 *
 * `App` takes an `EngineFactory` as a prop rather than importing the engine
 * itself, which keeps the whole UI type-checkable against `core/contract`
 * alone. The import here is dynamic so the engine — which pulls in pdf-lib and
 * pdf.js — lands in its own chunk and the shell renders immediately.
 */
import type { EditorEngine } from '../core/contract'

/** Build an engine for one uploaded file. */
export type EngineFactory = (file: File, signal?: AbortSignal) => Promise<EditorEngine>

export async function resolveEngineFactory(): Promise<EngineFactory> {
  const { createEngine } = await import('../core/engine')
  return createEngine
}
