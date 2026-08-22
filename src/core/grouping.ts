/**
 * Grouping show operators into editable lines.
 *
 * A line is the unit of editing because it is what the content stream actually
 * hands us. Grouping further into paragraphs requires guessing, and a wrong
 * guess is worse than no guess: edit one cell of a table and the whole table
 * reflows. Lines stay predictable.
 *
 * Runs are only ever grouped when they share a stream, a CTM and a baseline —
 * which is also what the rewriter needs in order to lay the replacement text
 * out in a single coordinate space.
 */
import type { PdfFont } from './font'
import { rectFromPoints, unionRect, type Rect } from './matrix'
import type { PageInfo, RunBlocker, TextLine, TextRun } from './model'

/**
 * Runs closer than this fraction of an em across the baseline join a line.
 * Generous enough to keep superscripts and subscripts (which shift the
 * baseline via `Ts`) attached, but well under normal line leading.
 */
const BASELINE_TOLERANCE = 0.45
/** A horizontal gap wider than this many ems starts a new line. */
const MAX_GAP_EM = 2.5
/** Font sizes differing by more than this ratio do not share a line. */
const SIZE_RATIO = 2.5
/**
 * How far a run may start *before* the previous one ended and still join it.
 * Kerning and tight typography can overlap slightly; a run that restarts near
 * the previous run's origin is a fake-bold or drop-shadow overprint, and
 * merging it would show the text twice in the editable line.
 */
const MAX_BACKTRACK_EM = 0.6

interface Positioned {
  run: TextRun
  /** Distance along the baseline direction. */
  along: number
  /** Distance across the baseline (i.e. which line it sits on). */
  across: number
  dir: [number, number]
}

function project(run: TextRun): Positioned {
  const dir: [number, number] = [Math.cos(run.angle), Math.sin(run.angle)]
  const perp: [number, number] = [-dir[1], dir[0]]
  const [x, y] = run.origin
  return {
    run,
    along: x * dir[0] + y * dir[1],
    across: x * perp[0] + y * perp[1],
    dir,
  }
}

function ctmKey(run: TextRun): string {
  return run.ctm.map((n) => Math.round(n * 1000) / 1000).join(',')
}

function blockersFor(
  run: TextRun,
  font: PdfFont | undefined,
  sharedStreams: ReadonlySet<string>
): RunBlocker[] {
  const out: RunBlocker[] = []
  if (run.renderMode === 3 || run.renderMode === 7) out.push('invisible')
  else if (run.renderMode >= 4) out.push('clipping-mode')
  if (font?.vertical) out.push('vertical')
  if (!run.text.trim()) out.push('no-unicode')
  else if (font && !font.canReuse && run.glyphs.some((g) => !g.unicode)) out.push('no-unicode')
  if (sharedStreams.has(run.streamKey)) out.push('shared-xobject')
  return out
}

export interface GroupOptions {
  runs: TextRun[]
  fonts: ReadonlyMap<string, PdfFont>
  /** Stream keys used by more than one page — not safe to edit in place. */
  sharedStreams: ReadonlySet<string>
  pages: PageInfo[]
}

export function groupIntoLines(options: GroupOptions): TextLine[] {
  const { runs, fonts, sharedStreams } = options
  const byPage = new Map<number, TextRun[]>()
  for (const run of runs) {
    const list = byPage.get(run.pageIndex)
    if (list) list.push(run)
    else byPage.set(run.pageIndex, [run])
  }

  const lines: TextLine[] = []
  let seq = 0

  for (const [pageIndex, pageRuns] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    // Bucket by everything that must match exactly before geometry is compared.
    const buckets = new Map<string, Positioned[]>()
    for (const run of pageRuns) {
      const p = project(run)
      const angleKey = Math.round(run.angle * 180 / Math.PI)
      const key = `${run.streamKey}|${ctmKey(run)}|${angleKey}`
      const list = buckets.get(key)
      if (list) list.push(p)
      else buckets.set(key, [p])
    }

    for (const bucket of buckets.values()) {
      // Sort across-then-along so runs on the same baseline become adjacent.
      bucket.sort((a, b) => (a.across - b.across) || (a.along - b.along))

      let current: Positioned[] = []
      const flush = (): void => {
        if (current.length === 0) return
        const line = buildLine(current, pageIndex, fonts, sharedStreams, seq++)
        if (line) lines.push(line)
        current = []
      }

      for (const p of bucket) {
        if (current.length === 0) {
          current.push(p)
          continue
        }
        const last = current[current.length - 1]
        const em = Math.max(last.run.effectiveSize, p.run.effectiveSize, 1e-6)
        const sameBaseline = Math.abs(p.across - last.across) <= em * BASELINE_TOLERANCE
        const sizeOk =
          Math.max(p.run.effectiveSize, last.run.effectiveSize) <=
          Math.min(p.run.effectiveSize, last.run.effectiveSize) * SIZE_RATIO
        // Advance is in text space; scale it to page space to compare gaps.
        const lastEnd = last.along + last.run.advance * scaleOf(last.run)
        const gap = p.along - lastEnd
        if (sameBaseline && sizeOk && gap <= em * MAX_GAP_EM && gap > -em * MAX_BACKTRACK_EM) {
          current.push(p)
        } else {
          flush()
          current.push(p)
        }
      }
      flush()
    }
  }

  // Reading order: top of the page first, then left to right.
  lines.sort((a, b) => a.pageIndex - b.pageIndex || b.origin[1] - a.origin[1] || a.origin[0] - b.origin[0])
  return lines
}

