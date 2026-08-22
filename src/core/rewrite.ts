/**
 * Content-stream surgery.
 *
 * Two things happen when a line is edited:
 *
 *  1. Every original show operator belonging to the line is **neutralised in
 *     place**, byte-exactly, inside the stream it came from. The glyphs are
 *     genuinely removed, so the old text no longer renders, no longer copies
 *     out, and no longer shows up in a text search — unlike the "cover it with
 *     a white rectangle" approach, which leaves the original text in the file
 *     and fails outright on non-white backgrounds.
 *
 *  2. The replacement text is drawn by a self-contained block appended to the
 *     page's content stream, wrapped in `q … Q` and carrying an explicit `cm`
 *     and `Tm`. Because it never runs inside an original text object, it cannot
 *     disturb the surrounding text state — which is the failure mode that makes
 *     naive in-place replacement corrupt the rest of the page.
 *
 * Neutralisation follows ISO 32000-1 §9.4.4. `Tj`/`TJ` are the only operators
 * that write `Tm` without writing `Tlm`, so the only exact in-band replacement
 * for a show operator is another show operator: a `[ N ] TJ` carrying the same
 * displacement and no glyphs.
 */
import { formatNumber, type Matrix } from './matrix'
import type { RGB, TextRun } from './model'
import { bytesToLatin1, latin1ToBytes, toHexString } from './lexer'

export type NeutralizeMode = 'delete' | 'adjust' | 'invisible'

export interface Neutralization {
  bytes: Uint8Array
  mode: NeutralizeMode
}

/**
 * Replacement bytes for one show operator's span such that the text state
 * afterwards is exactly what it would have been.
 */
export function neutralizeRun(run: TextRun): Neutralization {
  // The invisible fallback keeps the original operator, so it still performs
  // the `'` / `"` side effects itself. Re-emitting them there would apply the
  // line advance twice and push the rest of the text object down by a leading.
  if (!canCompensate(run)) return hideRun(run)

  const parts: string[] = []

  // `'` and `"` are shorthands with persistent side effects. Where the operator
  // is being removed, lower it into primitives and keep those side effects;
  // only the show itself goes.
  if (run.op === "'") {
    parts.push('T*')
  } else if (run.op === '"' && run.quote) {
    parts.push(`${formatNumber(run.quote.wordSpacing)} Tw`)
    parts.push(`${formatNumber(run.quote.charSpacing)} Tc`)
    parts.push('T*')
  }

  if (run.safeDelete) {
    return { bytes: latin1ToBytes(parts.join(' ')), mode: 'delete' }
  }

  // N = -1000*Sum(w0) - 1000*n*Tc/Tfs - 1000*n32*Tw/Tfs + Sum(Nj)
  // with Sum(w0) expressed in 1/1000 units, i.e. Sum(glyph.width).
  const sumWidths = run.glyphs.reduce((a, g) => a + g.width, 0)
  const n = run.glyphs.length
  const n32 = run.glyphs.reduce((a, g) => a + (g.byteLen === 1 && g.code === 32 ? 1 : 0), 0)
  const N =
    -sumWidths -
    (1000 * n * run.charSpacing) / run.fontSize -
    (1000 * n32 * run.wordSpacing) / run.fontSize +
    run.tjAdjustment
  parts.push(`[ ${formatNumber(round6(N))} ] TJ`)
  return { bytes: latin1ToBytes(parts.join(' ')), mode: 'adjust' }
}

/** Whether the run's displacement can be reproduced by a `[ N ] TJ`. */
function canCompensate(run: TextRun): boolean {
  return run.safeDelete || (run.fontSize !== 0 && run.glyphs.length > 0)
}

/**
 * Last resort: keep the operator but render it invisibly. Exact by
 * construction, because the operator still executes and so still produces every
 * side effect and displacement itself — which is precisely why no lowered `T*`
 * or `Tw`/`Tc` may be emitted alongside it.
 *
 * Clipping modes map to 7 rather than 3, or the text's contribution to the
 * clipping path silently disappears and changes everything after `ET`.
 */
