/**
 * @vitest-environment jsdom
 *
 * Mount the real app against a stub engine and drive it the way a person would:
 * pick a file, click a line, type, download.
 *
 * The core tests prove the PDF maths. This proves the thing actually runs —
 * that lines reach the screen, that a click lands on an editable box, that
 * typing reaches the edit map, and that Download hands the engine the text the
 * user typed. Those are exactly the failures a typecheck cannot see.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'
import type { EditorEngine, ExportResult, MeasureResult, RenderResult } from '../core/contract'
import type { EditableDocument, LineEdit, TextLine } from '../core/model'

const line = (over: Partial<TextLine> = {}): TextLine => ({
  id: 'l0',
  pageIndex: 0,
  runIds: ['p0r0'],
  text: 'Hello world',
  runTexts: ['Hello world'],
  bbox: { x: 72, y: 700, width: 120, height: 12 },
  origin: [72, 700],
  angle: 0,
  effectiveSize: 12,
  fontName: 'Helvetica',
  fontFamily: 'Helvetica',
  bold: false,
  italic: false,
  fill: { r: 0, g: 0, b: 0 },
  blockers: [],
  width: 120,
  ...over,
})

function makeDocument(lines: TextLine[]): EditableDocument {
  const byPage = new Map<number, TextLine[]>()
  for (const l of lines) {
    const list = byPage.get(l.pageIndex)
    if (list) list.push(l)
    else byPage.set(l.pageIndex, [l])
  }
  return {
    pages: [
      {
        index: 0,
        width: 612,
        height: 792,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        displayWidth: 612,
        displayHeight: 792,
      },
    ],
    runs: new Map(),
    lines,
    linesByPage: byPage,
    warnings: [],
    hasEditableText: lines.some((l) => l.blockers.length === 0),
    readOnly: !lines.some((l) => l.blockers.length === 0),
  }
}

class StubEngine implements EditorEngine {
  readonly fileName = 'sample.pdf'
  exported: ReadonlyMap<string, LineEdit> | null = null
  renderCount = 0

  constructor(readonly document: EditableDocument) {}

  async renderPage(): Promise<RenderResult> {
    this.renderCount += 1
    return { width: 612, height: 792, scale: 1 }
  }

  measureLine(lineId: string, text: string): MeasureResult {
    const target = this.document.lines.find((l) => l.id === lineId)
    const originalWidth = target?.width ?? 0
    // 10 CSS px per character is plenty to make overflow testable.
    const width = text.length * 10
    return { width, originalWidth, fits: width <= originalWidth, unmapped: [], needsFallback: false }
  }

  async export(edits: ReadonlyMap<string, LineEdit>): Promise<ExportResult> {
    this.exported = new Map(edits)
    return {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      stats: {
        linesChanged: edits.size,
        runsRewritten: edits.size,
        runsDeleted: 0,
        reusedOriginalFont: edits.size,
        usedFallbackFont: 0,
      },
      warnings: [],
    }
  }

  async renderEditedPage(): Promise<RenderResult> {
    this.renderCount += 1
    return { width: 612, height: 792, scale: 1 }
  }

  destroy(): void {}
}

async function open(lines: TextLine[]): Promise<StubEngine> {
  const engine = new StubEngine(makeDocument(lines))
  render(<App loadEngine={async () => engine} />)
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input, 'the dropzone must expose a file input').toBeTruthy()
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'sample.pdf', {
    type: 'application/pdf',
  })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    fireEvent.change(input)
  })
  await waitFor(() => expect(screen.getByText('Hello world')).toBeTruthy())
  return engine
}

/** Type into a contentEditable the way the browser would. */
async function type(el: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    el.textContent = text
    fireEvent.input(el, { target: el })
  })
}

const boxFor = (text: string): HTMLElement => {
  const el = screen.getByText(text)
  expect(el.getAttribute('contenteditable')).toBe('true')
  return el
}

beforeEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the app runs', () => {
  it('shows the dropzone before a file is opened', () => {
    render(<App loadEngine={async () => new StubEngine(makeDocument([line()]))} />)
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('opens a file and renders its lines as editable boxes', async () => {
    await open([line(), line({ id: 'l1', text: 'Second line', runTexts: ['Second line'], origin: [72, 680] })])
    expect(boxFor('Hello world')).toBeTruthy()
    expect(boxFor('Second line')).toBeTruthy()
  })

  it('does not paint the overlay text over the canvas glyphs', async () => {
    // The canvas already shows the real text. A visible DOM copy on top of it
    // double-strikes every line, which is what made pages look smeared.
    await open([line()])
    const box = boxFor('Hello world')
    expect(box.style.color).toBe('transparent')
  })

  it('reveals the overlay text once the line has been edited', async () => {
    await open([line()])
    const box = boxFor('Hello world')
    await type(box, 'Edited text')
    expect(box.style.color).not.toBe('transparent')
  })
})

describe('editing', () => {
  it('records what the user types and hands it to export', async () => {
    const engine = await open([line()])
    await type(boxFor('Hello world'), 'Goodbye world')

    const download = screen.getByRole('button', { name: /download/i })
    await act(async () => {
      fireEvent.click(download)
    })

    await waitFor(() => expect(engine.exported).not.toBeNull())
    const edits = engine.exported!
    expect(edits.size).toBe(1)
    const edit = edits.get('l0')!
    expect(edit.text).toBe('Goodbye world')
    // Every LineEdit must be complete before it reaches the engine.
    expect(edit.overflow).toBeDefined()
    expect(edit.anchor).toBeDefined()
  })

  it('exports nothing when the text was not actually changed', async () => {
    const engine = await open([line()])
    await type(boxFor('Hello world'), 'Hello world')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download/i }))
    })
    await waitFor(() => expect(engine.exported).not.toBeNull())
    expect(engine.exported!.size).toBe(0)
  })

  it('flattens newlines pasted into a single-line field', async () => {
    const engine = await open([line()])
    await type(boxFor('Hello world'), 'one\ntwo')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download/i }))
    })
    await waitFor(() => expect(engine.exported).not.toBeNull())
    expect(engine.exported!.get('l0')!.text).toBe('one two')
  })

  it('undoes and redoes an edit', async () => {
    await open([line()])
    const box = boxFor('Hello world')
    await type(box, 'Changed')

    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true })
    })
    await waitFor(() => expect(box.textContent).toBe('Hello world'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true })
    })
    await waitFor(() => expect(box.textContent).toBe('Changed'))
  })

  it('keeps edits to different lines independent', async () => {
    const engine = await open([
      line(),
      line({ id: 'l1', text: 'Second line', runTexts: ['Second line'], origin: [72, 680] }),
    ])
    await type(boxFor('Hello world'), 'First edited')
    await type(boxFor('Second line'), 'Second edited')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download/i }))
    })
    await waitFor(() => expect(engine.exported).not.toBeNull())
    expect(engine.exported!.get('l0')!.text).toBe('First edited')
    expect(engine.exported!.get('l1')!.text).toBe('Second edited')
  })
})

describe('lines that cannot be edited', () => {
  it('refuses to make a blocked line editable, and says why', async () => {
    await open([line({ blockers: ['invisible'] })])
    const el = screen.getByText('Hello world')
    expect(el.getAttribute('contenteditable')).toBe('false')
    const label = el.getAttribute('aria-label') ?? ''
    expect(label.toLowerCase()).toContain('not editable')
  })

  it('reports a document with no editable text instead of showing an empty page', async () => {
    const engine = new StubEngine(makeDocument([line({ blockers: ['no-unicode'] })]))
    render(<App loadEngine={async () => engine} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([0x25])], 'x.pdf', { type: 'application/pdf' })],
      configurable: true,
    })
    await act(async () => {
      fireEvent.change(input)
    })
    await waitFor(() => expect(screen.getByText('Hello world')).toBeTruthy())
    expect(screen.getByText('Hello world').getAttribute('contenteditable')).toBe('false')
  })
})

describe('failure handling', () => {
  it('shows an error instead of a blank page when the file will not open', async () => {
    render(
      <App
        loadEngine={async () => {
          throw new Error('This PDF is password-protected')
        }}
      />
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([0x25])], 'x.pdf', { type: 'application/pdf' })],
      configurable: true,
    })
    await act(async () => {
      fireEvent.change(input)
    })
    await waitFor(() => {
      expect(within(document.body).getByText(/password-protected/i)).toBeTruthy()
    })
  })
})
