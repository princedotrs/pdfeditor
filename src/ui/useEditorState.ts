/**
 * The pending-edit map plus its undo/redo history.
 *
 * The unit of history is the whole `Map<string, LineEdit>`, snapshotted
 * immutably. Edit maps are small (one entry per *changed* line, not per line)
 * so copying one per history entry is cheap, and it makes undo trivially
 * correct — no inverse operations to get wrong.
 *
 * Consecutive keystrokes in the same line coalesce into a single history entry
 * so that Cmd-Z steps a word or a phrase at a time rather than a character.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LineEdit, OverflowMode } from '../core/model'

export type EditMap = ReadonlyMap<string, LineEdit>

/** How long a line stays "hot" for keystroke coalescing. */
export const COALESCE_MS = 500

export const DEFAULT_OVERFLOW: OverflowMode = 'overflow'
export const DEFAULT_ANCHOR: LineEdit['anchor'] = 'left'

interface History {
  past: EditMap[]
  present: EditMap
  future: EditMap[]
}

const EMPTY: EditMap = new Map()

const INITIAL: History = { past: [], present: EMPTY, future: [] }

/** Keep history bounded so a long session cannot grow without limit. */
const MAX_HISTORY = 200

function pushPast(past: EditMap[], entry: EditMap): EditMap[] {
  const next = past.length >= MAX_HISTORY ? past.slice(past.length - MAX_HISTORY + 1) : past.slice()
  next.push(entry)
  return next
}

/** An edit that would be a no-op does not belong in the map at all. */
function isRedundant(edit: LineEdit, originalText: string): boolean {
  return (
    edit.text === originalText &&
    edit.overflow === DEFAULT_OVERFLOW &&
    edit.anchor === DEFAULT_ANCHOR
  )
}

export interface EditorState {
  edits: EditMap
  /** Number of lines whose text differs from the original. */
  dirtyCount: number
  canUndo: boolean
  canRedo: boolean

  getEdit(lineId: string): LineEdit | undefined
  /** True when this line's text differs from what the PDF originally said. */
  isDirty(lineId: string, originalText: string): boolean

  /** Type into a line. Consecutive calls for the same line coalesce. */
  setText(lineId: string, text: string, originalText: string): void
  /** Change overflow/anchor. Always its own history entry. */
  setOptions(
    lineId: string,
    patch: Partial<Pick<LineEdit, 'overflow' | 'anchor'>>,
    originalText: string
  ): void

  resetLine(lineId: string): void
  resetAll(): void
  undo(): void
  redo(): void
}

export function useEditorState(): EditorState {
  const [history, setHistory] = useState<History>(INITIAL)

  // The line currently absorbing keystrokes, and the timer that ends its run.
  const hotLineRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** End the current coalescing run: the next edit starts a new history entry. */
  const flush = useCallback(() => {
    clearTimer()
    hotLineRef.current = null
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  /**
   * Apply `produce` to the current map. `coalesceKey` non-null means "if this
   * key is still hot, replace the present instead of pushing history".
   */
  const commit = useCallback(
    (produce: (current: EditMap) => EditMap, coalesceKey: string | null) => {
      const coalesce = coalesceKey !== null && hotLineRef.current === coalesceKey
      setHistory((h) => {
        const next = produce(h.present)
        if (next === h.present) return h
        if (coalesce && h.past.length > 0) {
          // Same run: swap the present, leave `past` alone.
          return { past: h.past, present: next, future: [] }
        }
        return { past: pushPast(h.past, h.present), present: next, future: [] }
      })

      if (coalesceKey === null) {
        flush()
      } else {
        hotLineRef.current = coalesceKey
        clearTimer()
        timerRef.current = setTimeout(flush, COALESCE_MS)
      }
    },
    [clearTimer, flush]
  )

  const setText = useCallback(
    (lineId: string, text: string, originalText: string) => {
      commit((current) => {
        const existing = current.get(lineId)
        if (existing && existing.text === text) return current
        const next: LineEdit = {
          lineId,
          text,
          overflow: existing?.overflow ?? DEFAULT_OVERFLOW,
          anchor: existing?.anchor ?? DEFAULT_ANCHOR,
        }
        const map = new Map(current)
        if (isRedundant(next, originalText)) {
          if (!map.has(lineId)) return current
          map.delete(lineId)
        } else {
          map.set(lineId, next)
        }
        return map
      }, lineId)
    },
    [commit]
  )

  const setOptions = useCallback(
    (
      lineId: string,
      patch: Partial<Pick<LineEdit, 'overflow' | 'anchor'>>,
      originalText: string
    ) => {
      commit((current) => {
        const existing = current.get(lineId)
        const next: LineEdit = {
          lineId,
          text: existing?.text ?? originalText,
          overflow: patch.overflow ?? existing?.overflow ?? DEFAULT_OVERFLOW,
          anchor: patch.anchor ?? existing?.anchor ?? DEFAULT_ANCHOR,
        }
        if (
          existing &&
          existing.overflow === next.overflow &&
          existing.anchor === next.anchor
        ) {
          return current
        }
        const map = new Map(current)
        if (isRedundant(next, originalText)) {
          if (!map.has(lineId)) return current
          map.delete(lineId)
        } else {
          map.set(lineId, next)
        }
        return map
      }, null)
    },
    [commit]
  )

  const resetLine = useCallback(
    (lineId: string) => {
      commit((current) => {
        if (!current.has(lineId)) return current
        const map = new Map(current)
        map.delete(lineId)
        return map
      }, null)
    },
    [commit]
  )

  const resetAll = useCallback(() => {
    commit((current) => (current.size === 0 ? current : EMPTY), null)
  }, [commit])

  const undo = useCallback(() => {
    flush()
    setHistory((h) => {
      const prev = h.past[h.past.length - 1]
      if (prev === undefined) return h
      return {
        past: h.past.slice(0, -1),
        present: prev,
        future: [h.present, ...h.future],
      }
    })
  }, [flush])

  const redo = useCallback(() => {
    flush()
    setHistory((h) => {
      const next = h.future[0]
      if (next === undefined) return h
      return {
        past: pushPast(h.past, h.present),
        present: next,
        future: h.future.slice(1),
      }
    })
  }, [flush])

  const { present, past, future } = history

  const getEdit = useCallback((lineId: string) => present.get(lineId), [present])

  const isDirty = useCallback(
    (lineId: string, originalText: string) => {
      const edit = present.get(lineId)
      return edit !== undefined && edit.text !== originalText
    },
    [present]
  )

  // Redundant entries are pruned on write, so the map's size is the number of
  // lines carrying a pending edit.
  const dirtyCount = useMemo(() => present.size, [present])

  return {
    edits: present,
    dirtyCount,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    getEdit,
    isDirty,
    setText,
    setOptions,
    resetLine,
    resetAll,
    undo,
    redo,
  }
}
