/**
 * Simple-font encodings and the Adobe Glyph List algorithm (ISO 32000-1 §9.6.6,
 * Annex D, and Adobe TN #5098).
 *
 * The encoding tables, the glyph list and the standard-14 metrics are vendored
 * verbatim from pdf.js (Apache-2.0) — see `vendor/`. Reimplementing 4300 glyph
 * names by hand would be strictly worse than reusing the reference tables.
 */
import {
  ExpertEncoding,
  MacRomanEncoding,
  StandardEncoding,
  SymbolSetEncoding,
  WinAnsiEncoding,
  ZapfDingbatsEncoding,
  getEncoding,
} from './vendor/encodings.js'
import { getDingbatsGlyphsUnicode, getGlyphsUnicode } from './vendor/glyphlist.js'
import { getMetrics } from './vendor/metrics.js'

export const encodingTables = {
  StandardEncoding,
  WinAnsiEncoding,
  MacRomanEncoding,
  ExpertEncoding,
  SymbolSetEncoding,
  ZapfDingbatsEncoding,
} as const

let glyphList: Record<string, number> | null = null
let dingbatsList: Record<string, number> | null = null

function agl(): Record<string, number> {
  if (!glyphList) glyphList = getGlyphsUnicode()
  return glyphList
}

function dingbats(): Record<string, number> {
  if (!dingbatsList) dingbatsList = getDingbatsGlyphsUnicode()
  return dingbatsList
}

const UNI_RE = /^uni([0-9A-Fa-f]{4})+$/
const U_RE = /^u([0-9A-Fa-f]{4,6})$/
/** Glyph names that only encode a glyph index carry no Unicode meaning. */
const INDEX_RE = /^(?:g|glyph|cid|c|G|index)\d+$/

/**
 * Map a glyph name to the Unicode it stands for, or `null` when the name
 * carries no recoverable meaning (`.notdef`, bare glyph indices, …).
 */
export function glyphNameToUnicode(name: string, dingbatFont = false): string | null {
  if (!name) return null
  if (name === '.notdef' || name === '.null' || name === 'nonmarkingreturn') return null

  const table = dingbatFont ? dingbats() : agl()
  // An exact hit wins before any rewriting — some legitimate names contain a
  // period (e.g. `a.sc` is a variant, but `.notdef` was already excluded).
  const direct = table[name]
  if (direct !== undefined) return String.fromCodePoint(direct)

  // Strip variant suffixes: `one.oldstyle` -> `one`, `a.sc` -> `a`.
  const base = name.split('.')[0]
  if (!base) return null

  let out = ''
  for (const part of base.split('_')) {
    if (!part) continue
    const known = table[part]
    if (known !== undefined) {
      out += String.fromCodePoint(known)
      continue
    }
    const uni = UNI_RE.exec(part)
    if (uni) {
      for (let i = 3; i + 4 <= part.length; i += 4) {
        out += String.fromCharCode(parseInt(part.slice(i, i + 4), 16))
      }
      continue
    }
    const u = U_RE.exec(part)
    if (u) {
      const cp = parseInt(u[1], 16)
      if (cp <= 0x10ffff) out += String.fromCodePoint(cp)
      continue
    }
    if (INDEX_RE.test(part)) return null
    // A single ASCII character used as its own glyph name.
    if (part.length === 1) {
      out += part
      continue
    }
    return null
  }
  return out === '' ? null : out
}

/** Build a Unicode string -> glyph name index over a whole encoding table. */
export function encodingToUnicode(encoding: readonly string[], dingbatFont = false): (string | null)[] {
  const out: (string | null)[] = new Array(256).fill(null)
  for (let i = 0; i < 256; i++) {
    const name = encoding[i]
    out[i] = name ? glyphNameToUnicode(name, dingbatFont) : null
  }
  return out
}

