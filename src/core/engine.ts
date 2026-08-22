/**
 * The editor engine: the single object the UI talks to.
 *
 * Rendering is pdf.js (battle-tested, and the closest thing to "what a viewer
 * will show"). Everything semantic — finding text, measuring it, rewriting it —
 * is our own code over pdf-lib's object model, because pdf.js deliberately does
 * not expose a stable mapping from its text items back to content-stream
 * operators. See `interpreter.ts` for why that matters.
 */
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { EditorEngine, ExportResult, MeasureResult, RenderResult } from './contract'
import { PdfLoadError, loadPdf, type LoadedPdf } from './document'
import { distribute } from './distribute'
import { encodeWithFallback, exportEditedPdf } from './export'
import type { EditableDocument, LineEdit, TextLine, TextRun } from './model'

/** pdf.js needs one module worker for the whole app. */
let workerStarted = false
function startWorker(): void {
  if (workerStarted) return
  GlobalWorkerOptions.workerPort = new Worker(
    new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
    { type: 'module' }
  )
  workerStarted = true
}

const ASSET_BASE = `${import.meta.env.BASE_URL ?? '/'}pdfjs/`.replace(/\/{2,}/g, '/')

function openWithPdfJs(bytes: Uint8Array): PDFDocumentLoadingTask {
  startWorker()
  return getDocument({
    // pdf.js transfers the buffer to its worker, so hand it a copy — otherwise
    // the original bytes are detached and every later export fails.
    data: bytes.slice(),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    iccUrl: `${ASSET_BASE}iccs/`,
    wasmUrl: `${ASSET_BASE}wasm/`,
    useSystemFonts: false,
  })
}

interface RenderTarget {
  canvas: HTMLCanvasElement
  scale: number
}

async function renderInto(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  { canvas, scale }: RenderTarget,
  signal?: AbortSignal
): Promise<RenderResult> {
  const page = await pdf.getPage(pageIndex + 1)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3)
  const viewport = page.getViewport({ scale: scale * dpr })
  const cssViewport = page.getViewport({ scale })

  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  canvas.style.width = `${Math.floor(cssViewport.width)}px`
  canvas.style.height = `${Math.floor(cssViewport.height)}px`

  const task = page.render({ canvas, viewport })
  const onAbort = (): void => task.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await task.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
    page.cleanup()
  }

  return { width: cssViewport.width, height: cssViewport.height, scale }
}

export class PdfEditorEngine implements EditorEngine {
  private previewCache: { key: string; bytes: Uint8Array } | null = null
  private previewPdf: { key: string; task: PDFDocumentLoadingTask; pdf: PDFDocumentProxy } | null =
    null
  /**
   * Preview builds are serialised. Every visible page with edits asks for a
   * preview at once, and without this two overlapping calls each open their own
   * document and the second destroys the one the first is still rendering from.
   */
  private previewLock: Promise<void> = Promise.resolve()
  private destroyed = false

  private constructor(
    readonly fileName: string,
    private readonly originalBytes: Uint8Array,
    private readonly loaded: LoadedPdf,
    private readonly pdf: PDFDocumentProxy,
    private readonly task: PDFDocumentLoadingTask,
    private readonly lineIndex: Map<string, TextLine>
  ) {}

  static async open(source: File | Uint8Array, signal?: AbortSignal): Promise<PdfEditorEngine> {
    const fileName = source instanceof File ? source.name : 'document.pdf'
    const bytes =
      source instanceof File ? new Uint8Array(await source.arrayBuffer()) : source.slice()
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    // Parse with pdf-lib first: it is a stricter parser than the renderer, so a
    // file that would fail at save time should fail now rather than after the
    // user has spent ten minutes editing it.
    const loaded = await loadPdf(bytes)

    const task = openWithPdfJs(bytes)
    let pdf: PDFDocumentProxy
    try {
      pdf = await task.promise
    } catch (err) {
      await task.destroy().catch(() => {})
      throw new PdfLoadError(
        `This PDF could not be rendered: ${err instanceof Error ? err.message : 'unknown error'}`,
        'parse'
      )
    }

    const index = new Map<string, TextLine>()
    for (const line of loaded.model.lines) index.set(line.id, line)
    return new PdfEditorEngine(fileName, bytes, loaded, pdf, task, index)
  }

  get document(): EditableDocument {
    return this.loaded.model
  }

