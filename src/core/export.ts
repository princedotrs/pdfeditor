/**
 * Producing the edited PDF.
 *
 * Every export starts from the *original* bytes and re-applies all edits, so
 * exporting twice yields the same file and a failed export cannot leave the
 * in-memory document in a half-written state. Byte offsets recorded at load
 * time stay valid because the same streams decode to the same bytes.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  type PDFContext,
  type PDFFont,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib'
import { distribute } from './distribute'
import type { LoadedPdf } from './document'
import { readPageContent } from './document'
import type { DocumentWarning, EditStats, LineEdit, TextLine, TextRun } from './model'
import {
  applyReplacements,
  buildDrawBlock,
  neutralizeRun,
  segmentsWidth,
  wrapAndAppend,
  type DrawSegment,
  type Replacement,
} from './rewrite'
import { asDict, resolve } from './pdfutil'

export interface ExportResult {
  bytes: Uint8Array
  stats: EditStats
  warnings: DocumentWarning[]
}

export interface ExportOptions {
  /** A user-supplied font used when the original cannot encode a character. */
  fallbackFontBytes?: Uint8Array
  /** Registered fontkit instance, required for a custom fallback font. */
  fontkit?: unknown
  /** Emit uncompressed streams; useful for debugging the output. */
  uncompressed?: boolean
}

const MIN_SHRINK = 0.4
const MIN_CONDENSE = 0.6

/** Per-page state built up while the edits are applied. */
interface PageWork {
  page: PDFPage
  appended: string[]
  /** Font resource name on the page for a given font object ref tag. */
  fontNames: Map<string, string>
  resources: PDFDict | null
}