export function namedEncoding(name: string): readonly string[] | null {
  switch (name) {
    case 'WinAnsiEncoding':
      return WinAnsiEncoding
    case 'MacRomanEncoding':
      return MacRomanEncoding
    case 'MacExpertEncoding':
      // pdf.js exposes this one only through getEncoding().
      return getEncoding('MacExpertEncoding')
    case 'ExpertEncoding':
      return ExpertEncoding
    case 'StandardEncoding':
      return StandardEncoding
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Standard 14 metrics                                                 */
/* ------------------------------------------------------------------ */

/**
 * The 14 standard fonts a PDF may reference without embedding. Their metrics
 * come from the AFM files, which is why a `/Widths`-less font dict is still
 * measurable.
 */
export const STANDARD_14 = [
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Symbol',
  'ZapfDingbats',
] as const

export type Standard14 = (typeof STANDARD_14)[number]

/** Aliases producers actually emit for the standard 14. */
const STD_ALIASES: Record<string, Standard14> = {
  Arial: 'Helvetica',
  'Arial-Bold': 'Helvetica-Bold',
  'Arial,Bold': 'Helvetica-Bold',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-Italic': 'Helvetica-Oblique',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-BoldItalic': 'Helvetica-BoldOblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  ArialMT: 'Helvetica',
  ArialUnicodeMS: 'Helvetica',
  CourierNew: 'Courier',
  'CourierNew-Bold': 'Courier-Bold',
  'CourierNew-Italic': 'Courier-Oblique',
  'CourierNew-BoldItalic': 'Courier-BoldOblique',
  CourierNewPSMT: 'Courier',
  'CourierNewPS-BoldMT': 'Courier-Bold',
  'CourierNewPS-ItalicMT': 'Courier-Oblique',
  Helvetica: 'Helvetica',
  TimesNewRoman: 'Times-Roman',
  'TimesNewRoman-Bold': 'Times-Bold',
  'TimesNewRoman-Italic': 'Times-Italic',
  'TimesNewRoman-BoldItalic': 'Times-BoldItalic',
  TimesNewRomanPSMT: 'Times-Roman',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  Times: 'Times-Roman',
  'Times-Roman': 'Times-Roman',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
}

/** Strip a subset tag such as `ABCDEF+` from a BaseFont name. */
export function stripSubsetTag(baseFont: string): string {
  return /^[A-Z]{6}\+/.test(baseFont) ? baseFont.slice(7) : baseFont
}

export function isSubsetFont(baseFont: string): boolean {
  return /^[A-Z]{6}\+/.test(baseFont)
}

/** Resolve a BaseFont name to one of the standard 14, if it is one. */
export function toStandard14(baseFont: string): Standard14 | null {
  const name = stripSubsetTag(baseFont)
  if ((STANDARD_14 as readonly string[]).includes(name)) return name as Standard14
  const direct = STD_ALIASES[name]
  if (direct) return direct
  const compact = name.replace(/[\s,_]/g, '')
  return STD_ALIASES[compact] ?? null
}

type Metric = number | Record<string, number>

let metricsCache: Record<string, Metric> | null = null

function allMetrics(): Record<string, Metric> {
  if (!metricsCache) {
    const raw = getMetrics()
    metricsCache = {}
    for (const [key, value] of Object.entries(raw)) {
      // Monospaced faces (the Courier family) are stored as a single width
      // rather than a per-glyph table.
      metricsCache[key] = typeof value === 'function' ? value() : value
    }
  }
  return metricsCache
}

/**
 * Glyph-name -> width (1/1000 em) lookup for one of the standard 14 fonts.
 *
 * Returns a function rather than a table because the monospaced faces are
 * recorded as one constant width for every glyph; treating that number as a
 * table silently yields `undefined` for every lookup, which is how Courier
 * ends up measured with a made-up default.
 */
export function standard14WidthLookup(font: Standard14): (glyphName: string) => number | undefined {
  const entry = allMetrics()[font]
  if (typeof entry === 'number') return () => entry
  if (!entry) return () => undefined
  return (glyphName: string) => entry[glyphName]
}

/**
 * The encoding a standard-14 font uses when its dict declares none.
 * Symbol and ZapfDingbats have their own built-in encodings.
 */
export function standard14BuiltinEncoding(font: Standard14): readonly string[] {
  if (font === 'Symbol') return SymbolSetEncoding
  if (font === 'ZapfDingbats') return ZapfDingbatsEncoding
  return StandardEncoding
}

/* ------------------------------------------------------------------ */
/* Family classification, used for the on-screen overlay and fallbacks  */
/* ------------------------------------------------------------------ */

export interface FontStyle {
  family: string
  serif: boolean
  monospace: boolean
  bold: boolean
  italic: boolean
}

const BOLD_RE = /bold|black|heavy|semibold|demibold|[-,_]bd\b/i
const ITALIC_RE = /italic|oblique|[-,_]it\b/i
const SERIF_RE = /times|georgia|garamond|book|serif|roman|minion|cambria|palatino|century|caslon|baskerville|didot|utopia|charter/i
const MONO_RE = /courier|mono|consolas|menlo|inconsolata|typewriter/i

/** Best-effort classification of a font from its name and descriptor flags. */
export function classifyFont(baseFont: string, flags = 0): FontStyle {
  const name = stripSubsetTag(baseFont)
  const family = name.split(/[-,]/)[0] || name
  const FLAG_SERIF = 1 << 1
  const FLAG_FIXED = 1 << 0
  const FLAG_ITALIC = 1 << 6
  const FLAG_FORCE_BOLD = 1 << 18
  return {
    family,
    serif: SERIF_RE.test(name) || (flags & FLAG_SERIF) !== 0,
    monospace: MONO_RE.test(name) || (flags & FLAG_FIXED) !== 0,
    bold: BOLD_RE.test(name) || (flags & FLAG_FORCE_BOLD) !== 0,
    italic: ITALIC_RE.test(name) || (flags & FLAG_ITALIC) !== 0,
  }
}
