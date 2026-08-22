/**
 * Top-level application.
 *
 * `App` owns the document lifecycle — idle, loading, error, ready — and
 * nothing else. `Editor` owns everything about a *loaded* document, and is
 * mounted with a key derived from the load, so opening a second file starts
 * from a genuinely clean state (edit map, history, selection, zoom) rather
 * than from whatever was left over.
 *
 * The engine arrives as a prop. The UI never imports a concrete engine, only
 * the `EditorEngine` type, which is what lets this whole layer be built and
 * type-checked against the contract alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditorEngine, ExportResult } from '../core/contract'
import type { TextLine } from '../core/model'
import Dropzone from './Dropzone'
import Inspector from './Inspector'
import PageView, { messageOf } from './PageView'
import Toolbar from './Toolbar'
import WarningsBar from './WarningsBar'
import type { EngineFactory } from './engineLoader'
import { useEditorState } from './useEditorState'
import { computeScale, type ZoomSetting } from './zoom'

export interface AppProps {
  /** Supplied by `main.tsx`; see `engineLoader.ts` for why it is a prop. */
  loadEngine: EngineFactory
}

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export default function App({ loadEngine }: AppProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [engine, setEngine] = useState<EditorEngine | null>(null)
  const [documentKey, setDocumentKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Held in a ref as well as state so cleanup can destroy the *current* engine
  // without re-running on every unrelated render.
  const engineRef = useRef<EditorEngine | null>(null)
  engineRef.current = engine

  useEffect(() => {
    return () => {
      engineRef.current?.destroy()
    }
  }, [])

  const handleFile = useCallback(
    async (file: File) => {
      setPhase('loading')
      setError(null)
      try {
        const next = await loadEngine(file)
        engineRef.current?.destroy()
        setEngine(next)
        setDocumentKey((k) => k + 1)
        setPhase('ready')
      } catch (err) {
        setError(messageOf(err))
        setPhase('error')
      }
    },
    [loadEngine]
  )

  const handleClose = useCallback(() => {
    engineRef.current?.destroy()
    engineRef.current = null
    setEngine(null)
    setError(null)
    setPhase('idle')
  }, [])

  if (phase === 'ready' && engine) {
    return <Editor key={documentKey} engine={engine} onClose={handleClose} />
  }

  return (
    <Dropzone
      onFile={(file) => void handleFile(file)}
      loading={phase === 'loading'}
      loadingLabel="Reading the content streams…"
      error={error}
      onDismissError={() => {
        setError(null)
        setPhase('idle')
      }}
    />
  )
}

/* -------------------------------------------------------------------------- */

interface EditorProps {
  engine: EditorEngine
  onClose: () => void
}

/** How far outside the viewport a page still counts as worth painting. */
const NEAR_MARGIN = '1200px 0px'

function Editor({ engine, onClose }: EditorProps) {
  const doc = engine.document
  const state = useEditorState()

  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [zoom, setZoom] = useState<ZoomSetting>({ kind: 'fit-width' })
  const [preview, setPreview] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const [nearPages, setNearPages] = useState<ReadonlySet<number>>(() => new Set([0]))
  const [uncoverable, setUncoverable] = useState<ReadonlyMap<number, ReadonlySet<string>>>(
    () => new Map()
  )
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)

  /* ---- scale ------------------------------------------------------------ */

  const [viewport, setViewport] = useState(() => ({
    // A sane first guess so the first paint is not at the wrong zoom.
    width: Math.max(320, window.innerWidth - 340),
    height: Math.max(240, window.innerHeight - 64),
  }))

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setViewport({ width: rect.width, height: rect.height })
    })
    observer.observe(el)
    setViewport({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const scale = useMemo(
    () => computeScale(zoom, doc.pages, viewport),
    [zoom, doc.pages, viewport]
  )

  /* ---- page registry + observers ---------------------------------------- */

  const pageEls = useRef(new Map<number, HTMLElement>())
  const nearObserver = useRef<IntersectionObserver | null>(null)
  const activeObserver = useRef<IntersectionObserver | null>(null)
  const ratios = useRef(new Map<number, number>())

  const registerPage = useCallback((index: number, el: HTMLElement | null) => {
    const previous = pageEls.current.get(index)
    if (previous && previous !== el) {
      nearObserver.current?.unobserve(previous)
      activeObserver.current?.unobserve(previous)
    }
    if (el) {
      pageEls.current.set(index, el)
      nearObserver.current?.observe(el)
      activeObserver.current?.observe(el)
    } else {
      pageEls.current.delete(index)
      ratios.current.delete(index)
    }
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    // Virtualisation: which pages are close enough to be worth rendering.
    const near = new IntersectionObserver(
      (entries) => {
        setNearPages((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const index = indexOf(entry.target)
            if (index === null) continue
            if (entry.isIntersecting) {
              if (!next.has(index)) {
                next.add(index)
                changed = true
              }
            } else if (next.delete(index)) {
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root, rootMargin: NEAR_MARGIN }
    )

    // Page indicator: whichever page currently shows the most of itself.
    const active = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexOf(entry.target)
          if (index === null) continue
          ratios.current.set(index, entry.intersectionRatio)
        }
        let best = -1
        let bestRatio = 0
        for (const [index, ratio] of ratios.current) {
          if (ratio > bestRatio + 1e-6 || (Math.abs(ratio - bestRatio) < 1e-6 && index < best)) {
            best = index
            bestRatio = ratio
          }
        }
        if (best >= 0) setCurrentPage(best)
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.95, 1] }
    )

    nearObserver.current = near
    activeObserver.current = active
    for (const el of pageEls.current.values()) {
      near.observe(el)
      active.observe(el)
    }

    return () => {
      near.disconnect()
      active.disconnect()
      nearObserver.current = null
      activeObserver.current = null
    }
  }, [])

  const goToPage = useCallback(
    (index: number) => {
      const clamped = Math.min(doc.pages.length - 1, Math.max(0, index))
      const el = pageEls.current.get(clamped)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      setCurrentPage(clamped)
    },
    [doc.pages.length]
  )

  /* ---- selection -------------------------------------------------------- */

  const linesById = useMemo(() => {
    const map = new Map<string, TextLine>()
    for (const line of doc.lines) map.set(line.id, line)
    return map
  }, [doc.lines])

  const selectedLine = selectedLineId ? linesById.get(selectedLineId) ?? null : null

  const handleSelect = useCallback((lineId: string | null) => {
    setSelectedLineId(lineId)
    if (lineId) setInspectorOpen(true)
  }, [])

  const handleUncoverable = useCallback((pageIndex: number, lineIds: readonly string[]) => {
    setUncoverable((prev) => {
      const existing = prev.get(pageIndex)
      const same =
        existing !== undefined &&
        existing.size === lineIds.length &&
        lineIds.every((id) => existing.has(id))
      if (same) return prev
      const next = new Map(prev)
      if (lineIds.length === 0) next.delete(pageIndex)
      else next.set(pageIndex, new Set(lineIds))
      return next
    })
  }, [])

  const selectedUncoverable =
    selectedLine !== null &&
    (uncoverable.get(selectedLine.pageIndex)?.has(selectedLine.id) ?? false)

  /* ---- read-only / empty ------------------------------------------------- */

  // The engine reports this directly; there is nothing to infer.
  const readOnly = doc.readOnly

  /* ---- keyboard --------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        // Always ours, even inside a contentEditable: the browser's native
        // field-level undo would silently desync from our edit map.
        event.preventDefault()
        if (event.shiftKey) state.redo()
        else state.undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        state.redo()
        return
      }
      if (event.key === 'Escape') {
        const target = event.target
        if (target instanceof HTMLElement && target.isContentEditable) target.blur()
        setSelectedLineId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state])

  /* ---- export ----------------------------------------------------------- */

  const handleDownload = useCallback(async () => {
    setExporting(true)
    setExportError(null)
    try {
      const exported = await engine.export(state.edits)
      const blob = new Blob([toArrayBuffer(exported.bytes)], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${stemOf(engine.fileName)}-edited.pdf`
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Firefox aborts the download if the URL dies in the same tick.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setResult(exported)
    } catch (err) {
      setExportError(messageOf(err))
    } finally {
      setExporting(false)
    }
  }, [engine, state.edits])

  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), 14_000)
    return () => clearTimeout(timer)
  }, [result])

  /* ---- render ----------------------------------------------------------- */

  return (
    <div className="app">
      <Toolbar
        fileName={engine.fileName}
        pageCount={doc.pages.length}
        currentPage={currentPage}
        onGoToPage={goToPage}
        zoom={zoom}
        scale={scale}
        onZoom={setZoom}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={state.undo}
        onRedo={state.redo}
        dirtyCount={state.dirtyCount}
        onResetAll={state.resetAll}
        preview={preview}
        onPreviewChange={setPreview}
        exporting={exporting}
        onDownload={() => void handleDownload()}
        onCloseDocument={onClose}
        readOnly={readOnly}
      />

      <WarningsBar warnings={doc.warnings} onGoToPage={goToPage} />

      <div className="workspace">
        <div
          className="scroller"
          ref={scrollRef}
          onMouseDown={(event) => {
            // A click anywhere that is not an editable line clears the
            // selection. The line's own handler runs first (target phase), so
            // the `closest` guard is what stops this from undoing it.
            const target = event.target
            if (target instanceof Element && !target.closest('.lineText')) {
              setSelectedLineId(null)
            }
          }}
        >
          {!doc.hasEditableText ? (
            <div className="banner banner--empty" role="status">
              <strong>No editable text in this PDF.</strong>
              <span>
                Every page is images or vector outlines — most likely a scan. There is
                nothing for the editor to change, but you can still read it here.
              </span>
            </div>
          ) : null}

          {readOnly ? (
            <div className="banner banner--warn" role="status">
              <strong>Read-only document.</strong>
              <span>
                The engine reported an error that prevents writing this file. You can
                browse and inspect it, but edits cannot be exported.
              </span>
            </div>
          ) : null}

          <div className="pages">
            {doc.pages.map((page) => (
              <PageView
                key={page.index}
                engine={engine}
                page={page}
                lines={doc.linesByPage.get(page.index) ?? EMPTY_LINES}
                scale={scale}
                state={state}
                selectedLineId={selectedLineId}
                onSelect={handleSelect}
                preview={preview}
                readOnly={readOnly}
                near={nearPages.has(page.index)}
                onUncoverable={handleUncoverable}
                registerPage={registerPage}
              />
            ))}
          </div>
        </div>

        <Inspector
          engine={engine}
          line={selectedLine}
          state={state}
          uncoverable={selectedUncoverable}
          preview={preview}
          onPreviewChange={setPreview}
          readOnly={readOnly}
          open={inspectorOpen}
          onOpenChange={setInspectorOpen}
        />
      </div>

      {result ? (
        <ExportToast result={result} onDismiss={() => setResult(null)} />
      ) : null}

      {exportError ? (
        <div className="toast toast--error" role="alert">
          <div className="toast-head">
            <strong>Export failed</strong>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setExportError(null)}
            >
              Dismiss
            </button>
          </div>
          <p>{exportError}</p>
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_LINES: readonly TextLine[] = []

function ExportToast({
  result,
  onDismiss,
}: {
  result: ExportResult
  onDismiss: () => void
}) {
  const { stats } = result
  return (
    <div className="toast" role="status">
      <div className="toast-head">
        <strong>Downloaded</strong>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <dl className="toast-stats">
        <Stat label="Lines changed" value={stats.linesChanged} />
        <Stat label="Runs rewritten" value={stats.runsRewritten} />
        <Stat label="Runs deleted" value={stats.runsDeleted} />
        <Stat label="Original font reused" value={stats.reusedOriginalFont} />
        <Stat label="Fallback font used" value={stats.usedFallbackFont} />
      </dl>
      {result.warnings.length > 0 ? (
        <ul className="toast-warnings">
          {result.warnings.slice(0, 4).map((w, i) => (
            <li key={`${w.code}-${i}`}>
              <span className={`dot dot--${w.level}`} aria-hidden="true" />
              {w.message}
            </li>
          ))}
          {result.warnings.length > 4 ? (
            <li className="muted">+{result.warnings.length - 4} more</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="toast-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function indexOf(element: Element): number | null {
  const raw = element.getAttribute('data-page')
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function stemOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '')
  return base.replace(/\.pdf$/i, '') || 'document'
}

/**
 * `Blob` wants a `BufferSource`; hand it a plain `ArrayBuffer` sliced to the
 * view's own bounds so a Uint8Array over a larger buffer cannot leak the rest
 * of that buffer into the download.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}
