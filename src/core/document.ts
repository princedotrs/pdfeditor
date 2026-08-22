/**
 * Loading a PDF into the editable model.
 *
 * pdf-lib is used purely as an object-model and serialiser; all text analysis
 * is done by our own interpreter. Note that pdf-lib is a stricter parser than
 * the renderer we ship alongside it, so a file can render fine and still fail
 * to parse here — that is why loading happens up front and degrades to a clear
 * error rather than failing at download time.
 */
import {
  EncryptedPDFError,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFPage,
  type PDFContext,
  type PDFDict,
} from 'pdf-lib'
import { FontCache, type PdfFont } from './font'
import { groupIntoLines } from './grouping'
import { ContentInterpreter, type StreamSource } from './interpreter'
import { IDENTITY, translation, type Matrix, type Rect } from './matrix'
import type {
  DocumentWarning,
  EditableDocument,
  PageInfo,
  TextLine,
  TextRun,
} from './model'
import { asDict, dictGet, joinBytes, numbersFrom, resolve, streamBytes } from './pdfutil'

export class PdfLoadError extends Error {
  constructor(
    message: string,
    readonly code: 'encrypted' | 'parse' | 'empty'
  ) {
    super(message)
    this.name = 'PdfLoadError'
  }
}

export interface PageBundle {
  index: number
  page: PDFPage
  info: PageInfo
  resources: PDFDict | undefined
  /** Concatenated bytes of the page's content stream(s). */
  contentBytes: Uint8Array
  /** Every stream reachable from this page, keyed as in `TextRun.streamKey`. */
  streams: Map<string, StreamSource>
}

export interface LoadedPdf {
  doc: PDFDocument
  context: PDFContext
  bundles: PageBundle[]
  model: EditableDocument
  fonts: Map<string, PdfFont>
  /** Object refs of streams reachable from more than one page. */
  sharedStreams: Set<string>
  /** Which page each non-shared XObject stream belongs to. */
  streamOwner: Map<string, number>
}

const PAGE_STREAM_SEPARATOR = 0x0a

/** Read and decode a page's content, matching how a viewer concatenates parts. */
export function readPageContent(context: PDFContext, page: PDFPage): Uint8Array {
  const contents = page.node.Contents()
  if (!contents) return new Uint8Array(0)
  if (contents instanceof PDFArray) {
    const parts: Uint8Array[] = []
    for (let i = 0; i < contents.size(); i++) {
      const entry = resolve(context, contents.get(i))
      const bytes = streamBytes(entry)
      if (bytes) parts.push(bytes)
    }
    return joinBytes(parts, PAGE_STREAM_SEPARATOR)
  }
  return streamBytes(contents as PDFStream) ?? new Uint8Array(0)
}

function rectFromBox(nums: (number | undefined)[]): Rect | null {
  if (nums.length !== 4 || nums.some((n) => typeof n !== 'number')) return null
  const [x0, y0, x1, y1] = nums as number[]
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  }
}

function inheritedArray(context: PDFContext, page: PDFPage, key: string): (number | undefined)[] {
  const raw = page.node.getInheritableAttribute(PDFName.of(key))
  const resolved = resolve(context, raw)
  return resolved instanceof PDFArray ? numbersFrom(context, resolved) : []
}