/** Page-space length of one unit of this run's text space. */
function scaleOf(run: TextRun): number {
  return run.textToPageScale || 1
}

function buildLine(
  parts: Positioned[],
  pageIndex: number,
  fonts: ReadonlyMap<string, PdfFont>,
  sharedStreams: ReadonlySet<string>,
  seq: number
): TextLine | null {
  const ordered = [...parts].sort((a, b) => a.along - b.along)
  const runs = ordered.map((p) => p.run)

  // Build the line text and, in lockstep, the per-run slices that compose it.
  const runTexts: string[] = ordered.map((p) => p.run.text)
  ordered.forEach((p, i) => {
    if (i === 0) return
    const prev = ordered[i - 1]
    const em = Math.max(prev.run.effectiveSize, 1e-6)
    const gap = p.along - (prev.along + prev.run.advance * scaleOf(prev.run))
    // A wide gap between runs is a space the producer expressed as movement
    // rather than as a glyph. Attribute it to the run before the gap.
    if (gap > em * 0.18 && !runTexts[i - 1].endsWith(' ') && !p.run.text.startsWith(' ')) {
      runTexts[i - 1] += ' '
    }
  })
  const text = runTexts.join('')

  let bbox: Rect | null = null
  for (const run of runs) bbox = bbox ? unionRect(bbox, run.bbox) : run.bbox
  if (!bbox) return null

  const anchor = ordered[0]
  const last = ordered[ordered.length - 1]
  const endAlong = last.along + last.run.advance * scaleOf(last.run)
  const width = Math.max(0, endAlong - anchor.along)

  // The dominant run is the one contributing the most characters; its font
  // describes the line for display purposes.
  const dominant = runs.reduce((a, b) => (b.text.length > a.text.length ? b : a), runs[0])
  const font = fonts.get(dominant.fontKey)

  const blockers = new Set<RunBlocker>()
  for (const run of runs) {
    for (const b of blockersFor(run, fonts.get(run.fontKey), sharedStreams)) blockers.add(b)
  }
  // A line made entirely of unmappable glyphs is not editable; a line with a
  // few is, so drop the flag when most of the text came through.
  if (blockers.has('no-unicode') && text.trim().length > 0) {
    const mapped = runs.reduce((a, r) => a + r.text.length, 0)
    const glyphs = runs.reduce((a, r) => a + r.glyphs.length, 0)
    if (glyphs > 0 && mapped / glyphs > 0.6) blockers.delete('no-unicode')
  }

  return {
    id: `l${seq}`,
    pageIndex,
    runIds: runs.map((r) => r.id),
    text,
    runTexts,
    bbox,
    origin: anchor.run.origin,
    angle: anchor.run.angle,
    effectiveSize: dominant.effectiveSize,
    fontName: font?.baseFont || dominant.fontName || 'unknown',
    fontFamily: font?.style.family ?? 'sans-serif',
    bold: font?.style.bold ?? false,
    italic: font?.style.italic ?? false,
    fill: dominant.fill,
    blockers: [...blockers],
    width,
  }
}

/** Bounding box of a set of lines, useful for tests and diagnostics. */
export function linesBBox(lines: TextLine[]): Rect {
  return rectFromPoints(
    lines.flatMap((l) => [
      [l.bbox.x, l.bbox.y] as [number, number],
      [l.bbox.x + l.bbox.width, l.bbox.y + l.bbox.height] as [number, number],
    ])
  )
}
