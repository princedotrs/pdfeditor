/**
 * Reading a PDF font dictionary well enough to (a) measure every glyph it can
 * draw and (b) turn edited Unicode text back into the byte codes that *this*
 * font uses. (b) is what lets an edit keep the document's original typeface
 * instead of substituting one — the difference between an edit you can see and
 * one you cannot.
 *
 * References: ISO 32000-1 §9.5-9.10, Adobe TN #5098 (glyph names).
 */
import { PDFArray, PDFDict, PDFName, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib'
import { CMap, parseCMap, predefinedCMap } from './cmap'
import {
  classifyFont,
  encodingToUnicode,
  glyphNameToUnicode,
  isSubsetFont,
  namedEncoding,
  standard14BuiltinEncoding,
  standard14WidthLookup,
  toStandard14,
  type FontStyle,
  type Standard14,
} from './encoding'
import { encodingTables } from './encoding'
import type { Glyph } from './model'
import {
  asName,
  asNumber,
  dictArray,
  dictDict,
  dictGet,
  dictName,
  dictNumber,
  elementsOf,
  numbersFrom,
  resolve,
  streamBytes,
} from './pdfutil'

/** Result of turning a Unicode string back into this font's byte codes. */
export interface EncodedText {
  ok: boolean
  bytes: Uint8Array
  /** Width of each emitted code, in 1/1000 text-space units. */
  widths: number[]
  /** Sum of `widths`. */
  totalWidth: number
  /** Emitted codes equal to single-byte 32 — these are what `Tw` applies to. */
  wordSpaceCount: number
  glyphCount: number
  unmapped: { index: number; char: string }[]
  warnings: string[]
}

interface ReverseEntry {
  bytes: Uint8Array
  code: number
  byteLen: number
  /** 0 = ToUnicode (authoritative), 1 = encoding/AGL, 2 = predefined CMap. */
  rank: number
}

/** Typographic folds tried before declaring a character unencodable. */
const FOLDS: Array<[RegExp, string]> = [
  [/ /g, ' '],
  [/[‐‑‒–—−]/g, '-'],
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/…/g, '...'],
  [/[­​﻿‌‍]/g, ''],
  [/⁄/g, '/'],
  [/[ -   　]/g, ' '],
]

/** Ligature codepoints we are willing to *use* when re-encoding. */
const LIGATURES = new Set([
  'ﬀ', 'ﬁ', 'ﬂ', 'ﬃ', 'ﬄ', 'ﬅ', 'ﬆ',
  'Ĳ', 'ĳ', 'Œ', 'œ', 'Æ', 'æ',
])

function isUsableMultiCharKey(key: string): boolean {
  if (key.length === 1) return true
  if (key.length > 4) return false
  // Only accept multi-character keys that look like a ligature spelled out,
  // never things like "(c)" or a whole word that some producers emit.
  return [...key].every((ch) => /\p{L}/u.test(ch))
}

/**
 * Widths keyed by CID for a composite font.
 *
 * `/W` may cover the same CID more than once, mixing the `c [w …]` and
 * `cFirst cLast w` forms, and the *last* entry in array order wins. Each entry
 * therefore carries the position it was read at, so a range written after a
 * single overrides it rather than the other way round.
 */
class CidWidths {
  private readonly singles = new Map<number, { w: number; seq: number }>()
  private readonly ranges: Array<{ first: number; last: number; w: number; seq: number }> = []
  private seq = 0

  constructor(readonly defaultWidth: number) {}

  addSingle(cid: number, w: number): void {
    this.singles.set(cid, { w, seq: this.seq++ })
  }

  addRange(first: number, last: number, w: number): void {
    this.ranges.push({ first, last, w, seq: this.seq++ })
  }

  get(cid: number): number {
    const single = this.singles.get(cid)
    // Ranges are appended in order, so the last one containing `cid` is the
    // highest-priority range; only the single can still outrank it.
    for (let i = this.ranges.length - 1; i >= 0; i--) {
      const r = this.ranges[i]
      if (cid >= r.first && cid <= r.last) {
        return single && single.seq > r.seq ? single.w : r.w
      }
    }
    return single ? single.w : this.defaultWidth
  }

