/**
 * A content-stream interpreter that tracks the graphics and text state well
 * enough to locate, measure and rewrite every text-showing operator.
 *
 * We deliberately do not use pdf.js's `getTextContent()` for the editing model.
 * pdf.js splits and merges show operators according to its own heuristics
 * (kerning thresholds, synthesised spaces, marked-content flush points), so the
 * Nth text item is *not* the Nth show operator. Interpreting the stream
 * ourselves makes the correspondence exact by construction: every run carries
 * the byte range of the operator it came from.
 *
 * References: ISO 32000-1 §8.4 (graphics state), §9.3-9.4 (text state,
 * positioning and showing).
 */
import { ContentLexer, type CSObject, type CSOperation } from './lexer'
import type { PdfFont, FontCache } from './font'
import {
  IDENTITY,
  apply,
  decompose,
  mul,
  transformedBox,
  translation,
  unionRect,
  type Matrix,
  type Rect,
} from './matrix'
import type { Glyph, RGB, ShowOp, TextRun } from './model'
import {
  asDict,
  asName,
  dictArray,
  dictDict,
  dictGet,
  dictName,
  dictNumber,
  elementsOf,
  numbersFrom,
  streamBytes,
} from './pdfutil'
import { PDFArray, PDFDict, PDFName, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib'

const MAX_XOBJECT_DEPTH = 8

/**
 * How to read the operands of `sc`/`scn`.
 *
 * `tint` covers Separation and DeviceN, where the operand is ink coverage: 1
 * means *full* colorant, i.e. dark. Reading that as a DeviceGray level inverts
 * it and paints replacement text white on white. `unknown` means we could not
 * work the space out at all, and the caller should fall back to black rather
 * than guess.
 */
type ColorSpaceKind = 'gray' | 'rgb' | 'cmyk' | 'tint' | 'unknown'

/**
 * Graphics state. Text state is part of it (ISO 32000-1 §9.3), so `q`/`Q` save
 * and restore it — including the current font.
 *
 * The *resolved* font lives here rather than beside it as a local, because
 * restoring only `fontName` on `Q` would leave the resolved object pointing at
 * whatever font was selected inside the `q … Q` block. Every subsequent run
 * would then be measured with one font's widths and labelled with another's
 * name, which silently corrupts both the deletion compensation and the
 * re-encoding of edited text.
 */
interface GState {
  ctm: Matrix
  fill: RGB | null
  fillSpace: ColorSpaceKind
  stroke: RGB | null
  strokeSpace: ColorSpaceKind
  lineWidth: number
  charSpacing: number
  wordSpacing: number
  /** Th — horizontal scaling as a ratio, i.e. Tz / 100. */
  horizScale: number
  leading: number
  fontName: string | null
  font: PdfFont | null
  fontKey: string
  fontSize: number
  rise: number
  renderMode: number
}

function initialState(ctm: Matrix): GState {
  return {
    ctm,
    fill: { r: 0, g: 0, b: 0 },
    fillSpace: 'gray',
    stroke: { r: 0, g: 0, b: 0 },
    strokeSpace: 'gray',
    lineWidth: 1,
    charSpacing: 0,
    wordSpacing: 0,
    horizScale: 1,
    leading: 0,
    fontName: null,
    font: null,
    fontKey: '',
    fontSize: 0,
    rise: 0,
    renderMode: 0,
  }
}

export interface StreamSource {
  key: string
  bytes: Uint8Array
  resources: PDFDict | undefined
}

export interface InterpretOptions {
  pageIndex: number
  /** Maps page-space; applied outermost. */
  baseCtm: Matrix
}

export interface XObjectUse {
  key: string
  ref: PDFRef
  pageIndex: number
}

export interface InterpretResult {
  runs: TextRun[]
  /** Every Form XObject invoked, so callers can detect sharing across pages. */
  xobjectUses: XObjectUse[]
  /** Streams actually visited, keyed as in `TextRun.streamKey`. */
  streams: Map<string, StreamSource>
  /** True if any text was drawn in a clipping render mode (4-7). */
  usedTextClipping: boolean
  fontsByKey: Map<string, PdfFont>
}

const num = (o: CSObject | undefined): number => (o && o.type === 'number' ? o.value : 0)

function toRGB(space: ColorSpaceKind, comps: number[]): RGB | null {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  if (comps.length === 0) return null

  if (space === 'tint') {
    // Full colorant is dark; approximate the (unknown) alternate space as ink
    // coverage on white.
    const tint = clamp(comps[comps.length === 1 ? 0 : comps.length - 1])
    const v = 1 - tint
    return { r: v, g: v, b: v }
  }

  const byCount = (n: number): RGB | null => {
    if (n === 1) {
      const g = clamp(comps[0])
      return { r: g, g, b: g }
    }
    if (n === 3) return { r: clamp(comps[0]), g: clamp(comps[1]), b: clamp(comps[2]) }
    if (n === 4) {
      const [c, m, y, k] = comps.map(clamp)
      return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) }
    }
    return null
  }

  if (space === 'gray') return byCount(1)
  if (space === 'rgb') return byCount(3)
  if (space === 'cmyk') return byCount(4)
  // Unknown space: only trust the operand count if it is unambiguous.
  return byCount(comps.length)
}