function pageInfo(context: PDFContext, page: PDFPage, index: number): PageInfo {
  const media =
    rectFromBox(inheritedArray(context, page, 'MediaBox')) ??
    { x: 0, y: 0, width: 612, height: 792 }
  const cropRaw = rectFromBox(inheritedArray(context, page, 'CropBox'))
  // The visible area is the CropBox intersected with the MediaBox.
  let visible = media
  if (cropRaw) {
    const x = Math.max(media.x, cropRaw.x)
    const y = Math.max(media.y, cropRaw.y)
    const right = Math.min(media.x + media.width, cropRaw.x + cropRaw.width)
    const top = Math.min(media.y + media.height, cropRaw.y + cropRaw.height)
    if (right > x && top > y) visible = { x, y, width: right - x, height: top - y }
  }

  const rotateRaw = resolve(context, page.node.getInheritableAttribute(PDFName.of('Rotate')))
  const rotateNum =
    rotateRaw && 'asNumber' in rotateRaw ? (rotateRaw as { asNumber(): number }).asNumber() : 0
  const rotation = ((Math.round(rotateNum / 90) * 90) % 360 + 360) % 360
  const swapped = rotation === 90 || rotation === 270

  return {
    index,
    width: visible.width,
    height: visible.height,
    rotation,
    offsetX: visible.x,
    offsetY: visible.y,
    displayWidth: swapped ? visible.height : visible.width,
    displayHeight: swapped ? visible.width : visible.height,
  }
}