export async function exportEditedPdf(
  originalBytes: Uint8Array,
  loaded: LoadedPdf,
  edits: ReadonlyMap<string, LineEdit>,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const out = await PDFDocument.load(originalBytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
    ignoreEncryption: false,
  })
  const context = out.context
  const pages = out.getPages()
  const warnings: DocumentWarning[] = []
  const stats: EditStats = {
    linesChanged: 0,
    runsRewritten: 0,
    runsDeleted: 0,
    reusedOriginalFont: 0,
    usedFallbackFont: 0,
  }

  const patches = new Map<string, Replacement[]>()
  const work = new Map<number, PageWork>()
  const unmappedChars = new Set<string>()
  /** Characters that not even the fallback font can draw. */
  const unrenderable = new Set<string>()

  const workFor = (pageIndex: number): PageWork => {
    const existing = work.get(pageIndex)
    if (existing) return existing
    const created: PageWork = {
      page: pages[pageIndex],
      appended: [],
      fontNames: new Map(),
      resources: null,
    }
    work.set(pageIndex, created)
    return created
  }

  const addPatch = (streamKey: string, replacement: Replacement): void => {
    const list = patches.get(streamKey)
    if (list) list.push(replacement)
    else patches.set(streamKey, [replacement])
  }

  let fallback: PDFFont | null = null
  const getFallback = async (): Promise<PDFFont | null> => {
    if (fallback) return fallback
    try {
      if (options.fallbackFontBytes) {
        if (options.fontkit) out.registerFontkit(options.fontkit as never)
        fallback = await out.embedFont(options.fallbackFontBytes, { subset: true })
      } else {
        fallback = out.embedStandardFont(StandardFonts.Helvetica)
      }
    } catch {
      fallback = null
    }
    return fallback
  }

  const lineById = new Map<string, TextLine>()
  for (const line of loaded.model.lines) lineById.set(line.id, line)

  for (const [lineId, edit] of edits) {
    const line = lineById.get(lineId)
    if (!line) continue
    if (line.blockers.length > 0) {
      warnings.push({
        level: 'warn',
        code: 'locked-line',
        pageIndex: line.pageIndex,
        message: `A change to “${truncate(line.text)}” was skipped because that text is not editable (${line.blockers.join(', ')}).`,
      })
      continue
    }

    const runs = line.runIds
      .map((id) => loaded.model.runs.get(id))
      .filter((r): r is TextRun => Boolean(r))
    if (runs.length === 0) continue

    const dist = distribute(line.runTexts, edit.text)
    if (!dist.changed) continue
    stats.linesChanged += 1

    const pageWork = workFor(line.pageIndex)
    const segments: DrawSegment[] = []

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      const text = dist.texts[i] ?? ''
      if (text.length === 0) continue

      const font = loaded.fonts.get(run.fontKey)
      const encoded = font && font.canReuse ? font.encode(text, run.glyphs) : null

      if (encoded && encoded.ok && encoded.bytes.length > 0) {
        const resourceName = ensureFontOnPage(context, pageWork, loaded, run, run.fontName)
        if (resourceName) {
          segments.push({
            fontResource: resourceName,
            fontSize: run.fontSize,
            fill: run.fill,
            bytes: encoded.bytes,
            width1000: encoded.totalWidth,
            glyphCount: encoded.glyphCount,
            spaceCount: encoded.wordSpaceCount,
          })
          stats.reusedOriginalFont += 1
          for (const w of encoded.warnings) {
            if (w.startsWith('substituted:')) unmappedChars.add(w.split(':')[1] ?? '')
          }
          continue
        }
      }

      // The original font cannot draw this text — embed a fallback.
      for (const u of encoded?.unmapped ?? [...text].map((c, index) => ({ index, char: c }))) {
        unmappedChars.add(u.char)
      }
      const fb = await getFallback()
      if (!fb) {
        warnings.push({
          level: 'error',
          code: 'no-font',
          pageIndex: line.pageIndex,
          message: `Could not embed a fallback font, so “${truncate(text)}” was left out.`,
        })
        continue
      }
      const fbResource = ensureFallbackOnPage(context, pageWork, fb)
      const safe = encodeWithFallback(fb, text)
      for (const c of safe.dropped) {
        unmappedChars.add(c)
        unrenderable.add(c)
      }
      stats.usedFallbackFont += 1
      if (safe.bytes.length === 0) continue
      segments.push({
        fontResource: fbResource,
        fontSize: run.fontSize,
        fill: run.fill,
        bytes: safe.bytes,
        width1000: safe.width1000,
        glyphCount: safe.glyphCount,
        spaceCount: safe.spaceCount,
      })
    }

    // Neutralise every original operator of the line, whether or not its text
    // survived — the replacement is drawn as one block, not run by run.
    for (const run of runs) {
      const { bytes, mode } = neutralizeRun(run)
      addPatch(run.streamKey, { start: run.start, end: run.end, bytes })
      if (mode === 'invisible') {
        warnings.push({
          level: 'info',
          code: 'hidden-not-removed',
          pageIndex: line.pageIndex,
          message:
            'Some original text could not be measured, so it was hidden rather than removed. It will not be visible, but it may still be found by a text search.',
        })
      }
      stats.runsRewritten += 1
      if (mode === 'delete') stats.runsDeleted += 1
    }

    if (segments.length === 0) continue

    const anchor = runs[0]
    const scale = anchor.textToPageScale || 1
    const originalWidth = line.width / scale
    let horizScale = anchor.horizScale || 1
    const { charSpacing, wordSpacing } = anchor
    let width = segmentsWidth(segments, horizScale, charSpacing, wordSpacing)

    if (originalWidth > 0 && width > originalWidth) {
      if (edit.overflow === 'shrink') {
        const factor = Math.max(MIN_SHRINK, originalWidth / width)
        for (const seg of segments) seg.fontSize *= factor
        width = segmentsWidth(segments, horizScale, charSpacing, wordSpacing)
      } else if (edit.overflow === 'condense') {
        horizScale = Math.max(MIN_CONDENSE, horizScale * (originalWidth / width))
        width = segmentsWidth(segments, horizScale, charSpacing, wordSpacing)
      }
      if (width > originalWidth * 1.001) {
        warnings.push({
          level: 'info',
          code: 'overflow',
          pageIndex: line.pageIndex,
          message: `“${truncate(edit.text)}” is wider than the text it replaces and extends past the original right edge.`,
        })
      }
    }

    let offsetX = 0
    if (edit.anchor === 'center') offsetX = (originalWidth - width) / 2
    else if (edit.anchor === 'right') offsetX = originalWidth - width

    pageWork.appended.push(
      buildDrawBlock({
        ctm: anchor.ctm,
        textMatrix: anchor.textMatrix,
        horizScale,
        charSpacing,
        wordSpacing,
        rise: anchor.rise,
        renderMode: anchor.renderMode >= 4 ? 0 : anchor.renderMode,
        stroke: anchor.stroke,
        lineWidth: anchor.lineWidth,
        segments,
        offsetX,
      })
    )
  }

  const substituted = [...unmappedChars].filter((c) => !unrenderable.has(c))
  if (substituted.length > 0) {
    warnings.push({
      level: 'warn',
      code: 'font-substituted',
      message: `The original font could not draw ${quoteChars(substituted)} — a substitute font was used for that text, so it may look different.`,
    })
  }
  if (unrenderable.size > 0) {
    // Worth being blunt: the characters are simply missing from the output.
    warnings.push({
      level: 'error',
      code: 'unrenderable',
      message: `${quoteChars([...unrenderable])} could not be written at all. The built-in fallback font covers Western European characters only — load a font that includes these characters and export again.`,
    })
  }

  writeStreams(context, out, loaded, patches, work, warnings)

  const bytes = await out.save({
    useObjectStreams: !options.uncompressed,
    addDefaultPage: false,
    updateFieldAppearances: false,
  })

  return { bytes, stats, warnings }
}

