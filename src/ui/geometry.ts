/**
 * Page space -> screen space.
 *
 * `TextLine.bbox`, `TextLine.origin` and `TextLine.angle` all live in **page
 * space**: PDF user space (y-UP), translated so the visible box's lower-left
 * corner is (0, 0), and *before* `/Rotate` is applied. `PageInfo.width` and
 * `PageInfo.height` are the size of that space.
 *
 * Screen space is CSS pixels inside the page canvas: y-DOWN, origin at the
 * canvas's top-left corner, and the canvas measures
 * `displayWidth * scale` x `displayHeight * scale` — i.e. rotation has already
 * been applied to the canvas's own dimensions.
 *
 * The whole mapping is therefore "flip Y, then rotate clockwise by /Rotate,
 * then scale". The four cases below are written out explicitly rather than
 * composed from matrices because there are only four of them and being able to
 * read the formula off the page is worth more than the generality.
 */
import type { Rect } from '../core/matrix'
import type { PageInfo } from '../core/model'

/** Maps a page-space point to CSS pixels inside the page canvas. */
export type ScreenMapper = (x: number, y: number) => [number, number]

/**
 * Build the page-space -> screen-space point mapper for one page.
 *
 * With `W = page.width`, `H = page.height` and `s = scale`:
 *
 * ```
 *   rotation   0 :  sx = x * s              sy = (H - y) * s
 *   rotation  90 :  sx = y * s              sy = x * s
 *   rotation 180 :  sx = (W - x) * s        sy = y * s
 *   rotation 270 :  sx = (H - y) * s        sy = (W - x) * s
 * ```
 *
 * These agree exactly with pdf.js's `PageViewport` transforms, which is what
 * actually paints the canvas underneath the overlay:
 *
 * ```
 *     0 : [ 1,  0,  0, -1,   0,   H ]
 *    90 : [ 0,  1,  1,  0,   0,   0 ]
 *   180 : [-1,  0,  0,  1,   W,   0 ]
 *   270 : [ 0, -1, -1,  0,   H,   W ]
 * ```
 *
 * Sanity anchors, all at `scale = 1`:
 * - rotation 0, page origin (0, 0) -> (0, H): the visible box's lower-left
 *   corner lands at the canvas's bottom-left, which is the definition of the
 *   Y flip.
 * - rotation 90, page origin (0, 0) -> (0, 0): rotating the sheet clockwise
 *   carries its lower-left corner to the top-left of the display.
 */
export function pageToScreen(page: PageInfo, scale: number): ScreenMapper {
  const w = page.width
  const h = page.height
  switch (normalizeRotation(page.rotation)) {
    case 90:
      return (x, y) => [y * scale, x * scale]
    case 180:
      return (x, y) => [(w - x) * scale, y * scale]
    case 270:
      return (x, y) => [(h - y) * scale, (w - x) * scale]
    default:
      return (x, y) => [x * scale, (h - y) * scale]
  }
}

/** `/Rotate` coerced to exactly one of 0 | 90 | 180 | 270. */
export function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  return r === 90 || r === 180 || r === 270 ? r : 0
}

/** The canvas's CSS size for a page at `scale`, rotation already applied. */
export function canvasSize(
  page: PageInfo,
  scale: number
): { width: number; height: number } {
  return {
    width: page.displayWidth * scale,
    height: page.displayHeight * scale,
  }
}

/**
 * The CSS `rotate()` angle, in radians, for text whose page-space baseline
 * direction is `angle`.
 *
 * `TextLine.angle` is counter-clockwise in y-up page space. CSS `rotate()` is
 * clockwise in y-down screen space, so the Y flip alone negates it; the page's
 * own `/Rotate` then adds a clockwise turn on top:
 *
 *     screenAngle = rotation(radians) - angle
 *
 * Derivation, per rotation, of the screen direction of the baseline unit
 * vector `(cos a, sin a)` (screen components written y-down):
 *
 * ```
 *     0 : ( cos a, -sin a)  ->  atan2 = -a
 *    90 : ( sin a,  cos a)  ->  atan2 = pi/2 - a
 *   180 : (-cos a,  sin a)  ->  atan2 = pi   - a
 *   270 : (-sin a, -cos a)  ->  atan2 = 3pi/2 - a
 * ```
 */