  has(cid: number): boolean {
    if (this.singles.has(cid)) return true
    return this.ranges.some((r) => cid >= r.first && cid <= r.last)
  }

  get size(): number {
    return this.singles.size + this.ranges.length
  }
}

export class PdfFont {
  readonly key: string
  readonly baseFont: string
  readonly subtype: string
  readonly isType0: boolean
  readonly isType3: boolean
  readonly vertical: boolean
  readonly symbolic: boolean
  readonly subset: boolean
  readonly style: FontStyle
  readonly standard14: Standard14 | null
  /** Multiplier from raw width entries to 1/1000 text-space units. */
  private readonly widthScale: number
  /** Type3 font matrix, used to scale glyph space. */
  readonly fontMatrix: readonly number[]

  private readonly cmap: CMap
  private readonly toUnicode: CMap | null
  /** Simple fonts: code -> glyph name. */
  private readonly encodingNames: (string | null)[] | null
  private readonly encodingUnicode: (string | null)[] | null
  private readonly firstChar: number
  private readonly simpleWidths: (number | undefined)[]
  private readonly missingWidth: number
  private readonly stdWidths: ((glyphName: string) => number | undefined) | null
  private readonly cidWidths: CidWidths | null
  /** Type3 only: the glyph names this font actually defines a procedure for. */
  private readonly charProcs: Set<string>
  /** True when the descendant font's glyphs are addressed by CID directly. */
  readonly descendantSubtype: string | null
  /** Nominal ascent/descent in em units, used for run bounding boxes. */
  readonly ascent: number
  readonly descent: number

  private spaceWidthCache: number | null = null
  private reverse: Map<string, ReverseEntry> | null = null
  private reverseMaxKey = 1
  private warned: string[] = []