/* ------------------------------------------------------------------ */
/* Writing patched streams back into the document                      */
/* ------------------------------------------------------------------ */

function writeStreams(
  context: PDFContext,
  out: PDFDocument,
  loaded: LoadedPdf,
  patches: Map<string, Replacement[]>,
  work: Map<number, PageWork>,
  warnings: DocumentWarning[]
): void {
  const pages = out.getPages()

  // Form XObjects first: they are patched in place, keeping their object number
  // so every existing reference stays valid.
  for (const [key, replacements] of patches) {
    if (!key.startsWith('xobj:')) continue
    const source = findStream(loaded, key)
    if (!source) continue
    const ref = refFromKey(key)
    if (!ref) continue
    const existing = context.lookup(ref)
    if (!(existing instanceof PDFStream)) continue
    try {
      const patched = applyReplacements(source.bytes, replacements)
      const stream = context.flateStream(patched)
      copyStreamDict(existing.dict, stream.dict)
      context.assign(ref, stream)
    } catch (err) {
      warnings.push({
        level: 'error',
        code: 'xobject-write',
        message: `A reusable object could not be rewritten (${err instanceof Error ? err.message : 'unknown error'}); those edits were skipped.`,
      })
    }
  }

  const editedPages = new Set<number>([
    ...work.keys(),
    ...[...patches.keys()]
      .filter((k) => k.startsWith('page:'))
      .map((k) => Number(k.slice('page:'.length))),
  ])

  for (const pageIndex of editedPages) {
    const page = pages[pageIndex]
    if (!page) continue
    const key = `page:${pageIndex}`
    const original = readPageContent(context, page)
    const replacements = patches.get(key) ?? []
    const appended = work.get(pageIndex)?.appended.join('\n') ?? ''
    if (replacements.length === 0 && appended === '') continue

    let patched: Uint8Array
    try {
      patched = applyReplacements(original, replacements)
    } catch (err) {
      warnings.push({
        level: 'error',
        code: 'page-write',
        pageIndex,
        message: `Page ${pageIndex + 1} could not be rewritten (${err instanceof Error ? err.message : 'unknown error'}); its edits were skipped.`,
      })
      continue
    }

    const finalBytes = wrapAndAppend(patched, appended)
    const stream = context.flateStream(finalBytes)
    const ref = context.register(stream)
    const previous = page.node.get(PDFName.Contents)
    page.node.set(PDFName.Contents, ref)
    releaseOldContents(context, pages, previous)
  }
}

