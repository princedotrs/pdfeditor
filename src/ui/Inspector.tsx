/**
 * The right-hand panel: everything true about the selected line, and the two
 * decisions the user can make about it that are not the text itself — how to
 * handle a line that no longer fits, and what stays put when its width changes.
 *
 * Below 900px this becomes a bottom sheet; see `styles.css`.
 */
import { useMemo, type ReactNode } from 'react'
import type { EditorEngine, MeasureResult } from '../core/contract'
import type { OverflowMode, TextLine } from '../core/model'
import { BLOCKER_LABELS, fillToCss } from './fonts'
import type { EditorState } from './useEditorState'

export interface InspectorProps {
  engine: EditorEngine
  line: TextLine | null
  state: EditorState
  /** Selected line's background was too busy to cover with a flat rectangle. */
  uncoverable: boolean
  preview: boolean
  onPreviewChange: (on: boolean) => void
  readOnly: boolean
  /** Mobile bottom-sheet open state. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

const OVERFLOW_OPTIONS: ReadonlyArray<{
  value: OverflowMode
  label: string
  hint: string
}> = [
  {
    value: 'overflow',
    label: 'Overflow',
    hint: 'Keep the type size and let the line run past its original width.',
  },
  {
    value: 'shrink',
    label: 'Shrink',
    hint: 'Reduce the font size until the line fits its original width.',
  },
  {
    value: 'condense',
    label: 'Condense',
    hint: 'Keep the size and tighten horizontal scaling until the line fits.',
  },
]

const ANCHOR_OPTIONS: ReadonlyArray<{ value: 'left' | 'center' | 'right'; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
]

export default function Inspector({
  engine,
  line,
  state,
  uncoverable,
  preview,
  onPreviewChange,
  readOnly,
  open,
  onOpenChange,
}: InspectorProps) {
  const edit = line ? state.getEdit(line.id) : undefined
  const text = edit?.text ?? line?.text ?? ''
  const dirty = line ? text !== line.text : false

  const measure: MeasureResult | null = useMemo(() => {
    if (!line || !dirty) return null
    try {
      return engine.measureLine(line.id, text)
    } catch {
      return null
    }
  }, [engine, line, text, dirty])

  const blocked = line ? line.blockers.length > 0 : false

  return (
    <aside
      className={'inspector' + (open ? ' is-open' : '')}
      aria-label="Line inspector"
    >
      <button
        type="button"
        className="sheet-handle"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <span className="sheet-grip" aria-hidden="true" />
        <span className="sr-only">{open ? 'Collapse inspector' : 'Expand inspector'}</span>
      </button>

      <div className="inspector-body">
        {!line ? (
          <div className="empty">
            <h2>Nothing selected</h2>
            <p>
              Click any line of text on the page to edit it in place. The panel will
              show its font, its size, and what happens to it on export.
            </p>
          </div>
        ) : (
          <>
            <header className="inspector-head">
              <h2>Line</h2>
              <span className={'pill' + (dirty ? ' pill--accent' : '')}>
                {blocked ? 'Locked' : dirty ? 'Edited' : 'Unchanged'}
              </span>
            </header>

            <p className="line-preview" title={line.text}>
              {line.text || <em>(empty)</em>}
            </p>

            {blocked ? (
              <div className="note note--warn" role="note">
                <strong>This line can’t be edited.</strong>
                <ul>
                  {line.blockers.map((b) => (
                    <li key={b}>{BLOCKER_LABELS[b] ?? b}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {readOnly && !blocked ? (
              <div className="note note--warn" role="note">
                <strong>Read-only.</strong> This document loaded, but the engine
                reported that it cannot be modified.
              </div>
            ) : null}

            <dl className="facts">
              <Fact label="Page" value={String(line.pageIndex + 1)} />
              <Fact label="Font" value={line.fontFamily || line.fontName} />
              <Fact
                label="Style"
                value={
                  [line.bold ? 'Bold' : null, line.italic ? 'Italic' : null]
                    .filter(Boolean)
                    .join(' ') || 'Regular'
                }
              />
              <Fact label="Size" value={`${round(line.effectiveSize, 2)} pt`} />
              <Fact
                label="Colour"
                value={
                  <span className="swatch-row">
                    <span
                      className="swatch"
                      style={{ background: fillToCss(line.fill) }}
                      aria-hidden="true"
                    />
                    {fillToCss(line.fill)}
                  </span>
                }
              />
              {Math.abs(line.angle) > 1e-6 ? (
                <Fact
                  label="Rotation"
                  value={`${round((line.angle * 180) / Math.PI, 1)}°`}
                />
              ) : null}
              <Fact label="Width" value={`${round(line.width, 1)} pt`} />
              <Fact label="Runs" value={String(line.runIds.length)} />
            </dl>

            {measure ? (
              <section className="section">
                <h3>Fit</h3>
                <FitBar measure={measure} />
                {!measure.fits ? (
                  <div className="chip chip--warn">
                    Too wide by {round(measure.width - measure.originalWidth, 1)} pt
                  </div>
                ) : (
                  <div className="chip chip--ok">
                    Fits with {round(measure.originalWidth - measure.width, 1)} pt to spare
                  </div>
                )}
                {measure.unmapped.length > 0 ? (
                  <div className="chip chip--warn chip--block">
                    Original font can’t render{' '}
                    {measure.unmapped.slice(0, 6).map((c) => (
                      <code key={c}>{c}</code>
                    ))}
                    {measure.unmapped.length > 6 ? ` +${measure.unmapped.length - 6} more` : null}{' '}
                    — a fallback font will be embedded.
                  </div>
                ) : measure.needsFallback ? (
                  <div className="chip chip--warn chip--block">
                    A fallback font will be embedded for this line.
                  </div>
                ) : null}
              </section>
            ) : null}

            {uncoverable && dirty && !preview ? (
              <div className="note note--warn" role="note">
                <strong>Background is not flat</strong> — the original glyphs can’t be
                hidden behind a solid rectangle here.{' '}
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => onPreviewChange(true)}
                >
                  Use Rendered preview
                </button>{' '}
                to check this line.
              </div>
            ) : null}

            <section className="section">
              <h3>
                Overflow
                <span className="hint">when the new text is wider</span>
              </h3>
              <div className="radio-list" role="radiogroup" aria-label="Overflow handling">
                {OVERFLOW_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={
                      'radio' + ((edit?.overflow ?? 'overflow') === option.value ? ' is-on' : '')
                    }
                  >
                    <input
                      type="radio"
                      name="overflow"
                      value={option.value}
                      checked={(edit?.overflow ?? 'overflow') === option.value}
                      disabled={blocked || readOnly}
                      onChange={() =>
                        state.setOptions(line.id, { overflow: option.value }, line.text)
                      }
                    />
                    <span className="radio-text">
                      <span className="radio-label">{option.label}</span>
                      <span className="radio-hint">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>

            <section className="section">
              <h3>
                Anchor
                <span className="hint">what stays put</span>
              </h3>
              <div className="segmented" role="radiogroup" aria-label="Anchor">
                {ANCHOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={(edit?.anchor ?? 'left') === option.value}
                    className={
                      'segment' + ((edit?.anchor ?? 'left') === option.value ? ' is-on' : '')
                    }
                    disabled={blocked || readOnly}
                    onClick={() => state.setOptions(line.id, { anchor: option.value }, line.text)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <div className="inspector-actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!dirty}
                onClick={() => state.resetLine(line.id)}
              >
                Reset line
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--danger"
                disabled={state.dirtyCount === 0}
                onClick={state.resetAll}
              >
                Reset all
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** A width comparison bar: original advance vs. what the new text needs. */
function FitBar({ measure }: { measure: MeasureResult }) {
  const max = Math.max(measure.width, measure.originalWidth, 1)
  return (
    <div className="fitbar" aria-hidden="true">
      <div className="fitbar-row">
        <span className="fitbar-key">was</span>
        <span className="fitbar-track">
          <span
            className="fitbar-fill fitbar-fill--was"
            style={{ width: `${(measure.originalWidth / max) * 100}%` }}
          />
        </span>
        <span className="fitbar-num">{round(measure.originalWidth, 0)}</span>
      </div>
      <div className="fitbar-row">
        <span className="fitbar-key">now</span>
        <span className="fitbar-track">
          <span
            className={'fitbar-fill' + (measure.fits ? '' : ' fitbar-fill--over')}
            style={{ width: `${(measure.width / max) * 100}%` }}
          />
        </span>
        <span className="fitbar-num">{round(measure.width, 0)}</span>
      </div>
    </div>
  )
}

function round(value: number, digits: number): string {
  const factor = 10 ** digits
  return String(Math.round(value * factor) / factor)
}
