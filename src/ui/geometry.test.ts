import { describe, expect, it } from 'vitest'
import type { PageInfo } from '../core/model'
import {
  FLAT_BACKGROUND_THRESHOLD,
  baselineRatioFromMetrics,
  canvasSize,
  normalizeRotation,
  padRect,
  pageRectToScreen,
  pageToScreen,
  screenAngle,
  summarizeSamples,
} from './geometry'

/** A 600 x 800 page (portrait, US-Letter-ish) at the given /Rotate. */
function page(rotation: number): PageInfo {
  const swapped = rotation === 90 || rotation === 270
  return {
    index: 0,
    width: 600,
    height: 800,
    rotation,
    offsetX: 0,
    offsetY: 0,
    displayWidth: swapped ? 800 : 600,
    displayHeight: swapped ? 600 : 800,
  }
}

const W = 600
const H = 800

/** Round-trip helper so floating point noise never fails an exact assertion. */
function at(rotation: number, x: number, y: number, scale = 1): [number, number] {
  const [sx, sy] = pageToScreen(page(rotation), scale)(x, y)
  return [Math.round(sx * 1e6) / 1e6, Math.round(sy * 1e6) / 1e6]
}

describe('normalizeRotation', () => {
  it('passes the four canonical values through', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(180)).toBe(180)
    expect(normalizeRotation(270)).toBe(270)
  })

  it('folds out-of-range and negative angles', () => {
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(-270)).toBe(90)
  })
})

describe('pageToScreen — rotation 0', () => {
  it('lands the page-space origin at the canvas bottom-left', () => {
    expect(at(0, 0, 0)).toEqual([0, H])
  })

  it('maps the four page corners to the four canvas corners', () => {
    expect(at(0, 0, H)).toEqual([0, 0]) // top-left of the sheet -> top-left
    expect(at(0, W, H)).toEqual([W, 0])
    expect(at(0, W, 0)).toEqual([W, H])
  })

  it('flips Y and preserves X for an interior point', () => {
    expect(at(0, 100, 700)).toEqual([100, 100])
  })

  it('multiplies through by scale', () => {
    expect(at(0, 100, 700, 2)).toEqual([200, 200])
    expect(at(0, 0, 0, 1.5)).toEqual([0, H * 1.5])
  })
})

describe('pageToScreen — rotation 90', () => {
  // Rotating the sheet clockwise carries its lower-left corner to the top-left.
  it('lands the page-space origin at the canvas top-left', () => {
    expect(at(90, 0, 0)).toEqual([0, 0])
  })

  it('maps the sheet corners onto an H x W canvas', () => {
    expect(at(90, W, 0)).toEqual([0, W]) // bottom-right of sheet -> bottom-left
    expect(at(90, 0, H)).toEqual([H, 0]) // top-left of sheet -> top-right
    expect(at(90, W, H)).toEqual([H, W])
  })

  it('swaps the axes without flipping either', () => {
    expect(at(90, 100, 700)).toEqual([700, 100])
  })
})

describe('pageToScreen — rotation 180', () => {
  it('lands the page-space origin at the canvas top-right', () => {
    expect(at(180, 0, 0)).toEqual([W, 0])
  })

  it('maps the sheet corners to the opposite canvas corners', () => {
    expect(at(180, W, 0)).toEqual([0, 0])
    expect(at(180, 0, H)).toEqual([W, H])
    expect(at(180, W, H)).toEqual([0, H])
  })

  it('flips X and preserves Y', () => {
    expect(at(180, 100, 700)).toEqual([500, 700])
  })
})

describe('pageToScreen — rotation 270', () => {
  it('lands the page-space origin at the canvas bottom-right', () => {
    expect(at(270, 0, 0)).toEqual([H, W])
  })

  it('maps the sheet corners onto an H x W canvas', () => {
    expect(at(270, W, 0)).toEqual([H, 0])
    expect(at(270, 0, H)).toEqual([0, W])
    expect(at(270, W, H)).toEqual([0, 0])
  })

  it('swaps the axes and flips both', () => {
    expect(at(270, 100, 700)).toEqual([100, 500])
  })
})