function hideRun(run: TextRun): Neutralization {
  const hidden = run.renderMode >= 4 ? 7 : 3
  const original = run.originalBytes ?? new Uint8Array(0)
  const head = latin1ToBytes(`${hidden} Tr `)
  const tail = latin1ToBytes(` ${run.renderMode} Tr`)
  const bytes = new Uint8Array(head.length + original.length + tail.length)
  bytes.set(head, 0)
  bytes.set(original, head.length)
  bytes.set(tail, head.length + original.length)
  return { bytes, mode: 'invisible' }
}

function round6(n: number): number {
  return Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6
}

/* ------------------------------------------------------------------ */
/* Drawing the replacement text                                        */
/* ------------------------------------------------------------------ */

/** One run of new text sharing a font, size and colour. */
export interface DrawSegment {
  /** Resource name of the font to use, as it appears in `/Resources /Font`. */
  fontResource: string
  fontSize: number
  fill: RGB | null
  /** Already-encoded bytes in the target font's own encoding. */
  bytes: Uint8Array
  /** Advance width of `bytes` in 1/1000 text-space units, glyphs only. */
  width1000: number
  /** Glyph count, needed to account for character spacing. */
  glyphCount: number
  /** Count of single-byte code 32, which is what word spacing applies to. */
  spaceCount: number
}

export interface DrawBlockOptions {
  /** Raw user-space CTM to reproduce (from the anchor run). */
  ctm: Matrix
  /** Text matrix placing the pen at the line's baseline start. */
  textMatrix: Matrix
  /** Horizontal scaling as a ratio; 1 unless the line is being condensed. */
  horizScale: number
  /** Character spacing the original line was drawn with. */
  charSpacing: number
  /** Word spacing the original line was drawn with. */
  wordSpacing: number
  rise: number
  renderMode: number
  /** Stroke colour and width, which show through in render modes 1 and 2. */
  stroke?: RGB | null
  lineWidth?: number
  segments: DrawSegment[]
  /** Extra x offset in text space, used to re-anchor centre/right lines. */
  offsetX: number
}

/**
 * Build a self-contained drawing block. Each segment is positioned with its own
 * explicit `Tm` rather than relying on the previous segment's advance, so a
 * width miscalculation can never cascade along the line.
 */
export function buildDrawBlock(options: DrawBlockOptions): string {
  const {
    ctm,
    textMatrix,
    horizScale,
    charSpacing,
    wordSpacing,
    rise,
    renderMode,
    stroke,
    lineWidth,
    segments,
    offsetX,
  } = options
  if (segments.length === 0) return ''

  const out: string[] = []
  out.push('q')
  out.push(`${ctm.map(formatNumber).join(' ')} cm`)
  out.push('BT')
  // Reproduce the text state the line was drawn with, rather than inheriting
  // whatever is ambient. Pinning these to zero would visibly narrow any line
  // originally set with letter or word spacing.
  out.push(`${formatNumber(charSpacing)} Tc`)
  out.push(`${formatNumber(wordSpacing)} Tw`)
  out.push(`${formatNumber(horizScale * 100)} Tz`)
  if (rise !== 0) out.push(`${formatNumber(rise)} Ts`)
  if (renderMode !== 0) out.push(`${formatNumber(renderMode)} Tr`)
  // Render modes 1 and 2 stroke the glyphs, so the pen matters too.
  if (renderMode === 1 || renderMode === 2) {
    if (stroke) {
      out.push(
        `${formatNumber(stroke.r)} ${formatNumber(stroke.g)} ${formatNumber(stroke.b)} RG`
      )
    }
    if (lineWidth !== undefined) out.push(`${formatNumber(lineWidth)} w`)
  }

  let cursor = offsetX
  let lastFill: string | null = null
  for (const seg of segments) {
    if (seg.bytes.length === 0) continue
    if (seg.fill) {
      const fill = `${formatNumber(seg.fill.r)} ${formatNumber(seg.fill.g)} ${formatNumber(seg.fill.b)} rg`
      if (fill !== lastFill) {
        out.push(fill)
        lastFill = fill
      }
    }
    out.push(`/${escapeName(seg.fontResource)} ${formatNumber(seg.fontSize)} Tf`)
    const placed: Matrix = [
      textMatrix[0],
      textMatrix[1],
      textMatrix[2],
      textMatrix[3],
      textMatrix[4] + cursor * textMatrix[0],
      textMatrix[5] + cursor * textMatrix[1],
    ]
    out.push(`${placed.map(formatNumber).join(' ')} Tm`)
    out.push(`${toHexString(seg.bytes)} Tj`)
    cursor += segmentAdvance(seg, horizScale, charSpacing, wordSpacing)
  }

  out.push('ET')
  out.push('Q')
  return out.join('\n')
}

