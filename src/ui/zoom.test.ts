import { describe, expect, it } from 'vitest'
import type { PageInfo } from '../core/model'
import {
  GUTTER_X,
  MAX_ZOOM,
  MIN_ZOOM,
  computeScale,
  zoomIn,
  zoomLabel,
  zoomOut,
} from './zoom'

function page(displayWidth: number, displayHeight: number, index = 0): PageInfo {
  return {
    index,
    width: displayWidth,
    height: displayHeight,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    displayWidth,
    displayHeight,
  }
}

const letter = page(612, 792)

describe('computeScale', () => {
  it('returns an explicit level untouched', () => {
    expect(computeScale({ kind: 'level', level: 1.25 }, [letter], { width: 100, height: 100 })).toBe(1.25)
  })

  it('clamps explicit levels into range', () => {
    const vp = { width: 1000, height: 1000 }
    expect(computeScale({ kind: 'level', level: 99 }, [letter], vp)).toBe(MAX_ZOOM)
    expect(computeScale({ kind: 'level', level: 0.01 }, [letter], vp)).toBe(MIN_ZOOM)
  })

  it('fits width against the viewport minus the gutter', () => {
    const width = 612 + GUTTER_X
    expect(
      computeScale({ kind: 'fit-width' }, [letter], { width, height: 10_000 })
    ).toBeCloseTo(1, 9)
  })

  it('fits page against whichever axis binds', () => {
    // Very wide but short viewport: height is the constraint.
    const scale = computeScale({ kind: 'fit-page' }, [letter], { width: 10_000, height: 436 })
    expect(scale).toBeCloseTo((436 - 40) / 792, 9)
  })

  it('sizes fit modes against the largest page, not the first', () => {
    const pages = [letter, page(1224, 792, 1)]
    const scale = computeScale({ kind: 'fit-width' }, pages, { width: 1224 + GUTTER_X, height: 5000 })
    expect(scale).toBeCloseTo(1, 9)
  })

  it('falls back to 1 when there is nothing to measure', () => {
    expect(computeScale({ kind: 'fit-width' }, [], { width: 800, height: 600 })).toBe(1)
    expect(computeScale({ kind: 'fit-width' }, [letter], { width: 0, height: 0 })).toBe(1)
  })
})

describe('zoomIn / zoomOut', () => {
  it('walks the discrete steps', () => {
    expect(zoomIn(1)).toBe(1.25)
    expect(zoomOut(1)).toBe(0.9)
  })

  it('steps off an arbitrary fit scale to the neighbouring level', () => {
    expect(zoomIn(1.1)).toBe(1.25)
    expect(zoomOut(1.1)).toBe(1)
  })

  it('saturates at the ends instead of running away', () => {
    expect(zoomIn(4)).toBe(MAX_ZOOM)
    expect(zoomIn(10)).toBe(MAX_ZOOM)
    expect(zoomOut(0.5)).toBe(MIN_ZOOM)
    expect(zoomOut(0.1)).toBe(MIN_ZOOM)
  })
})

describe('zoomLabel', () => {
  it('names fit modes and shows a percentage otherwise', () => {
    expect(zoomLabel({ kind: 'fit-width' }, 1.3)).toBe('Fit width')
    expect(zoomLabel({ kind: 'fit-page' }, 0.7)).toBe('Fit page')
    expect(zoomLabel({ kind: 'level', level: 1.25 }, 1.25)).toBe('125%')
  })
})