/** Translate a run's display geometry from raw user space into page space. */
function toPageSpace(run: TextRun, info: PageInfo): void {
  const dx = -info.offsetX
  const dy = -info.offsetY
  run.bbox = { ...run.bbox, x: run.bbox.x + dx, y: run.bbox.y + dy }
  run.origin = [run.origin[0] + dx, run.origin[1] + dy]
  const t: Matrix = translation(dx, dy)
  run.trm = [
    run.trm[0],
    run.trm[1],
    run.trm[2],
    run.trm[3],
    run.trm[4] + t[4],
    run.trm[5] + t[5],
  ]
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: false,
    })
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new PdfLoadError(
        'This PDF is password-protected or encrypted. Decrypt it first — editing an encrypted file would produce a corrupt document.',
        'encrypted'
      )
    }
    throw new PdfLoadError(
      err instanceof Error ? `This PDF could not be parsed: ${err.message}` : 'This PDF could not be parsed.',
      'parse'
    )
  }

  const context = doc.context
  const pages = doc.getPages()
  if (pages.length === 0) throw new PdfLoadError('This PDF has no pages.', 'empty')

  const warnings: DocumentWarning[] = []
  const bundles: PageBundle[] = []
  const allRuns: TextRun[] = []
  const fonts = new Map<string, PdfFont>()
  const infos: PageInfo[] = []

  // Which pages reference each Form XObject, so shared ones can be flagged.
  const xobjectPages = new Map<string, Set<number>>()
  const streamOwner = new Map<string, number>()

  const fontCache = new FontCache(context)

  pages.forEach((page, index) => {
    const info = pageInfo(context, page, index)
    infos.push(info)

    const resources = asDict(resolve(context, page.node.getInheritableAttribute(PDFName.Resources)))
    let contentBytes: Uint8Array
    try {
      contentBytes = readPageContent(context, page)
    } catch (err) {
      contentBytes = new Uint8Array(0)
      warnings.push({
        level: 'warn',
        code: 'content-decode',
        pageIndex: index,
        message: `Page ${index + 1}: the content stream could not be decompressed (${
          err instanceof Error ? err.message : 'unknown error'
        }). Its text is not editable.`,
      })
    }

    const source: StreamSource = { key: `page:${index}`, bytes: contentBytes, resources }
    const interpreter = new ContentInterpreter(context, fontCache)
    let result
    try {
      result = interpreter.interpret(source, { pageIndex: index, baseCtm: IDENTITY })
    } catch (err) {
      warnings.push({
        level: 'warn',
        code: 'interpret',
        pageIndex: index,
        message: `Page ${index + 1}: its content stream could not be fully analysed (${
          err instanceof Error ? err.message : 'unknown error'
        }).`,
      })
      bundles.push({ index, page, info, resources, contentBytes, streams: new Map([[source.key, source]]) })
      return
    }

    for (const use of result.xobjectUses) {
      const set = xobjectPages.get(use.key)
      if (set) set.add(index)
      else xobjectPages.set(use.key, new Set([index]))
    }
    for (const key of result.streams.keys()) {
      if (!streamOwner.has(key)) streamOwner.set(key, index)
    }
    for (const [key, font] of result.fontsByKey) fonts.set(key, font)

    for (const run of result.runs) {
      toPageSpace(run, info)
      allRuns.push(run)
    }

    if (result.usedTextClipping) {
      warnings.push({
        level: 'info',
        code: 'text-clip',
        pageIndex: index,
        message: `Page ${index + 1} uses text as a clipping path; edits there are applied conservatively.`,
      })
    }

    bundles.push({ index, page, info, resources, contentBytes, streams: result.streams })
  })

  const sharedStreams = new Set<string>()
  for (const [key, set] of xobjectPages) {
    if (set.size > 1) sharedStreams.add(key)
  }
  // A Form XObject drawn more than once — even on a single page — produces two
  // runs over the same bytes. Rewriting those bytes would change both copies,
  // so lock them rather than silently editing text the user did not select.
  const seenSpans = new Set<string>()
  for (const run of allRuns) {
    const span = `${run.streamKey}|${run.start}`
    if (seenSpans.has(span)) sharedStreams.add(run.streamKey)
    else seenSpans.add(span)
  }
  if (sharedStreams.size > 0) {
    warnings.push({
      level: 'warn',
      code: 'shared-xobject',
      message:
        'Some text lives in a reusable object shared by several pages (a letterhead or template). Editing it would change every page that uses it, so it is locked.',
    })
  }

  const lines = groupIntoLines({ runs: allRuns, fonts, sharedStreams, pages: infos })

  const runs = new Map<string, TextRun>()
  for (const run of allRuns) runs.set(run.id, run)

  const linesByPage = new Map<number, TextLine[]>()
  for (const line of lines) {
    const list = linesByPage.get(line.pageIndex)
    if (list) list.push(line)
    else linesByPage.set(line.pageIndex, [line])
  }

  const editable = lines.filter((l) => l.blockers.length === 0)
  if (editable.length === 0) {
    const anyText = allRuns.length > 0
    warnings.push({
      level: 'error',
      code: anyText ? 'no-editable-text' : 'no-text',
      message: anyText
        ? 'No editable text was found. This document’s text is drawn in a way that cannot be edited safely — it may be an invisible OCR layer over a scan, or use fonts with no recoverable character mapping.'
        : 'No text was found. This looks like a scan or a drawing made of vector shapes, so there is nothing to edit.',
    })
  }
  if (doc.isEncrypted) {
    warnings.push({
      level: 'warn',
      code: 'encrypted',
      message: 'This document declares encryption; the exported file may not open correctly.',
    })
  }
  if (hasSignature(context, doc)) {
    warnings.push({
      level: 'warn',
      code: 'signed',
      message:
        'This PDF carries a digital signature. Saving rewrites the whole file, which will invalidate that signature.',
    })
  }

  const model: EditableDocument = {
    pages: infos,
    runs,
    lines,
    linesByPage,
    warnings,
    hasEditableText: editable.length > 0,
    readOnly: editable.length === 0,
  }

  return { doc, context, bundles, model, fonts, sharedStreams, streamOwner }
}

function hasSignature(context: PDFContext, doc: PDFDocument): boolean {
  try {
    const acro = dictGet(context, doc.catalog, 'AcroForm')
    const acroDict = asDict(acro)
    if (!acroDict) return false
    const flags = dictGet(context, acroDict, 'SigFlags')
    if (flags && 'asNumber' in flags) return (flags as { asNumber(): number }).asNumber() > 0
    return false
  } catch {
    return false
  }
}

/** Look up the pdf-lib stream object behind a `TextRun.streamKey`. */
export function resolveStreamRef(context: PDFContext, key: string): PDFRef | null {
  if (!key.startsWith('xobj:')) return null
  const tag = key.slice('xobj:'.length)
  const match = /^(\d+) (\d+) R$/.exec(tag)
  if (!match) return null
  const ref = PDFRef.of(Number(match[1]), Number(match[2]))
  return context.lookup(ref) instanceof PDFRawStream || context.lookup(ref) instanceof PDFStream
    ? ref
    : null
}