export class ContentInterpreter {
  readonly runs: TextRun[] = []
  readonly xobjectUses: XObjectUse[] = []
  readonly streams = new Map<string, StreamSource>()
  /** Every font actually used, keyed as in `TextRun.fontKey`. */
  readonly fontsByKey = new Map<string, PdfFont>()
  usedTextClipping = false

  private runSeq = 0
  private readonly activeStreams = new Set<string>()

  constructor(
    private readonly context: PDFContext,
    private readonly fonts: FontCache
  ) {}

  interpret(source: StreamSource, options: InterpretOptions): InterpretResult {
    this.execute(source, options.baseCtm, options.pageIndex, 0)
    this.markSafeDeletes()
    return {
      runs: this.runs,
      xobjectUses: this.xobjectUses,
      streams: this.streams,
      usedTextClipping: this.usedTextClipping,
      fontsByKey: this.fontsByKey,
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * `inherited` is the graphics state in force at the `Do` that invoked this
   * stream. A Form XObject's content is painted in the *current* graphics state
   * (ISO 32000-1 §8.10.2) — it inherits colour, text state and font, and only
   * the CTM is additionally composed with the form's `/Matrix`. Starting a form
   * from defaults loses inherited fill colours and, when a form relies on the
   * page's font, loses its text entirely.
   */
  private execute(
    source: StreamSource,
    ctm: Matrix,
    pageIndex: number,
    depth: number,
    inherited?: GState
  ): void {
    if (depth > MAX_XOBJECT_DEPTH) return
    if (this.activeStreams.has(source.key)) return // self-referential XObject
    this.activeStreams.add(source.key)
    this.streams.set(source.key, source)

    const ops = [...new ContentLexer(source.bytes).operations()]
    const stack: GState[] = []
    let gs: GState = inherited ? { ...inherited, ctm } : initialState(ctm)
    // Text object state is NOT inherited: BT resets both matrices anyway.
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    let inText = false
    const markedText: string[] = []

    const resolveFont = (name: string): void => {
      const found = this.fonts.fromResources(source.resources, name)
      gs.font = found?.font ?? null
      gs.fontKey = found?.key ?? `missing:${name}`
      if (found) this.fontsByKey.set(found.key, found.font)
    }

    const show = (
      op: CSOperation,
      kind: ShowOp,
      items: CSObject[],
      quote: { wordSpacing: number; charSpacing: number } | null
    ): void => {
      const glyphs: Glyph[] = []
      let advance = 0
      let tjAdjustment = 0
      let text = ''
      let synthesizedSpaces = 0
      let bbox: Rect | null = null

      const ascent = gs.font?.ascent ?? 0.9
      const descent = gs.font?.descent ?? -0.22
      const baseScale: Matrix = [gs.fontSize * gs.horizScale, 0, 0, gs.fontSize, 0, gs.rise]

      for (const item of items) {
        if (item.type === 'number') {
          // TJ adjustment: moves the pen back by value/1000 of a text unit.
          // Producers routinely express a word break as a large negative kern
          // instead of a space glyph, so the extracted text would otherwise
          // read "Totalamountduenow". Treat a gap of more than about half a
          // space as a word break; ordinary tracking kerns are far smaller.
          tjAdjustment += item.value
          const gap = -item.value / 1000
          const spaceEm = (gs.font?.spaceWidth ?? 250) / 1000
          if (gap >= spaceEm * 0.6 && text.length > 0 && !text.endsWith(' ')) {
            text += ' '
            synthesizedSpaces += 1
          }
          advance += gap * gs.fontSize * gs.horizScale
          continue
        }
        if (item.type !== 'string' || !gs.font) continue
        for (const glyph of gs.font.decodeString(item.bytes)) {
          if (glyph.unicode === ' ' && text.endsWith(' ') && synthesizedSpaces > 0) {
            // A real space right after a synthesised one would double up.
            synthesizedSpaces -= 1
            text = text.slice(0, -1)
          }
          const w0 = glyph.width / 1000
          // Word spacing applies only to a single-byte code 32 (§9.3.3).
          const isWordSpace = glyph.byteLen === 1 && glyph.code === 32
          const tx =
            (w0 * gs.fontSize + gs.charSpacing + (isWordSpace ? gs.wordSpacing : 0)) * gs.horizScale

          const glyphTm = mul(translation(advance, 0), tm)
          const trm = mul(mul(baseScale, glyphTm), gs.ctm)
          const box = transformedBox(trm, 0, descent, w0, ascent)
          bbox = bbox ? unionRect(bbox, box) : box

          glyphs.push({ ...glyph, offset: advance })
          text += glyph.unicode
          advance += tx
        }
      }

      if (glyphs.length === 0 && items.every((i) => i.type !== 'string')) {
        // A pure-adjustment TJ draws nothing; still advance the matrix.
        tm = mul(translation(advance, 0), tm)
        return
      }

      const textToPage = mul(tm, gs.ctm)
      const trm = mul(baseScale, textToPage)
      const d = decompose(trm)
      const origin = apply(trm, 0, 0)
      if (gs.renderMode >= 4) this.usedTextClipping = true

      this.runs.push({
        // Ids must be unique across the whole document: one interpreter runs
        // per page, so a bare counter would collide between pages.
        id: `p${pageIndex}r${this.runSeq++}`,
        pageIndex,
        streamKey: source.key,
        start: op.start,
        end: op.end,
        op: kind,
        fontName: gs.fontName ?? '',
        fontKey: gs.fontKey,
        fontSize: gs.fontSize,
        charSpacing: gs.charSpacing,
        wordSpacing: gs.wordSpacing,
        horizScale: gs.horizScale,
        leading: gs.leading,
        rise: gs.rise,
        renderMode: gs.renderMode,
        textMatrix: tm,
        lineMatrix: tlm,
        ctm: gs.ctm,
        trm,
        text,
        glyphs,
        tjAdjustment,
        advance,
        bbox: bbox ?? { x: origin[0], y: origin[1], width: 0, height: 0 },
        origin: [origin[0], origin[1]],
        effectiveSize: d.scaleY,
        angle: d.rotation,
        textToPageScale: Math.hypot(textToPage[0], textToPage[1]) || 1,
        fill: gs.fill,
        stroke: gs.stroke,
        lineWidth: gs.lineWidth,
        safeDelete: false,
        actualText: markedText.length ? markedText[markedText.length - 1] : null,
        quote,
        originalBytes: source.bytes.subarray(op.start, op.end),
      })

      tm = mul(translation(advance, 0), tm)
    }

    for (const op of ops) {
      switch (op.op) {
        /* --- graphics state --- */
        case 'q':
          stack.push({ ...gs })
          break
        case 'Q': {
          const prev = stack.pop()
          if (prev) gs = prev
          break
        }
        case 'cm': {
          const m: Matrix = [
            num(op.operands[0]),
            num(op.operands[1]),
            num(op.operands[2]),
            num(op.operands[3]),
            num(op.operands[4]),
            num(op.operands[5]),
          ]
          gs.ctm = mul(m, gs.ctm)
          break
        }
        case 'gs': {
          // An ExtGState may carry /Font [ref size].
          const name = op.operands[0]
          if (name && name.type === 'name') {
            const extg = dictDict(this.context, source.resources, 'ExtGState')
            const entry = extg ? dictDict(this.context, extg, name.value) : undefined
            const fontEntry = dictArray(this.context, entry, 'Font')
            if (fontEntry && fontEntry.size() >= 2) {
              const size = numbersFrom(this.context, fontEntry)[1]
              if (typeof size === 'number') gs.fontSize = size
              // /Font is [fontDictRef size]; it selects the font as well.
              const ref = fontEntry.get(0)
              const resolved = ref instanceof PDFRef ? this.fonts.fromRef(ref) : null
              if (resolved) {
                gs.font = resolved
                gs.fontKey = ref instanceof PDFRef ? ref.tag : gs.fontKey
                this.fontsByKey.set(gs.fontKey, resolved)
              }
            }
          }
          break
        }

        /* --- colour --- */
        case 'g':
          gs.fillSpace = 'gray'
          gs.fill = toRGB('gray', [num(op.operands[0])])
          break
        case 'G':
          gs.strokeSpace = 'gray'
          gs.stroke = toRGB('gray', [num(op.operands[0])])
          break
        case 'rg':
          gs.fillSpace = 'rgb'
          gs.fill = toRGB('rgb', op.operands.map(num))
          break
        case 'RG':
          gs.strokeSpace = 'rgb'
          gs.stroke = toRGB('rgb', op.operands.map(num))
          break
        case 'k':
          gs.fillSpace = 'cmyk'
          gs.fill = toRGB('cmyk', op.operands.map(num))
          break
        case 'K':
          gs.strokeSpace = 'cmyk'
          gs.stroke = toRGB('cmyk', op.operands.map(num))
          break
        case 'cs':
        case 'CS': {
          const name = op.operands[0]
          const kind = this.colorSpaceKind(
            name && name.type === 'name' ? name.value : '',
            source.resources
          )
          if (op.op === 'cs') gs.fillSpace = kind
          else gs.strokeSpace = kind
          break
        }
        case 'sc':
        case 'scn': {
          const comps = op.operands.filter((o) => o.type === 'number').map(num)
          if (comps.length) gs.fill = toRGB(gs.fillSpace, comps)
          else if (gs.fillSpace === 'unknown') gs.fill = null // a pattern
          break
        }
        case 'SC':
        case 'SCN': {
          const comps = op.operands.filter((o) => o.type === 'number').map(num)
          if (comps.length) gs.stroke = toRGB(gs.strokeSpace, comps)
          else if (gs.strokeSpace === 'unknown') gs.stroke = null
          break
        }
        case 'w':
          gs.lineWidth = num(op.operands[0])
          break

        /* --- marked content --- */
        case 'BDC': {
          const props = op.operands[1]
          let actual: string | null = null
          if (props && props.type === 'dict') {
            const at = props.entries.get('ActualText')
            if (at && at.type === 'string') actual = decodeTextString(at.bytes)
          } else if (props && props.type === 'name') {
            const properties = dictDict(this.context, source.resources, 'Properties')
            const entry = properties ? dictDict(this.context, properties, props.value) : undefined
            const at = entry ? dictGet(this.context, entry, 'ActualText') : undefined
            if (at) {
              const bytes = (at as unknown as { asBytes?: () => Uint8Array }).asBytes?.()
              if (bytes) actual = decodeTextString(bytes)
            }
          }
          markedText.push(actual ?? markedText[markedText.length - 1] ?? '')
          break
        }
        case 'BMC':
          markedText.push(markedText[markedText.length - 1] ?? '')
          break
        case 'EMC':
          markedText.pop()
          break

        /* --- text object --- */
        case 'BT':
          inText = true
          tm = IDENTITY
          tlm = IDENTITY
          break
        case 'ET':
          inText = false
          break

        /* --- text state --- */
        case 'Tc':
          gs.charSpacing = num(op.operands[0])
          break
        case 'Tw':
          gs.wordSpacing = num(op.operands[0])
          break
        case 'Tz':
          gs.horizScale = num(op.operands[0]) / 100
          break
        case 'TL':
          gs.leading = num(op.operands[0])
          break
        case 'Ts':
          gs.rise = num(op.operands[0])
          break
        case 'Tr':
          gs.renderMode = Math.round(num(op.operands[0]))
          break
        case 'Tf': {
          const name = op.operands[0]
          gs.fontName = name && name.type === 'name' ? name.value : null
          gs.fontSize = num(op.operands[1])
          if (gs.fontName) resolveFont(gs.fontName)
          else {
            gs.font = null
            gs.fontKey = ''
          }
          break
        }

        /* --- text positioning --- */
        case 'Td':
          tlm = mul(translation(num(op.operands[0]), num(op.operands[1])), tlm)
          tm = tlm
          break
        case 'TD':
          gs.leading = -num(op.operands[1])
          tlm = mul(translation(num(op.operands[0]), num(op.operands[1])), tlm)
          tm = tlm
          break
        case 'Tm':
          tlm = [
            num(op.operands[0]),
            num(op.operands[1]),
            num(op.operands[2]),
            num(op.operands[3]),
            num(op.operands[4]),
            num(op.operands[5]),
          ]
          tm = tlm
          break
        case 'T*':
          tlm = mul(translation(0, -gs.leading), tlm)
          tm = tlm
          break

        /* --- text showing --- */
        case 'Tj':
          if (inText) show(op, 'Tj', op.operands.slice(-1), null)
          break
        case 'TJ': {
          if (!inText) break
          const arr = op.operands[op.operands.length - 1]
          show(op, 'TJ', arr && arr.type === 'array' ? arr.items : [], null)
          break
        }
        case "'": {
          if (!inText) break
          tlm = mul(translation(0, -gs.leading), tlm)
          tm = tlm
          show(op, "'", op.operands.slice(-1), {
            wordSpacing: gs.wordSpacing,
            charSpacing: gs.charSpacing,
          })
          break
        }
        case '"': {
          if (!inText) break
          gs.wordSpacing = num(op.operands[0])
          gs.charSpacing = num(op.operands[1])
          tlm = mul(translation(0, -gs.leading), tlm)
          tm = tlm
          show(op, '"', op.operands.slice(-1), {
            wordSpacing: gs.wordSpacing,
            charSpacing: gs.charSpacing,
          })
          break
        }

        /* --- XObjects --- */
        case 'Do': {
          const name = op.operands[0]
          if (!name || name.type !== 'name') break
          this.enterXObject(name.value, source, gs, pageIndex, depth)
          break
        }

        default:
          break
      }
    }

    this.activeStreams.delete(source.key)
  }

  /**
   * Work out how to interpret `sc`/`scn` operands for a named colour space,
   * resolving it through the resource dictionary when it is not a device space.
   */
  private colorSpaceKind(name: string, resources: PDFDict | undefined, depth = 0): ColorSpaceKind {
    switch (name) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return 'gray'
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
      case 'Lab':
        return 'rgb'
      case 'DeviceCMYK':
      case 'CMYK':
        return 'cmyk'
      case 'Pattern':
        return 'unknown'
    }
    if (depth > 4 || !name) return 'unknown'

    const spaces = dictDict(this.context, resources, 'ColorSpace')
    const entry = spaces ? dictGet(this.context, spaces, name) : undefined
    if (!entry) return 'unknown'

    const asNameValue = asName(entry)
    if (asNameValue) return this.colorSpaceKind(asNameValue, resources, depth + 1)

    const arr = entry instanceof PDFArray ? entry : undefined
    if (!arr || arr.size() === 0) return 'unknown'
    const items = elementsOf(this.context, arr)
    const family = asName(items[0])
    switch (family) {
      case 'ICCBased': {
        const streamDict = asDict(items[1])
        const n = streamDict ? dictNumber(this.context, streamDict, 'N') : undefined
        return n === 1 ? 'gray' : n === 4 ? 'cmyk' : n === 3 ? 'rgb' : 'unknown'
      }
      case 'Separation':
      case 'DeviceN':
        return 'tint'
      case 'CalGray':
        return 'gray'
      case 'CalRGB':
      case 'Lab':
        return 'rgb'
      case 'DeviceGray':
      case 'DeviceRGB':
      case 'DeviceCMYK':
        return this.colorSpaceKind(family, resources, depth + 1)
      default:
        // Indexed and Pattern need data we do not carry; guessing a colour is
        // worse than admitting we do not know.
        return 'unknown'
    }
  }

  private enterXObject(
    name: string,
    parent: StreamSource,
    gs: GState,
    pageIndex: number,
    depth: number
  ): void {
    const xobjects = dictDict(this.context, parent.resources, 'XObject')
    if (!xobjects) return
    const raw = xobjects.get(PDFName.of(name))
    const resolved = raw instanceof PDFRef ? this.context.lookup(raw) : raw
    const dict = asDict(resolved as PDFObject | undefined)
    if (!dict) return
    if (dictName(this.context, dict, 'Subtype') !== 'Form') return

    const bytes = streamBytes(resolved as PDFObject)
    if (!bytes) return

    const key = raw instanceof PDFRef ? `xobj:${raw.tag}` : `xobj:${parent.key}:${name}`
    if (raw instanceof PDFRef) {
      this.xobjectUses.push({ key, ref: raw, pageIndex })
    }

    const matrixNums = numbersFrom(this.context, dictArray(this.context, dict, 'Matrix'))
    const matrix: Matrix =
      matrixNums.length === 6 && matrixNums.every((n) => typeof n === 'number')
        ? (matrixNums as [number, number, number, number, number, number])
        : IDENTITY

    const ownResources = dictDict(this.context, dict, 'Resources') ?? parent.resources

    this.execute(
      { key, bytes, resources: ownResources },
      mul(matrix, gs.ctm),
      pageIndex,
      depth + 1,
      gs
    )
  }

  /**
   * A show operator can be deleted outright when the next operator that
   * reassigns `Tm` does so unconditionally — then nothing downstream depends on
   * the advance it produced, so no compensation is needed (see §7.5 of the
   * operator reference). Otherwise the rewriter must emit a compensating
   * displacement.
   */
  private markSafeDeletes(): void {
    const byStream = new Map<string, TextRun[]>()
    for (const run of this.runs) {
      const list = byStream.get(run.streamKey)
      if (list) list.push(run)
      else byStream.set(run.streamKey, [run])
    }

    for (const [key, runs] of byStream) {
      const source = this.streams.get(key)
      if (!source) continue
      const ops = [...new ContentLexer(source.bytes).operations()]
      const indexByStart = new Map<number, number>()
      ops.forEach((op, i) => indexByStart.set(op.start, i))

      for (const run of runs) {
        const at = indexByStart.get(run.start)
        if (at === undefined) continue
        let safe = false
        for (let i = at + 1; i < ops.length; i++) {
          const name = ops[i].op
          if (
            name === 'Td' || name === 'TD' || name === 'Tm' || name === 'T*' ||
            name === 'ET' || name === 'BT' || name === "'" || name === '"'
          ) {
            safe = true
            break
          }
          if (name === 'Tj' || name === 'TJ') break
        }
        run.safeDelete = safe
      }
    }
  }
}

/** Decode a PDF text string (UTF-16BE with BOM, else PDFDocEncoding-ish). */
function decodeTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    return out
  }
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}
