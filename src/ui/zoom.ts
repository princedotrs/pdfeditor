/**
 * Zoom: the mapping from "what the user asked for" to a scale in CSS pixels
 * per PDF point.
 *
 * Fit modes are recomputed from the viewport rather than baked into a number,
 * so a window resize keeps meaning what it said.
 */
import type { PageInfo } from '../core/model'

export type ZoomSetting =
  | { kind: 'fit-width' }
  | { kind: 'fit-page' }
  | { kind: 'level'; level: number }

/** Discrete steps the +/- buttons and the menu walk through. */
export const ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4,
]

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4

/** Horizontal room the page gutters take out of the scroll container. */
export const GUTTER_X = 48
/** Vertical room reserved so a fit-page page is not flush against the chrome. */
export const GUTTER_Y = 40

export interface Viewport {
  width: number
  height: number
}

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

/**
 * The scale to render at.
 *
 * Fit modes size against the *widest* (or tallest) page in the document, not
 * the current one, so scrolling through a document with mixed page sizes does
 * not make the zoom jump around underfoot.
 */
export function computeScale(
  setting: ZoomSetting,
  pages: readonly PageInfo[],
  viewport: Viewport
): number {
  if (setting.kind === 'level') return clamp(setting.level)
  if (pages.length === 0 || viewport.width <= 0) return 1

  let maxW = 0
  let maxH = 0
  for (const page of pages) {
    if (page.displayWidth > maxW) maxW = page.displayWidth
    if (page.displayHeight > maxH) maxH = page.displayHeight
  }
  if (maxW <= 0 || maxH <= 0) return 1

  const byWidth = (viewport.width - GUTTER_X) / maxW
  if (setting.kind === 'fit-width') return clamp(byWidth)

  const byHeight = (viewport.height - GUTTER_Y) / maxH
  return clamp(Math.min(byWidth, byHeight))
}

/** Next discrete step above `scale`, or the top of the range. */
export function zoomIn(scale: number): number {
  for (const level of ZOOM_LEVELS) {
    if (level > scale + 1e-6) return level
  }
  return MAX_ZOOM
}

/** Next discrete step below `scale`, or the bottom of the range. */
export function zoomOut(scale: number): number {
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i -= 1) {
    const level = ZOOM_LEVELS[i]
    if (level < scale - 1e-6) return level
  }
  return MIN_ZOOM
}

export function zoomLabel(setting: ZoomSetting, scale: number): string {
  if (setting.kind === 'fit-width') return 'Fit width'
  if (setting.kind === 'fit-page') return 'Fit page'
  return `${Math.round(scale * 100)}%`
}