describe('pageToScreen — invariants across all four rotations', () => {
  const rotations = [0, 90, 180, 270]

  it('keeps every page point inside the canvas', () => {
    for (const rotation of rotations) {
      const p = page(rotation)
      const map = pageToScreen(p, 1)
      for (const [x, y] of [
        [0, 0],
        [W, 0],
        [0, H],
        [W, H],
        [300, 400],
      ] as Array<[number, number]>) {
        const [sx, sy] = map(x, y)
        expect(sx).toBeGreaterThanOrEqual(0)
        expect(sy).toBeGreaterThanOrEqual(0)
        expect(sx).toBeLessThanOrEqual(p.displayWidth)
        expect(sy).toBeLessThanOrEqual(p.displayHeight)
      }
    }
  })

  it('is a rigid map: page distances are preserved at scale 1', () => {
    for (const rotation of rotations) {
      const map = pageToScreen(page(rotation), 1)
      const [ax, ay] = map(120, 300)
      const [bx, by] = map(420, 500)
      expect(Math.hypot(bx - ax, by - ay)).toBeCloseTo(Math.hypot(300, 200), 9)
    }
  })

  it('each of the four sheet corners hits a distinct canvas corner', () => {
    for (const rotation of rotations) {
      const seen = new Set(
        (
          [
            [0, 0],
            [W, 0],
            [0, H],
            [W, H],
          ] as Array<[number, number]>
        ).map(([x, y]) => at(rotation, x, y).join(','))
      )
      expect(seen.size).toBe(4)
    }
  })
})

describe('canvasSize', () => {
  it('uses the post-rotation display size', () => {
    expect(canvasSize(page(0), 1)).toEqual({ width: 600, height: 800 })
    expect(canvasSize(page(90), 1)).toEqual({ width: 800, height: 600 })
    expect(canvasSize(page(180), 2)).toEqual({ width: 1200, height: 1600 })
    expect(canvasSize(page(270), 0.5)).toEqual({ width: 400, height: 300 })
  })
})

describe('screenAngle', () => {
  const HALF_PI = Math.PI / 2

  it('negates horizontal page-space angles when the page is upright', () => {
    expect(screenAngle(page(0), 0)).toBeCloseTo(0, 9)
    // Text rising to the right in y-up space rotates anticlockwise on screen.
    expect(screenAngle(page(0), 0.3)).toBeCloseTo(-0.3, 9)
  })

  it('adds the page rotation as a clockwise turn', () => {
    expect(screenAngle(page(90), 0)).toBeCloseTo(HALF_PI, 9)
    expect(screenAngle(page(180), 0)).toBeCloseTo(Math.PI, 9)
    expect(screenAngle(page(270), 0)).toBeCloseTo(3 * HALF_PI, 9)
  })

  it('agrees with the baseline direction the point mapper produces', () => {
    // Independent check: map two points along the baseline and read the angle
    // straight off the screen positions.
    for (const rotation of [0, 90, 180, 270]) {
      for (const angle of [0, 0.4, -0.7, HALF_PI]) {
        const map = pageToScreen(page(rotation), 1)
        const [ax, ay] = map(300, 400)
        const [bx, by] = map(300 + Math.cos(angle) * 10, 400 + Math.sin(angle) * 10)
        const measured = Math.atan2(by - ay, bx - ax)
        const expected = screenAngle(page(rotation), angle)
        // Compare as unit vectors so 2*pi wraparound never trips the test.
        expect(Math.cos(measured)).toBeCloseTo(Math.cos(expected), 9)
        expect(Math.sin(measured)).toBeCloseTo(Math.sin(expected), 9)
      }
    }
  })

  it('turns 90-degree page rotation into upright-on-screen vertical text', () => {
    // Page-space text running "up the page" (angle = pi/2) on a /Rotate 90
    // page reads horizontally once displayed.
    expect(Math.cos(screenAngle(page(90), HALF_PI))).toBeCloseTo(1, 9)
    expect(Math.sin(screenAngle(page(90), HALF_PI))).toBeCloseTo(0, 9)
  })
})

