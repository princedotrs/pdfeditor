/**
 * Document-level warnings from the engine.
 *
 * Collapsed to a single summary line by default: these matter, but they are
 * about the file rather than about what the user is doing right now, so they
 * should not sit between them and the page.
 */
import { useMemo, useState } from 'react'
import type { DocumentWarning } from '../core/model'

export interface WarningsBarProps {
  warnings: readonly DocumentWarning[]
  onGoToPage: (index: number) => void
}

const LEVEL_ORDER: Record<DocumentWarning['level'], number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export default function WarningsBar({ warnings, onGoToPage }: WarningsBarProps) {
  const [open, setOpen] = useState(false)

  const sorted = useMemo(
    () => [...warnings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
    [warnings]
  )

  const counts = useMemo(() => {
    let errors = 0
    let warns = 0
    let infos = 0
    for (const w of warnings) {
      if (w.level === 'error') errors += 1
      else if (w.level === 'warn') warns += 1
      else infos += 1
    }
    return { errors, warns, infos }
  }, [warnings])

  if (warnings.length === 0) return null

  const worst: DocumentWarning['level'] =
    counts.errors > 0 ? 'error' : counts.warns > 0 ? 'warn' : 'info'

  return (
    <div className={`warnings warnings--${worst}`}>
      <button
        type="button"
        className="warnings-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="warnings-list"
      >
        <LevelDot level={worst} />
        <span className="warnings-text">
          {summarize(counts)}
        </span>
        <span className={'warnings-caret' + (open ? ' is-open' : '')} aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <ul className="warnings-list" id="warnings-list">
          {sorted.map((warning, i) => {
            const pageIndex = warning.pageIndex
            return (
              <li key={`${warning.code}-${pageIndex ?? 'doc'}-${i}`} className="warning">
                <LevelDot level={warning.level} />
                <span className="warning-body">
                  <span className="warning-message">{warning.message}</span>
                  <span className="warning-code">{warning.code}</span>
                </span>
                {pageIndex !== undefined ? (
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => onGoToPage(pageIndex)}
                  >
                    Page {pageIndex + 1}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function summarize(counts: { errors: number; warns: number; infos: number }): string {
  const parts: string[] = []
  if (counts.errors > 0) parts.push(`${counts.errors} ${plural(counts.errors, 'error')}`)
  if (counts.warns > 0) parts.push(`${counts.warns} ${plural(counts.warns, 'warning')}`)
  if (counts.infos > 0) parts.push(`${counts.infos} note${counts.infos === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function LevelDot({ level }: { level: DocumentWarning['level'] }) {
  return <span className={`dot dot--${level}`} aria-hidden="true" />
}