  constructor(context: PDFContext, dict: PDFDict, key: string) {
    this.key = key
    this.baseFont = dictName(context, dict, 'BaseFont') ?? ''
    this.subtype = dictName(context, dict, 'Subtype') ?? ''
    this.isType0 = this.subtype === 'Type0'
    this.isType3 = this.subtype === 'Type3'
    this.subset = isSubsetFont(this.baseFont)
    this.standard14 = this.isType0 || this.isType3 ? null : toStandard14(this.baseFont)

    const descendant = this.isType0
      ? (elementsOf(context, dictArray(context, dict, 'DescendantFonts'))[0] as PDFObject | undefined)
      : undefined
    const descendantDict = descendant instanceof PDFDict ? descendant : undefined
    this.descendantSubtype = descendantDict ? (dictName(context, descendantDict, 'Subtype') ?? null) : null

    const descriptor =
      dictDict(context, dict, 'FontDescriptor') ??
      (descendantDict ? dictDict(context, descendantDict, 'FontDescriptor') : undefined)
    const flags = dictNumber(context, descriptor, 'Flags') ?? 0
    this.symbolic = (flags & 0x04) !== 0 && (flags & 0x20) === 0
    this.style = classifyFont(this.baseFont, flags)
    this.missingWidth = dictNumber(context, descriptor, 'MissingWidth') ?? 0

    // Ascent/descent drive the run bounding boxes the UI draws over the page.
    const bbox = numbersFrom(context, dictArray(context, descriptor, 'FontBBox'))
    const declaredAscent = dictNumber(context, descriptor, 'Ascent')
    const declaredDescent = dictNumber(context, descriptor, 'Descent')
    const bboxTop = bbox.length === 4 ? bbox[3] : undefined
    const bboxBottom = bbox.length === 4 ? bbox[1] : undefined
    const ascent = declaredAscent || bboxTop
    const descent = declaredDescent || bboxBottom
    this.ascent = ascent && ascent > 0 ? ascent / 1000 : 0.9
    this.descent = descent && descent < 0 ? descent / 1000 : -0.22

    // --- Type3 font matrix -------------------------------------------------
    const fm = numbersFrom(context, dictArray(context, dict, 'FontMatrix'))
    this.fontMatrix =
      this.isType3 && fm.length === 6 && fm.every((n) => typeof n === 'number')
        ? (fm as number[])
        : [0.001, 0, 0, 0.001, 0, 0]
    // Type3 widths are in glyph space; everything else is already 1/1000 em.
    this.widthScale = this.isType3 ? this.fontMatrix[0] * 1000 : 1

    // A Type3 font's repertoire is exactly its /CharProcs keys — which makes
    // "can this font draw that character" directly answerable, rather than the
    // guesswork it is for a subset TrueType.
    this.charProcs = new Set<string>()
    if (this.isType3) {
      const procs = dictDict(context, dict, 'CharProcs')
      if (procs) {
        for (const key of procs.keys()) this.charProcs.add(key.asString().replace(/^\//, ''))
      }
    }

    // --- ToUnicode ---------------------------------------------------------
    const tuBytes = streamBytes(dictGet(context, dict, 'ToUnicode'))
    this.toUnicode = tuBytes ? safeParseCMap(tuBytes) : null

    // --- Encoding ----------------------------------------------------------
    if (this.isType0) {
      this.cmap = this.readType0Encoding(context, dict)
      this.encodingNames = null
      this.encodingUnicode = null
      this.firstChar = 0
      this.simpleWidths = []
      this.stdWidths = null
      this.cidWidths = this.readCidWidths(context, descendantDict)
    } else {
      this.cmap = CMap.singleByte()
      this.encodingNames = this.readSimpleEncoding(context, dict)
      this.encodingUnicode = encodingToUnicode(
        this.encodingNames.map((n) => n ?? ''),
        this.standard14 === 'ZapfDingbats'
      )
      this.firstChar = dictNumber(context, dict, 'FirstChar') ?? 0
      this.simpleWidths = numbersFrom(context, dictArray(context, dict, 'Widths'))
      this.stdWidths = this.standard14 ? standard14WidthLookup(this.standard14) : null
      this.cidWidths = null
    }
    this.vertical = this.cmap.vertical || this.toUnicode?.vertical === true
  }

  /* ---------------------------------------------------------------- */
  /* Construction helpers                                              */
  /* ---------------------------------------------------------------- */

  private readType0Encoding(context: PDFContext, dict: PDFDict): CMap {
    const enc = dictGet(context, dict, 'Encoding')
    const name = asName(enc)
    if (name) {
      const predefined = predefinedCMap(name)
      if (predefined) return predefined
      // A named non-Identity CMap needs Adobe's resource files, which we do
      // not ship. Fall back to two-byte Identity so geometry stays sane, and
      // record why reverse encoding will not be offered.
      this.warned.push(`predefined-cmap:${name}`)
      const fallback = CMap.identityH(name.endsWith('-V'))
      return fallback
    }
    const bytes = streamBytes(enc)
    if (bytes) {
      const parsed = safeParseCMap(bytes)
      if (parsed) return parsed
    }
    return CMap.identityH()
  }

  private readCidWidths(context: PDFContext, descendant: PDFDict | undefined): CidWidths {
    const dw = descendant ? (dictNumber(context, descendant, 'DW') ?? 1000) : 1000
    const widths = new CidWidths(dw)
    const w = descendant ? dictArray(context, descendant, 'W') : undefined
    if (!w) return widths
    const items = elementsOf(context, w)
    let i = 0
    while (i < items.length) {
      const first = asNumber(items[i])
      i += 1
      if (first === undefined || i >= items.length) break
      const next = items[i]
      if (next instanceof PDFArray) {
        i += 1
        const list = numbersFrom(context, next)
        list.forEach((value, k) => {
          if (value !== undefined) widths.addSingle(first + k, value)
        })
        continue
      }
      const last = asNumber(next)
      i += 1
      if (last === undefined || i >= items.length) break
      const value = asNumber(items[i])
      i += 1
      if (value === undefined) continue
      const lo = Math.min(first, last)
      const hi = Math.min(Math.max(first, last), lo + 65535)
      widths.addRange(lo, hi, value)
    }
    return widths
  }

  /** Build the 256-entry code -> glyph name table (ISO 32000-1 §9.6.6). */
  private readSimpleEncoding(context: PDFContext, dict: PDFDict): (string | null)[] {
    const table: (string | null)[] = new Array(256).fill(null)

    const applyBase = (names: readonly string[]): void => {
      for (let i = 0; i < 256; i++) table[i] = names[i] ?? null
    }

    // Start from the font's implicit built-in encoding.
    if (this.isType3) {
      // Type3 fonts have no built-in encoding at all (ISO 32000-1 §9.6.5):
      // every glyph they can draw is named by /Differences. Seeding this with
      // StandardEncoding would invent names that /CharProcs never defines.
      applyBase(new Array(256).fill(''))
    } else if (this.standard14) {
      applyBase(standard14BuiltinEncoding(this.standard14))
    } else if (this.symbolic) {
      // A symbolic font's built-in encoding lives in the font program, which we
      // do not parse. Leave the table empty so we do not invent glyph names,
      // and rely on /Differences and /ToUnicode instead.
      applyBase(new Array(256).fill(''))
    } else {
      applyBase(encodingTables.StandardEncoding)
    }

    const enc = dictGet(context, dict, 'Encoding')
    const encName = asName(enc)
    if (encName) {
      const named = namedEncoding(encName)
      if (named) applyBase(named)
    } else if (enc instanceof PDFDict) {
      const baseName = dictName(context, enc, 'BaseEncoding')
      const base = baseName ? namedEncoding(baseName) : null
      if (base) applyBase(base)
      else if (!this.symbolic && !this.standard14) applyBase(encodingTables.StandardEncoding)

      const diffs = dictArray(context, enc, 'Differences')
      if (diffs) {
        let code = 0
        for (const item of elementsOf(context, diffs)) {
          const n = asNumber(item)
          if (n !== undefined) {
            code = Math.max(0, Math.min(255, Math.round(n)))
            continue
          }
          const glyph = asName(item)
          if (glyph !== undefined) {
            if (code >= 0 && code < 256) table[code] = glyph
            code += 1
          }
        }
      }
    }
    return table.map((n) => (n === '' ? null : n))
  }

  /* ---------------------------------------------------------------- */
  /* Measurement and decoding                                          */
  /* ---------------------------------------------------------------- */

  /** CID for a character code (equal to the code for simple fonts). */
  cidOf(code: number, byteLen: number): number {
    if (!this.isType0) return code
    return this.cmap.lookupCid(code, byteLen) ?? 0
  }

  /** Advance width in 1/1000 text-space units. */
  widthOf(code: number, byteLen: number, cid = this.cidOf(code, byteLen)): number {
    if (this.isType0) {
      return (this.cidWidths?.get(cid) ?? 1000) * this.widthScale
    }
    const index = code - this.firstChar
    if (index >= 0 && index < this.simpleWidths.length) {
      const w = this.simpleWidths[index]
      if (w !== undefined) return w * this.widthScale
    }
    if (this.stdWidths) {
      const name = this.encodingNames?.[code]
      if (name) {
        const w = this.stdWidths(name)
        if (w !== undefined) return w
      }
    }
    // /MissingWidth is a FontDescriptor entry in glyph space, so Type3 scaling
    // applies to it exactly as it does to /Widths.
    if (this.simpleWidths.length > 0 || this.missingWidth > 0) {
      return this.missingWidth * this.widthScale
    }
    // Nothing to go on. 500/1000 em keeps layout roughly sane instead of
    // collapsing every glyph to zero width.
    return 500 * this.widthScale
  }

  /** Unicode for a character code, or '' when it cannot be determined. */
  unicodeOf(code: number, byteLen: number, cid = this.cidOf(code, byteLen)): string {
    const tu = this.toUnicode?.lookupUnicode(code, byteLen)
    if (tu !== undefined && tu !== '') return tu
    if (!this.isType0) {
      const fromEncoding = this.encodingUnicode?.[code]
      if (fromEncoding) return fromEncoding
      // Only guess when the encoding names no glyph at all for this code. If it
      // names one we could not map, inventing the ASCII character for the code
      // would report text the font does not draw.
      if (!this.symbolic && !this.encodingNames?.[code] && code >= 32 && code < 127) {
        return String.fromCharCode(code)
      }
      return ''
    }
    // Type0 without /ToUnicode: CIDs are glyph indices with no textual meaning.
    void cid
    return ''
  }

  /**
   * Advance of this font's space glyph, in 1/1000 units. Used to decide when a
   * gap opened by `TJ` kerning is really a word break rather than tracking.
   */
  get spaceWidth(): number {
    if (this.spaceWidthCache !== null) return this.spaceWidthCache
    let width = 0
    const entry = this.buildReverse().get(' ')
    if (entry) width = this.widthOf(entry.code, entry.byteLen)
    if (!width && !this.isType0) width = this.widthOf(32, 1)
    if (!width || width > 1000) width = 250
    this.spaceWidthCache = width
    return width
  }

  /** Split a string operand into glyphs with positions and widths. */
  decodeString(bytes: Uint8Array): Glyph[] {
    const codes = this.cmap.decode(bytes)
    const out: Glyph[] = []
    let offset = 0
    for (const c of codes) {
      const cid = this.cidOf(c.code, c.byteLen)
      const width = this.widthOf(c.code, c.byteLen, cid)
      out.push({
        code: c.code,
        byteLen: c.byteLen,
        cid,
        unicode: this.unicodeOf(c.code, c.byteLen, cid),
        width,
        offset,
      })
      offset += width
    }
    return out
  }

  /* ---------------------------------------------------------------- */
  /* Reverse encoding: Unicode -> this font's codes                    */
  /* ---------------------------------------------------------------- */

  /**
   * True when this font is a plausible target for re-encoding edited text.
   *
   * Type3 is allowed. Its glyphs are procedures rather than outlines, so no
   * *new* glyph can be added to it — but characters it already defines can be
   * re-used freely, and `codeAttested` can prove which those are. Refusing
   * outright would lock every document set in a Type3 font, which is a large
   * class of scanned-and-vectorised and TeX-produced files.
   */
  get canReuse(): boolean {
    if (this.vertical) return false
    if (this.warned.some((w) => w.startsWith('predefined-cmap:'))) return false
    return this.buildReverse().size > 0
  }

  /** How many distinct characters this font is known to be able to draw. */
  get repertoireSize(): number {
    return this.buildReverse().size
  }

  private codeAttested(code: number, byteLen: number, cid: number): boolean {
    // Type3 is the one case where the answer is exact: a glyph exists if and
    // only if /CharProcs defines a procedure under its name.
    if (this.isType3) {
      const name = this.encodingNames?.[code]
      return !!name && this.charProcs.has(name)
    }
    // For subset fonts a mapping is not proof the glyph survived subsetting.
    // Require corroborating evidence from the width tables.
    if (!this.subset) return true
    if (this.isType0) return this.cidWidths ? this.cidWidths.has(cid) : false
    const index = code - this.firstChar
    if (index >= 0 && index < this.simpleWidths.length && this.simpleWidths[index] !== undefined) {
      return true
    }
    void byteLen
    return false
  }

  private buildReverse(): Map<string, ReverseEntry> {
    if (this.reverse) return this.reverse
    const map = new Map<string, ReverseEntry>()

    const consider = (value: string, code: number, byteLen: number, rank: number): void => {
      if (!value) return
      if (!isUsableMultiCharKey(value)) return
      if (value.length > 1 && !LIGATURES.has(value) && ![...value].every((c) => /\p{L}/u.test(c))) return
      const cid = this.cidOf(code, byteLen)
      if (this.isType0 && cid === 0 && code !== 0) return
      if (!this.codeAttested(code, byteLen, cid)) return
      const prev = map.get(value)
      const bytes = this.codeToBytes(code, byteLen)
      if (!bytes) return
      if (
        prev === undefined ||
        rank < prev.rank ||
        (rank === prev.rank && code < prev.code)
      ) {
        map.set(value, { bytes, code, byteLen, rank })
      }
    }

    if (this.toUnicode) {
      for (const e of this.toUnicode.unicodeEntries()) {
        // A simple font addresses glyphs with exactly one byte (ISO 32000-1
        // §9.6). Some producers still declare a two-byte codespace in the
        // /ToUnicode CMap; taking the byte length from there would emit two
        // bytes per character and inject .notdef glyphs into edited text.
        if (!this.isType0) {
          if (e.code > 0xff) continue
          consider(e.value, e.code, 1, 0)
        } else {
          consider(e.value, e.code, e.byteLen, 0)
        }
      }
    }
    if (!this.isType0 && this.encodingNames) {
      for (let code = 0; code < 256; code++) {
        const name = this.encodingNames[code]
        if (!name) continue
        const value = glyphNameToUnicode(name, this.standard14 === 'ZapfDingbats')
        if (value) consider(value, code, 1, 1)
      }
      // A non-symbolic simple font with no explicit encoding still draws ASCII.
      if (!this.symbolic) {
        for (let code = 32; code < 127; code++) {
          if (!this.encodingNames[code]) consider(String.fromCharCode(code), code, 1, 2)
        }
      }
    }

    this.reverse = map
    this.reverseMaxKey = 1
    for (const k of map.keys()) this.reverseMaxKey = Math.max(this.reverseMaxKey, k.length)
    return map
  }

  private codeToBytes(code: number, byteLen: number): Uint8Array | null {
    if (byteLen <= 0 || byteLen > 4) return null
    const out = new Uint8Array(byteLen)
    let v = code
    for (let i = byteLen - 1; i >= 0; i--) {
      out[i] = v & 0xff
      v = Math.floor(v / 256)
    }
    return out
  }

  /**
   * Encode `text` with this font.
   *
   * `hintCodes` are the codes the run originally used; when two codes map to
   * the same character (small caps, alternates) the original one wins, so an
   * unedited part of a line keeps rendering exactly as it did.
   */
  encode(text: string, hintCodes?: Iterable<{ code: number; byteLen: number; unicode: string }>): EncodedText {
    const map = this.buildReverse()
    const hints = new Map<string, { code: number; byteLen: number }>()
    if (hintCodes) {
      for (const h of hintCodes) {
        if (h.unicode && !hints.has(h.unicode)) hints.set(h.unicode, { code: h.code, byteLen: h.byteLen })
      }
    }

    const bytes: number[] = []
    const widths: number[] = []
    const unmapped: { index: number; char: string }[] = []
    const warnings = new Set<string>()
    let wordSpaceCount = 0

    const emit = (entry: ReverseEntry): void => {
      for (const b of entry.bytes) bytes.push(b)
      const cid = this.cidOf(entry.code, entry.byteLen)
      widths.push(this.widthOf(entry.code, entry.byteLen, cid))
      if (entry.byteLen === 1 && entry.code === 32) wordSpaceCount += 1
    }

    const lookupExact = (key: string): ReverseEntry | undefined => {
      const hint = hints.get(key)
      if (hint) {
        const cid = this.cidOf(hint.code, hint.byteLen)
        if (this.codeAttested(hint.code, hint.byteLen, cid)) {
          const hb = this.codeToBytes(hint.code, hint.byteLen)
          if (hb) return { bytes: hb, code: hint.code, byteLen: hint.byteLen, rank: 0 }
        }
      }
      return map.get(key)
    }

    let i = 0
    while (i < text.length) {
      let matched = false
      const maxLen = Math.min(this.reverseMaxKey, text.length - i)
      for (let len = maxLen; len >= 1 && !matched; len--) {
        const key = text.slice(i, i + len)
        if (len > 1 && !LIGATURES.has(key) && !map.has(key)) continue
        const entry = lookupExact(key)
        if (entry) {
          emit(entry)
          i += len
          matched = true
        }
      }
      if (matched) continue

      const ch = String.fromCodePoint(text.codePointAt(i) ?? text.charCodeAt(i))
      const alt = this.findFallback(ch, map, warnings)
      if (alt) {
        for (const entry of alt) emit(entry)
        i += ch.length
        continue
      }
      unmapped.push({ index: i, char: ch })
      i += ch.length
    }

    const totalWidth = widths.reduce((a, b) => a + b, 0)
    return {
      ok: unmapped.length === 0,
      bytes: Uint8Array.from(bytes),
      widths,
      totalWidth,
      wordSpaceCount,
      glyphCount: widths.length,
      unmapped,
      warnings: [...warnings],
    }
  }

  /** Fallbacks tried before a character is declared unencodable. */
  private findFallback(
    ch: string,
    map: Map<string, ReverseEntry>,
    warnings: Set<string>
  ): ReverseEntry[] | null {
    const tryKey = (key: string): ReverseEntry | undefined => map.get(key)

    for (const form of ['NFC', 'NFD'] as const) {
      let normalized: string
      try {
        normalized = ch.normalize(form)
      } catch {
        continue
      }
      if (normalized === ch) continue
      const direct = tryKey(normalized)
      if (direct) {
        warnings.add(`normalized:${form}`)
        return [direct]
      }
      if (normalized.length > 1) {
        const parts = [...normalized].map((c) => tryKey(c))
        if (parts.every(Boolean)) {
          warnings.add(`normalized:${form}`)
          return parts as ReverseEntry[]
        }
      }
    }

    let folded = ch
    for (const [re, to] of FOLDS) folded = folded.replace(re, to)
    if (folded !== ch) {
      if (folded === '') {
        warnings.add('dropped-invisible')
        return []
      }
      const parts = [...folded].map((c) => tryKey(c))
      if (parts.every(Boolean)) {
        warnings.add(`substituted:${ch}->${folded}`)
        return parts as ReverseEntry[]
      }
    }

    // A ligature the font lacks can be spelled out from its parts.
    if (LIGATURES.has(ch)) {
      const expanded = ch.normalize('NFKD')
      const parts = [...expanded].map((c) => tryKey(c))
      if (expanded !== ch && parts.every(Boolean)) {
        warnings.add('ligature-expanded')
        return parts as ReverseEntry[]
      }
    }
    return null
  }

  /** Diagnostics surfaced to the UI. */
  get issues(): string[] {
    return [...this.warned]
  }
}

function safeParseCMap(bytes: Uint8Array): CMap | null {
  try {
    return parseCMap(bytes)
  } catch {
    return null
  }
}

/** Cache of parsed fonts, keyed by the font dict's object identity. */
export class FontCache {
  private readonly byKey = new Map<string, PdfFont>()

  constructor(private readonly context: PDFContext) {}

  get(dict: PDFDict, key: string): PdfFont {
    const existing = this.byKey.get(key)
    if (existing) return existing
    const font = new PdfFont(this.context, dict, key)
    this.byKey.set(key, font)
    return font
  }

  /** Resolve a font that is referenced directly, e.g. from an ExtGState. */
  fromRef(ref: PDFRef): PdfFont | null {
    const resolved = resolve(this.context, ref)
    const dict = resolved instanceof PDFDict ? resolved : undefined
    if (!dict) return null
    return this.get(dict, ref.tag)
  }

  /** Resolve a `/Font` resource name within a resource dictionary. */
  fromResources(resources: PDFDict | undefined, name: string): { font: PdfFont; key: string } | null {
    if (!resources) return null
    const fonts = dictDict(this.context, resources, 'Font')
    if (!fonts) return null
    const raw = fonts.get(PDFName.of(name))
    const resolved = resolve(this.context, raw)
    const dict = resolved instanceof PDFDict ? resolved : undefined
    if (!dict) return null
    const key = raw && 'tag' in raw ? String((raw as { tag: string }).tag) : `inline:${name}:${dict.keys().length}`
    return { font: this.get(dict, key), key }
  }
}
