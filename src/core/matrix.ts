/**
 * 2-D affine transforms in the PDF convention.
 *
 * A PDF matrix `[a b c d e f]` denotes
 *
 *     | a  b  0 |
 *     | c  d  0 |
 *     | e  f  1 |
 *
 * and row vectors multiply on the left: `[x y 1] x M`. Composition therefore
 * reads left-to-right in application order: `mul(A, B)` applies A, then B.
 */
export type Matrix = readonly [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `mul(a, b)` = apply `a`, then `b`. Equivalent to the matrix product a x b. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

/** Transform a point by a matrix. */
export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Transform a direction vector (ignores translation). */
export function applyVector(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
}

export function translation(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty]
}

export function scaling(sx: number, sy: number): Matrix {
  return [sx, 0, 0, sy, 0, 0]
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

export function invert(m: Matrix): Matrix | null {
  const det = determinant(m)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const [a, b, c, d, e, f] = m
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ]
}

/**
 * Decompose the linear part of a matrix into the quantities a text renderer
 * cares about. `scaleY` is the effective glyph height multiplier (i.e. the
 * on-page font size once multiplied by Tfs) and `rotation` is in radians,
 * counter-clockwise, in PDF's y-up space.
 */
export interface Decomposed {
  scaleX: number
  scaleY: number
  /** Radians, counter-clockwise. */
  rotation: number
  /** Shear factor along x, in units of scaleY. Non-zero for italic-by-skew text. */
  skew: number
  flipped: boolean
}

export function decompose(m: Matrix): Decomposed {
  const [a, b, c, d] = m
  const scaleX = Math.hypot(a, b)
  const det = a * d - b * c
  // Gram-Schmidt: the y basis vector's component orthogonal to x gives scaleY.
  const scaleY = scaleX === 0 ? Math.hypot(c, d) : Math.abs(det) / scaleX
  const rotation = Math.atan2(b, a)
  const skew = scaleX === 0 || scaleY === 0 ? 0 : (a * c + b * d) / (scaleX * scaleY * scaleX)
  return { scaleX, scaleY, rotation, skew, flipped: det < 0 }
}

/** Axis-aligned bounding box in the space the matrix maps into. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function rectFromPoints(points: Array<[number, number]>): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Bounding box of the unit-ish box (0,y0)-(w,y1) transformed by `m`. */
export function transformedBox(
  m: Matrix,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Rect {
  return rectFromPoints([
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x1, y1),
    apply(m, x0, y1),
  ])
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/** Format a matrix as PDF content-stream operands (no trailing operator). */
export function formatMatrix(m: Matrix): string {
  return m.map(formatNumber).join(' ')
}

/**
 * PDF numbers must not use exponential notation. Emit a plain decimal with at
 * most 6 fractional digits and no trailing zeros.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  let s = n.toFixed(6)
  s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0' || s === '') return '0'
  return s
}