  async renderPage(
    pageIndex: number,
    scale: number,
    canvas: HTMLCanvasElement,
    signal?: AbortSignal
  ): Promise<RenderResult> {
    this.assertAlive()
    return renderInto(this.pdf, pageIndex, { canvas, scale }, signal)
  }

  measureLine(lineId: string, text: string): MeasureResult {
    const line = this.lineIndex.get(lineId)
    if (!line) {
      return { width: 0, originalWidth: 0, fits: true, unmapped: [], needsFallback: false }
    }
    const runs = line.runIds
      .map((id) => this.loaded.model.runs.get(id))
      .filter((r): r is TextRun => Boolean(r))

    const dist = distribute(line.runTexts, text)
    const unmapped = new Set<string>()
    let needsFallback = false
    let widthText = 0

    runs.forEach((run, i) => {
      const part = dist.texts[i] ?? ''
      if (!part) return
      const font = this.loaded.fonts.get(run.fontKey)
      const encoded = font?.canReuse ? font.encode(part, run.glyphs) : null
      if (encoded && encoded.ok) {
        widthText += (encoded.totalWidth / 1000) * run.fontSize * (run.horizScale || 1)
        return
      }
      needsFallback = true
      for (const u of encoded?.unmapped ?? [...part].map((c, index) => ({ index, char: c }))) {
        unmapped.add(u.char)
      }
      // Estimate with the run's own average advance so the width stays close
      // even for characters the original font cannot encode.
      const perChar = averageWidth(run)
      widthText += (perChar / 1000) * part.length * run.fontSize * (run.horizScale || 1)
    })

    const anchor = runs[0]
    const scale = anchor ? anchor.textToPageScale || 1 : 1
    const width = widthText * scale
    return {
      width,
      originalWidth: line.width,
      fits: line.width <= 0 ? true : width <= line.width * 1.002,
      unmapped: [...unmapped],
      needsFallback,
    }
  }

  async export(edits: ReadonlyMap<string, LineEdit>): Promise<ExportResult> {
    this.assertAlive()
    return exportEditedPdf(this.originalBytes, this.loaded, edits)
  }

  async renderEditedPage(
    pageIndex: number,
    edits: ReadonlyMap<string, LineEdit>,
    scale: number,
    canvas: HTMLCanvasElement,
    signal?: AbortSignal
  ): Promise<RenderResult> {
    this.assertAlive()
    const key = editsKey(edits)
    if (key === '') return this.renderPage(pageIndex, scale, canvas, signal)

    return this.serialised(async () => {
      this.assertAlive()
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      if (!this.previewCache || this.previewCache.key !== key) {
        const result = await exportEditedPdf(this.originalBytes, this.loaded, edits)
        this.previewCache = { key, bytes: result.bytes }
      }
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      if (!this.previewPdf || this.previewPdf.key !== key) {
        const task = openWithPdfJs(this.previewCache.bytes)
        const pdf = await task.promise
        // Only now is the old document certainly unused: nothing else can be
        // inside this block, and the caller awaits the render below.
        await this.disposePreviewPdf()
        if (this.destroyed) {
          await task.destroy().catch(() => {})
          throw new Error('This editor session has been closed.')
        }
        this.previewPdf = { key, task, pdf }
      }
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      return renderInto(this.previewPdf.pdf, pageIndex, { canvas, scale }, signal)
    })
  }

  /** Run `fn` after every previously queued preview build has finished. */
  private async serialised<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.previewLock
    let release!: () => void
    this.previewLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async disposePreviewPdf(): Promise<void> {
    const previous = this.previewPdf
    this.previewPdf = null
    if (previous) await previous.task.destroy().catch(() => {})
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('This editor session has been closed.')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    void this.disposePreviewPdf()
    void this.task.destroy().catch(() => {})
  }
}

function averageWidth(run: TextRun): number {
  if (run.glyphs.length === 0) return 500
  const total = run.glyphs.reduce((a, g) => a + g.width, 0)
  return total / run.glyphs.length || 500
}

function editsKey(edits: ReadonlyMap<string, LineEdit>): string {
  const parts: string[] = []
  for (const [id, edit] of edits) {
    parts.push(`${id} ${edit.text} ${edit.overflow} ${edit.anchor}`)
  }
  parts.sort()
  return parts.join('')
}

/** Entry point used by the UI. */
export async function createEngine(
  file: File | Uint8Array,
  signal?: AbortSignal
): Promise<EditorEngine> {
  return PdfEditorEngine.open(file, signal)
}

export { PdfLoadError, encodeWithFallback }