/**
 * Advance of one segment in text space, matching ISO 32000-1 §9.4.4:
 * `((w0 - Tj/1000) * Tfs + Tc + Tw) * Th`, summed over its glyphs.
 */
function segmentAdvance(
  seg: DrawSegment,
  horizScale: number,
  charSpacing: number,
  wordSpacing: number
): number {
  const glyphs = (seg.width1000 / 1000) * seg.fontSize
  return (glyphs + seg.glyphCount * charSpacing + seg.spaceCount * wordSpacing) * horizScale
}

/** Total advance of a set of segments in text space. */
export function segmentsWidth(
  segments: DrawSegment[],
  horizScale: number,
  charSpacing = 0,
  wordSpacing = 0
): number {
  let w = 0
  for (const seg of segments) w += segmentAdvance(seg, horizScale, charSpacing, wordSpacing)
  return w
}

/** PDF name escaping: anything outside the regular range becomes `#xx`. */
export function escapeName(name: string): string {
  let out = ''
  for (const ch of name) {
    const c = ch.charCodeAt(0)
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) {
      out += '#' + c.toString(16).padStart(2, '0').toUpperCase()
    } else {
      out += ch
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Applying patches to a stream                                        */
/* ------------------------------------------------------------------ */

export interface Replacement {
  start: number
  end: number
  bytes: Uint8Array
}

/**
 * Splice replacements into a buffer. Overlapping replacements are a
 * programming error and throw rather than silently corrupting the stream.
 */
export function applyReplacements(source: Uint8Array, replacements: Replacement[]): Uint8Array {
  if (replacements.length === 0) return source
  // The same span can legitimately be submitted twice when one stream is drawn
  // more than once. Collapse byte-identical duplicates; anything else that
  // overlaps is a genuine conflict and is caught below.
  const seen = new Set<string>()
  const deduped = replacements.filter((r) => {
    const key = `${r.start}:${r.end}:${bytesToLatin1(r.bytes)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const sorted = [...deduped].sort((a, b) => a.start - b.start)
  let size = source.length
  let previousEnd = -1
  for (const r of sorted) {
    if (r.start < previousEnd) {
      throw new Error(`overlapping content-stream replacement at ${r.start}`)
    }
    if (r.start < 0 || r.end > source.length || r.end < r.start) {
      throw new Error(`replacement out of range: ${r.start}..${r.end}`)
    }
    previousEnd = r.end
    size += r.bytes.length - (r.end - r.start)
  }

  const out = new Uint8Array(size)
  let read = 0
  let write = 0
  for (const r of sorted) {
    out.set(source.subarray(read, r.start), write)
    write += r.start - read
    out.set(r.bytes, write)
    write += r.bytes.length
    read = r.end
  }
  out.set(source.subarray(read), write)
  return out
}

/**
 * Wrap a rewritten stream so that unbalanced `q` or a leftover clipping path in
 * the original content cannot affect anything appended after it.
 */
export function wrapAndAppend(original: Uint8Array, appended: string): Uint8Array {
  const head = latin1ToBytes('q\n')
  const mid = latin1ToBytes('\nQ\n')
  const tail = latin1ToBytes(appended ? appended + '\n' : '')
  const out = new Uint8Array(head.length + original.length + mid.length + tail.length)
  let at = 0
  out.set(head, at); at += head.length
  out.set(original, at); at += original.length
  out.set(mid, at); at += mid.length
  out.set(tail, at)
  return out
}
