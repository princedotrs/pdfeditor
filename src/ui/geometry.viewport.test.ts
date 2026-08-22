/**
 * Cross-checks `pageToScreen` against pdf.js's own `PageViewport.transform`.
 *
 * The overlay's editable boxes are positioned by our formula, while the glyphs
 * underneath are painted by pdf.js's. If the two ever disagree the boxes drift
 * off the text, and no amount of careful derivation is as convincing as running
 * both over real pages — including rotated ones and ones whose CropBox does not
 * start at the origin, which is exactly where this kind of code goes wrong.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPdf } from '../core/document'
import { pageToScreen, screenAngle } from './geometry'
import type { PageInfo } from '../core/model'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'fixtures')

type Pdfjs = typeof import('pdfjs-dist')
let pdfjsPromise: Promise<Pdfjs> | null = null
const pdfjs = (): Promise<Pdfjs> => {
  if (!pdfjsPromise) {
    pdfjsPromise = import(
      /* @vite-ignore */ path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')
    ) as Promise<Pdfjs>
  }
  return pdfjsPromise
}

/** Apply a pdf.js transform matrix [a b c d e f] to a point. */
const applyTransform = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
]

async function viewportTransform(file: string, scale: number): Promise<number[]> {
  const { getDocument } = await pdfjs()
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, file)))
  const task = getDocument({ data: bytes })
  const doc = await task.promise
  const page = await doc.getPage(1)
  const transform = [...page.getViewport({ scale }).transform]
  await task.destroy()
  return transform
}

const FILES = [
  'simple-helvetica.pdf',
  'rotated-90.pdf',
  'rotated-180.pdf',
  'rotated-270.pdf',
  'cropbox-offset.pdf',
  'mediabox-origin.pdf',
]

describe('pageToScreen agrees with pdf.js PageViewport', () => {
  for (const file of FILES) {
    for (const scale of [1, 1.75]) {
      it(`${file} at scale ${scale}`, async () => {
        const loaded = await loadPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, file))))
        const page: PageInfo = loaded.model.pages[0]
        const transform = await viewportTransform(file, scale)
        const map = pageToScreen(page, scale)

        // Probe the corners and centre of the visible box, plus every real
        // text baseline on the page.
        const probes: Array<[number, number]> = [
          [0, 0],
          [page.width, 0],
          [0, page.height],
          [page.width, page.height],
          [page.width / 2, page.height / 3],
          ...loaded.model.lines.map((l) => l.origin),
        ]

        for (const [px, py] of probes) {
          // pdf.js works in raw user space; page space is offset by the box.
          const expected = applyTransform(transform, px + page.offsetX, py + page.offsetY)
          const actual = map(px, py)
          expect(actual[0], `x at (${px}, ${py}) in ${file}`).toBeCloseTo(expected[0], 4)
          expect(actual[1], `y at (${px}, ${py}) in ${file}`).toBeCloseTo(expected[1], 4)
        }
      })
    }
  }

  it('produces canvas-sized output for the visible box corners', async () => {
    for (const file of FILES) {
      const loaded = await loadPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, file))))
      const page = loaded.model.pages[0]
      const map = pageToScreen(page, 1)
      const corners = [
        map(0, 0),
        map(page.width, 0),
        map(0, page.height),
        map(page.width, page.height),
      ]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      expect(Math.min(...xs)).toBeCloseTo(0, 6)
      expect(Math.min(...ys)).toBeCloseTo(0, 6)
      expect(Math.max(...xs)).toBeCloseTo(page.displayWidth, 6)
      expect(Math.max(...ys)).toBeCloseTo(page.displayHeight, 6)
    }
  })
})

describe('screenAngle matches the mapped baseline direction', () => {
  it('agrees with the direction pageToScreen gives the baseline vector', async () => {
    for (const file of FILES) {
      const loaded = await loadPdf(new Uint8Array(fs.readFileSync(path.join(FIXTURES, file))))
      const page = loaded.model.pages[0]
      const map = pageToScreen(page, 1)
      for (const angle of [0, 0.3, -0.7, Math.PI / 2]) {
        const [ox, oy] = map(100, 100)
        const [tx, ty] = map(100 + Math.cos(angle), 100 + Math.sin(angle))
        const measured = Math.atan2(ty - oy, tx - ox)
        const predicted = screenAngle(page, angle)
        // Compare as directions so the +/-pi wrap does not matter.
        expect(Math.cos(measured), `${file} @ ${angle}`).toBeCloseTo(Math.cos(predicted), 6)
        expect(Math.sin(measured), `${file} @ ${angle}`).toBeCloseTo(Math.sin(predicted), 6)
      }
    }
  })
})