export function screenAngle(page: PageInfo, angle: number): number {
  return (normalizeRotation(page.rotation) * Math.PI) / 180 - angle
}

/**
 * Map an axis-aligned page-space rect to an axis-aligned screen rect.
 *
 * Because every rotation here is a multiple of 90 degrees, the mapping only
 * ever swaps and/or flips axes, so the transformed corners are still
 * axis-aligned and this is exact rather than a conservative bound.
 */
export function pageRectToScreen(
  page: PageInfo,
  scale: number,
  rect: Rect
): Rect {
  const map = pageToScreen(page, scale)
  const [ax, ay] = map(rect.x, rect.y)
  const [bx, by] = map(rect.x + rect.width, rect.y + rect.height)
  const x = Math.min(ax, bx)
  const y = Math.min(ay, by)
  return { x, y, width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

/** Grow a screen rect by `pad` CSS pixels on every side. */
export function padRect(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

/**
 * Where the text baseline sits inside a `line-height: 1` box, as a fraction of
 * the font size.
 *
 * With `line-height: 1` the line box is exactly 1em tall, so the half-leading
 * is `(1 - (ascent + descent)) / 2` (usually negative, since most fonts'
 * ascent + descent exceeds 1em) and the baseline lands at
 * `halfLeading + ascent` below the top of the box.
 *
 * We need this because the overlay is positioned by the glyph *baseline* —
 * that is what `TextLine.origin` is — while CSS positions boxes by their top
 * edge. Getting it from the real font metrics instead of a magic 0.8 is what
 * makes the boxes sit on the glyphs they are covering.
 */
export function baselineRatioFromMetrics(
  ascent: number,
  descent: number
): number {
  const halfLeading = (1 - (ascent + descent)) / 2
  return halfLeading + ascent
}

/** Fallback used when the browser will not report font bounding-box metrics. */
export const DEFAULT_BASELINE_RATIO = 0.8

const baselineCache = new Map<string, number>()
let metricsCanvas: HTMLCanvasElement | null = null

/**
 * Measure `baselineRatioFromMetrics` for a concrete CSS font shorthand, e.g.
 * `italic 700 100px Georgia, serif`. Cached, because it forces the font to
 * load and measure, and the answer never changes for a given shorthand.
 */
export function baselineRatio(fontShorthand: string): number {
  const cached = baselineCache.get(fontShorthand)
  if (cached !== undefined) return cached
  let ratio = DEFAULT_BASELINE_RATIO
  try {
    if (typeof document !== 'undefined') {
      if (!metricsCanvas) metricsCanvas = document.createElement('canvas')
      const ctx = metricsCanvas.getContext('2d')
      if (ctx) {
        ctx.font = fontShorthand
        const m = ctx.measureText('Hxg')
        const asc = m.fontBoundingBoxAscent
        const desc = m.fontBoundingBoxDescent
        if (Number.isFinite(asc) && Number.isFinite(desc) && asc + desc > 0) {
          // Metrics come back in px for the size baked into the shorthand.
          const em = asc + desc
          const size = parseFloat(fontShorthand.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0')
          if (size > 0 && em / size > 0.3 && em / size < 3) {
            ratio = baselineRatioFromMetrics(asc / size, desc / size)
          }
        }
      }
    }
  } catch {
    ratio = DEFAULT_BASELINE_RATIO
  }
  baselineCache.set(fontShorthand, ratio)
  return ratio
}

/* -------------------------------------------------------------------------- */
/* Background sampling                                                        */
/* -------------------------------------------------------------------------- */

export interface SampledBackground {
  r: number
  g: number
  b: number
  /** CSS colour string for the sampled median. */
  css: string
  /**
   * Mean distance of the samples from the median, 0-255. Low means the band
   * around the line really is one flat colour; high means we would be painting
   * over artwork.
   */
  variance: number
}

/**
 * Median of a set of RGB samples, plus how far the samples stray from it.
 *
 * Median rather than mean because a stray dark pixel (a rule, a descender that
 * escaped the bbox) would drag a mean off the paper colour, and the whole
 * point is to reproduce the paper colour.
 */
export function summarizeSamples(samples: ReadonlyArray<readonly [number, number, number]>): SampledBackground | null {
  if (samples.length === 0) return null
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (const [r, g, b] of samples) {
    rs.push(r)
    gs.push(g)
    bs.push(b)
  }
  const r = median(rs)
  const g = median(gs)
  const b = median(bs)
  let total = 0
  for (const [sr, sg, sb] of samples) {
    total += (Math.abs(sr - r) + Math.abs(sg - g) + Math.abs(sb - b)) / 3
  }
  const variance = total / samples.length
  return { r, g, b, css: `rgb(${r}, ${g}, ${b})`, variance }
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  if (values.length % 2 === 1) return values[mid]
  return Math.round((values[mid - 1] + values[mid]) / 2)
}

/** Above this mean deviation the background is not flat enough to fake. */
export const FLAT_BACKGROUND_THRESHOLD = 10

/**
 * Sample the page background in a thin band just *outside* `rect`.
 *
 * `rect` is in CSS pixels relative to the canvas's top-left. The canvas's
 * backing store is usually larger (device pixel ratio), so we scale into
 * backing-store coordinates before reading pixels.
 *
 * Returns `null` when the canvas cannot be read, when the band falls entirely
 * outside the canvas, or when the samples are too varied to stand in for a
 * flat fill — in which case the caller must *not* paint a cover rectangle and
 * should tell the user to check the rendered preview instead.
 */
export function sampleBackground(
  canvas: HTMLCanvasElement,
  rect: Rect,
  band = 3
): SampledBackground | null {
  const cssW = canvas.clientWidth || canvas.width
  const cssH = canvas.clientHeight || canvas.height
  if (!cssW || !cssH || !canvas.width || !canvas.height) return null
  const kx = canvas.width / cssW
  const ky = canvas.height / cssH

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  // Outer rect = rect grown by `band`; we read the ring between the two.
  const outer = padRect(rect, band)
  const x0 = Math.max(0, Math.floor(outer.x * kx))
  const y0 = Math.max(0, Math.floor(outer.y * ky))
  const x1 = Math.min(canvas.width, Math.ceil((outer.x + outer.width) * kx))
  const y1 = Math.min(canvas.height, Math.ceil((outer.y + outer.height) * ky))
  if (x1 - x0 < 2 || y1 - y0 < 2) return null

  const ix0 = Math.max(x0, Math.floor(rect.x * kx))
  const iy0 = Math.max(y0, Math.floor(rect.y * ky))
  const ix1 = Math.min(x1, Math.ceil((rect.x + rect.width) * kx))
  const iy1 = Math.min(y1, Math.ceil((rect.y + rect.height) * ky))

  let data: ImageData
  try {
    data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
  } catch {
    // Tainted canvas, or a zero-area read.
    return null
  }

  const samples: Array<[number, number, number]> = []
  const w = x1 - x0
  // Step so a huge line still costs a bounded number of samples.
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 2000)))
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      // Skip the interior: that is the glyphs we are trying to hide.
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue
      const i = ((y - y0) * w + (x - x0)) * 4
      samples.push([data.data[i], data.data[i + 1], data.data[i + 2]])
    }
  }

  const summary = summarizeSamples(samples)
  if (!summary) return null
  if (summary.variance > FLAT_BACKGROUND_THRESHOLD) return null
  return summary
}