/** Drop content streams that nothing else references, to avoid file bloat. */
function releaseOldContents(
  context: PDFContext,
  pages: PDFPage[],
  previous: PDFObject | undefined
): void {
  if (!previous) return
  const stillUsed = new Set<string>()
  for (const p of pages) {
    const c = p.node.get(PDFName.Contents)
    collectRefTags(context, c, stillUsed)
  }
  const candidates = new Set<string>()
  collectRefTags(context, previous, candidates)
  for (const tag of candidates) {
    if (stillUsed.has(tag)) continue
    const match = /^(\d+) (\d+) R$/.exec(tag)
    if (!match) continue
    context.delete(PDFRef.of(Number(match[1]), Number(match[2])))
  }
}

function collectRefTags(context: PDFContext, obj: PDFObject | undefined, into: Set<string>): void {
  if (!obj) return
  if (obj instanceof PDFRef) {
    into.add(obj.tag)
    const resolved = context.lookup(obj)
    if (resolved instanceof PDFArray) collectRefTags(context, resolved, into)
    return
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) collectRefTags(context, obj.get(i), into)
  }
}

const SKIPPED_STREAM_KEYS = new Set(['Filter', 'Length', 'DecodeParms', 'DL', 'F'])

/** Copy a stream's dictionary onto a replacement, leaving encoding keys alone. */
function copyStreamDict(from: PDFDict, to: PDFDict): void {
  for (const [key, value] of from.entries()) {
    const name = key.asString().replace(/^\//, '')
    if (SKIPPED_STREAM_KEYS.has(name)) continue
    to.set(key, value)
  }
}

function findStream(loaded: LoadedPdf, key: string) {
  for (const bundle of loaded.bundles) {
    const found = bundle.streams.get(key)
    if (found) return found
  }
  return undefined
}

function refFromKey(key: string): PDFRef | null {
  const match = /^xobj:(\d+) (\d+) R$/.exec(key)
  return match ? PDFRef.of(Number(match[1]), Number(match[2])) : null
}

/* ------------------------------------------------------------------ */
/* Resource management                                                 */
/* ------------------------------------------------------------------ */

/**
 * Make sure the page's own `/Resources /Font` contains the font a run used, and
 * return the name to reference it by.
 *
 * This matters for text that lives inside a Form XObject: its font is declared
 * in the XObject's resources, which the page-level drawing block cannot see.
 * The page's Resources dict is shallow-copied first, because pdf-lib leaves an
 * inherited Resources dict shared with every sibling page.
 */
function ensureFontOnPage(
  context: PDFContext,
  work: PageWork,
  loaded: LoadedPdf,
  run: TextRun,
  preferredName: string
): string | null {
  const streamSource = findStreamForRun(loaded, run)
  const streamResources = streamSource?.resources
  const fontsDict = asDict(resolve(context, streamResources?.get(PDFName.Font)))
  if (!fontsDict) return null
  const raw = fontsDict.get(PDFName.of(preferredName))
  if (!raw) return null

  // Check the cache before registering: a page's /Font entry can be a direct
  // dictionary rather than a reference, and registering it once per edited run
  // would add a duplicate object and a duplicate resource name each time.
  const cacheKey =
    raw instanceof PDFRef ? raw.tag : `inline:${run.streamKey}:${preferredName}`
  const cached = work.fontNames.get(cacheKey)
  if (cached) return cached
  const ref = raw instanceof PDFRef ? raw : context.register(raw)

  const pageFonts = ensurePageFontDict(context, work)
  // Reuse the original name when it is free or already points at this font.
  const existing = pageFonts.get(PDFName.of(preferredName))
  if (!existing || (existing instanceof PDFRef && existing.tag === ref.tag)) {
    pageFonts.set(PDFName.of(preferredName), ref)
    work.fontNames.set(cacheKey, preferredName)
    return preferredName
  }
  let index = 0
  let name = `${preferredName}_e`
  while (pageFonts.get(PDFName.of(name))) name = `${preferredName}_e${++index}`
  pageFonts.set(PDFName.of(name), ref)
  work.fontNames.set(cacheKey, name)
  return name
}

function ensureFallbackOnPage(context: PDFContext, work: PageWork, font: PDFFont): string {
  const cacheKey = `fallback:${font.ref.tag}`
  const cached = work.fontNames.get(cacheKey)
  if (cached) return cached
  const pageFonts = ensurePageFontDict(context, work)
  let index = 0
  let name = 'PdfEdit_F0'
  while (pageFonts.get(PDFName.of(name))) name = `PdfEdit_F${++index}`
  pageFonts.set(PDFName.of(name), font.ref)
  work.fontNames.set(cacheKey, name)
  return name
}

function ensurePageFontDict(context: PDFContext, work: PageWork): PDFDict {
  if (!work.resources) {
    const inherited = asDict(
      resolve(context, work.page.node.getInheritableAttribute(PDFName.Resources))
    )
    // Shallow-copy so we never mutate a Resources dict shared with other pages.
    const copy = context.obj({}) as PDFDict
    if (inherited) {
      for (const [k, v] of inherited.entries()) copy.set(k, v)
    }
    work.page.node.set(PDFName.Resources, copy)
    work.resources = copy
  }
  const existing = asDict(resolve(context, work.resources.get(PDFName.Font)))
  const fonts = context.obj({}) as PDFDict
  if (existing) {
    for (const [k, v] of existing.entries()) fonts.set(k, v)
  }
  work.resources.set(PDFName.Font, fonts)
  return fonts
}

function findStreamForRun(loaded: LoadedPdf, run: TextRun) {
  const bundle = loaded.bundles[run.pageIndex]
  return bundle?.streams.get(run.streamKey) ?? findStream(loaded, run.streamKey)
}

/* ------------------------------------------------------------------ */
/* Fallback font encoding                                              */
/* ------------------------------------------------------------------ */

export interface FallbackEncoding {
  bytes: Uint8Array
  width1000: number
  /** Glyphs emitted, and how many of them are a single-byte space. */
  glyphCount: number
  spaceCount: number
  dropped: string[]
}

/**
 * pdf-lib's standard fonts throw on anything outside WinAnsi, so encode
 * character by character and report what had to be dropped rather than failing
 * the whole export.
 */
export function encodeWithFallback(font: PDFFont, text: string): FallbackEncoding {
  const counts = (kept: string) => ({
    glyphCount: [...kept].length,
    spaceCount: [...kept].filter((c) => c === ' ').length,
  })
  try {
    const bytes = font.encodeText(text).asBytes()
    return {
      bytes,
      width1000: font.widthOfTextAtSize(text, 1000),
      ...counts(text),
      dropped: [],
    }
  } catch {
    /* fall through to per-character encoding */
  }
  const parts: Uint8Array[] = []
  const dropped: string[] = []
  let kept = ''
  for (const ch of text) {
    try {
      parts.push(font.encodeText(ch).asBytes())
      kept += ch
    } catch {
      dropped.push(ch)
    }
  }
  let size = 0
  for (const p of parts) size += p.length
  const bytes = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  let width1000 = 0
  try {
    width1000 = font.widthOfTextAtSize(kept, 1000)
  } catch {
    width1000 = kept.length * 500
  }
  return { bytes, width1000, ...counts(kept), dropped }
}

function quoteChars(chars: string[]): string {
  const shown = chars.slice(0, 12).map((c) => `“${c}”`).join(', ')
  return chars.length > 12 ? `${shown} and ${chars.length - 12} more` : shown
}

function truncate(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Exposed for tests: the raw bytes a page's content stream will contain. */
export function debugPageContent(context: PDFContext, page: PDFPage): string {
  const bytes = readPageContent(context, page)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

export { PDFRawStream }