describe('pageRectToScreen', () => {
  const rect = { x: 100, y: 700, width: 200, height: 20 }

  it('maps an upright page rect to the same box, Y-flipped', () => {
    // Page-space top edge is y = 720, which is 80 down from the sheet top.
    expect(pageRectToScreen(page(0), 1, rect)).toEqual({
      x: 100,
      y: 80,
      width: 200,
      height: 20,
    })
  })

  it('swaps width and height on a quarter turn', () => {
    expect(pageRectToScreen(page(90), 1, rect)).toEqual({
      x: 700,
      y: 100,
      width: 20,
      height: 200,
    })
    expect(pageRectToScreen(page(270), 1, rect)).toEqual({
      x: 80,
      y: 300,
      width: 20,
      height: 200,
    })
  })

  it('mirrors on a half turn', () => {
    expect(pageRectToScreen(page(180), 1, rect)).toEqual({
      x: 300,
      y: 700,
      width: 200,
      height: 20,
    })
  })

  it('scales position and size together', () => {
    expect(pageRectToScreen(page(0), 2, rect)).toEqual({
      x: 200,
      y: 160,
      width: 400,
      height: 40,
    })
  })

  it('always produces a non-negative width and height', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const out = pageRectToScreen(page(rotation), 1.37, rect)
      expect(out.width).toBeGreaterThan(0)
      expect(out.height).toBeGreaterThan(0)
    }
  })
})

describe('padRect', () => {
  it('grows on every side', () => {
    expect(padRect({ x: 10, y: 20, width: 30, height: 40 }, 2)).toEqual({
      x: 8,
      y: 18,
      width: 34,
      height: 44,
    })
  })
})

describe('baselineRatioFromMetrics', () => {
  it('places the baseline at the ascent when ascent + descent is exactly 1em', () => {
    expect(baselineRatioFromMetrics(0.8, 0.2)).toBeCloseTo(0.8, 9)
  })

  it('absorbs negative half-leading when the font overflows 1em', () => {
    // ascent 0.9 + descent 0.3 = 1.2em -> half-leading -0.1em.
    expect(baselineRatioFromMetrics(0.9, 0.3)).toBeCloseTo(0.8, 9)
  })

  it('stays inside the box for a plausible range of real fonts', () => {
    for (const [a, d] of [
      [1.0, 0.2],
      [0.75, 0.25],
      [0.9, 0.25],
      [1.05, 0.35],
    ] as Array<[number, number]>) {
      const r = baselineRatioFromMetrics(a, d)
      expect(r).toBeGreaterThan(0.5)
      expect(r).toBeLessThan(1.1)
    }
  })
})

describe('summarizeSamples', () => {
  it('returns null for no samples', () => {
    expect(summarizeSamples([])).toBeNull()
  })

  it('reports zero variance and the exact colour for a flat band', () => {
    const flat = Array.from({ length: 20 }, () => [255, 254, 250] as const)
    const out = summarizeSamples(flat)
    expect(out).not.toBeNull()
    expect(out?.css).toBe('rgb(255, 254, 250)')
    expect(out?.variance).toBe(0)
  })

  it('takes the median, so a few dark outliers do not drag the colour down', () => {
    const samples: Array<readonly [number, number, number]> = [
      ...Array.from({ length: 18 }, () => [250, 250, 250] as const),
      [0, 0, 0],
      [10, 10, 10],
    ]
    const out = summarizeSamples(samples)
    expect(out?.r).toBe(250)
    expect(out?.g).toBe(250)
    expect(out?.b).toBe(250)
    // ...but the outliers still show up as variance, which is what makes the
    // caller refuse to paint a cover rectangle.
    expect(out?.variance).toBeGreaterThan(FLAT_BACKGROUND_THRESHOLD)
  })

  it('keeps a mildly noisy scan under the flatness threshold', () => {
    const samples = Array.from(
      { length: 40 },
      (_, i) => [248 + (i % 3), 248 + (i % 3), 246 + (i % 3)] as const
    )
    const out = summarizeSamples(samples)
    expect(out?.variance).toBeLessThan(FLAT_BACKGROUND_THRESHOLD)
  })
})
