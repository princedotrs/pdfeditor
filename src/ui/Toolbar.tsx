/**
 * The application bar: document identity on the left, view controls in the
 * middle, destructive/terminal actions on the right.
 */
import { useEffect, useRef, useState } from 'react'
import { ZOOM_LEVELS, type ZoomSetting } from './zoom'

export interface ToolbarProps {
  fileName: string
  pageCount: number
  /** 0-based. */
  currentPage: number
  onGoToPage: (index: number) => void

  zoom: ZoomSetting
  scale: number
  onZoom: (zoom: ZoomSetting) => void

  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void

  dirtyCount: number
  onResetAll: () => void

  preview: boolean
  onPreviewChange: (on: boolean) => void

  exporting: boolean
  onDownload: () => void

  onCloseDocument: () => void
  readOnly: boolean
}

export default function Toolbar({
  fileName,
  pageCount,
  currentPage,
  onGoToPage,
  zoom,
  scale,
  onZoom,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  dirtyCount,
  onResetAll,
  preview,
  onPreviewChange,
  exporting,
  onDownload,
  onCloseDocument,
  readOnly,
}: ToolbarProps) {
  const [pageDraft, setPageDraft] = useState(String(currentPage + 1))
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the scroll position unless the user is mid-edit in the field.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setPageDraft(String(currentPage + 1))
    }
  }, [currentPage])

  const commitPage = () => {
    const parsed = Number.parseInt(pageDraft, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= pageCount) {
      onGoToPage(parsed - 1)
    } else {
      setPageDraft(String(currentPage + 1))
    }
  }

  return (
    <header className="toolbar">
      <div className="toolbar-group toolbar-group--file">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onCloseDocument}
          aria-label="Close document and open another"
          title="Close document"
        >
          <IconBack />
        </button>
        <div className="file-id">
          <span className="file-name" title={fileName}>
            {fileName}
          </span>
          <span className="file-meta">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'}
            {readOnly ? ' · read-only' : null}
            {dirtyCount > 0 ? ` · ${dirtyCount} edited` : null}
          </span>
        </div>
      </div>

      <div className="toolbar-group toolbar-group--nav">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => onGoToPage(currentPage - 1)}
          disabled={currentPage <= 0}
          aria-label="Previous page"
          title="Previous page"
        >
          <IconChevron dir="up" />
        </button>
        <div className="page-field">
          <label className="sr-only" htmlFor="page-number">
            Page number
          </label>
          <input
            id="page-number"
            ref={inputRef}
            className="page-input"
            inputMode="numeric"
            value={pageDraft}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') {
                setPageDraft(String(currentPage + 1))
                e.currentTarget.blur()
              }
            }}
          />
          <span className="page-total">/ {pageCount}</span>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => onGoToPage(currentPage + 1)}
          disabled={currentPage >= pageCount - 1}
          aria-label="Next page"
          title="Next page"
        >
          <IconChevron dir="down" />
        </button>

        <span className="divider" aria-hidden="true" />

        <label className="sr-only" htmlFor="zoom-select">
          Zoom
        </label>
        <select
          id="zoom-select"
          className="select"
          value={zoom.kind === 'level' ? String(zoom.level) : zoom.kind}
          onChange={(e) => {
            const value = e.target.value
            if (value === 'fit-width' || value === 'fit-page') {
              onZoom({ kind: value })
            } else {
              onZoom({ kind: 'level', level: Number(value) })
            }
          }}
        >
          <option value="fit-width">Fit width</option>
          <option value="fit-page">Fit page</option>
          {ZOOM_LEVELS.map((level) => (
            <option key={level} value={String(level)}>
              {Math.round(level * 100)}%
            </option>
          ))}
        </select>
        <span className="zoom-readout" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
      </div>

      <div className="toolbar-group toolbar-group--actions">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (⌘Z)"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (⇧⌘Z)"
        >
          <IconUndo flipped />
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onResetAll}
          disabled={dirtyCount === 0}
          title="Discard every pending edit"
        >
          Reset all
        </button>

        <span className="divider" aria-hidden="true" />

        <label className="toggle" title="Re-render the page through the export pipeline">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => onPreviewChange(e.target.checked)}
          />
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">Rendered preview</span>
        </label>

        <button
          type="button"
          className="btn btn--primary"
          onClick={onDownload}
          disabled={exporting || readOnly}
          title={readOnly ? 'This document cannot be written' : undefined}
        >
          {exporting ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
    </header>
  )
}

function IconChevron({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d={dir === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconBack() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M10 3L5 8l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconUndo({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      style={flipped ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path
        d="M6.5 4.5L3.5 7.5l3 3M3.5 7.5h6a3 3 0 010 6H8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
