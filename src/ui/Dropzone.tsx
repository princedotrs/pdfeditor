/**
 * The landing state: drag and drop, a file picker, or paste.
 *
 * Paste is a window-level listener rather than something focused, because
 * there is nothing else on this screen to paste into and a user who has just
 * copied a PDF in Finder expects Cmd-V to work.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface DropzoneProps {
  onFile: (file: File) => void
  loading: boolean
  loadingLabel: string
  error: string | null
  onDismissError: () => void
}

const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf'])

function looksLikePdf(file: File): boolean {
  return PDF_TYPES.has(file.type) || /\.pdf$/i.test(file.name)
}

export default function Dropzone({
  onFile,
  loading,
  loadingLabel,
  error,
  onDismissError,
}: DropzoneProps) {
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Drag events fire for every child element; count enter/leave to avoid flicker.
  const depthRef = useRef(0)

  const accept = useCallback(
    (files: FileList | null | undefined) => {
      const file = files?.[0]
      if (!file) return
      if (!looksLikePdf(file)) {
        setRejected(`“${file.name}” is not a PDF.`)
        return
      }
      setRejected(null)
      onFile(file)
    },
    [onFile]
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (loading) return
      const items = event.clipboardData?.files
      if (items && items.length > 0) {
        event.preventDefault()
        accept(items)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept, loading])

  // Suppress the browser's own "open this file" behaviour outside the target.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const message = error ?? rejected

  return (
    <main className="landing">
      <div
        className={'dropzone' + (dragging ? ' is-dragging' : '') + (loading ? ' is-loading' : '')}
        onDragEnter={(e) => {
          e.preventDefault()
          depthRef.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          depthRef.current -= 1
          if (depthRef.current <= 0) {
            depthRef.current = 0
            setDragging(false)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          depthRef.current = 0
          setDragging(false)
          if (!loading) accept(e.dataTransfer.files)
        }}
      >
        <div className="dropzone-inner">
          <IconDocument />
          <h1>Edit the text in a PDF</h1>
          <p className="lede">
            Every line of real text becomes an editable field, in place, with the
            original font and position. Download a genuine PDF when you are done.
          </p>

          {loading ? (
            <div className="loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{loadingLabel}</span>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={() => inputRef.current?.click()}
              >
                Choose a PDF
              </button>
              <p className="muted">or drop one here, or paste with ⌘V</p>
            </>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              accept(e.target.files)
              // Allow re-picking the same file after a failure.
              e.target.value = ''
            }}
          />
        </div>

        {message ? (
          <div className="dropzone-error" role="alert">
            <span>{message}</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setRejected(null)
                onDismissError()
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>

      <ul className="landing-notes">
        <li>Text is edited in the original content stream — nothing is rasterised.</li>
        <li>Scanned pages have no text to edit; you will be told if that is the case.</li>
        <li>Files never leave your browser.</li>
      </ul>
    </main>
  )
}

function IconDocument() {
  return (
    <svg
      className="dropzone-icon"
      viewBox="0 0 48 48"
      width="48"
      height="48"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M13 5h15l8 8v30a2 2 0 01-2 2H13a2 2 0 01-2-2V7a2 2 0 012-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M28 5v8h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path
        d="M17 24h14M17 30h14M17 36h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
