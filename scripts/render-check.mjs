/**
 * Visual verification: render a fixture before and after an edit, side by side.
 *
 * Round-trip tests prove the *text* is right. This proves the *pixels* are —
 * that the replacement lands on the original baseline, in the original colour,
 * and that the old glyphs are actually gone rather than hidden behind a box.
 *
 * Usage:
 *   node scripts/render-check.mjs                       # the default set
 *   node scripts/render-check.mjs <file.pdf> "<match>" "<new text>"
 *
 * Output: tmp/render-check/<name>.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'fixtures')
const outDir = path.join(root, 'tmp/render-check')
const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist')

const pdfjs = await import(pathToFileURL(path.join(pdfjsDir, 'legacy/build/pdf.mjs')).href)

// The engine is browser-oriented (it starts a Worker); use the pieces directly.
const { loadPdf } = await import(pathToFileURL(path.join(root, 'src/core/document.ts')).href)
const { exportEditedPdf } = await import(pathToFileURL(path.join(root, 'src/core/export.ts')).href)

const SCALE = 1.5

async function renderPage(bytes, pageIndex = 0) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    wasmUrl: path.join(pdfjsDir, 'wasm') + path.sep,
    iccUrl: path.join(pdfjsDir, 'iccs') + path.sep,
  })
  const doc = await task.promise
  const page = await doc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale: SCALE })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, canvas: null, viewport }).promise
  await task.destroy()
  return canvas
}

/** Fraction of pixels that differ, and the bounding box of the differences. */
function diff(a, b) {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const da = a.getContext('2d').getImageData(0, 0, w, h).data
  const db = b.getContext('2d').getImageData(0, 0, w, h).data
  let changed = 0
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (
        Math.abs(da[i] - db[i]) > 12 ||
        Math.abs(da[i + 1] - db[i + 1]) > 12 ||
        Math.abs(da[i + 2] - db[i + 2]) > 12
      ) {
        changed++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return {
    fraction: changed / (w * h),
    box: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  }
}

function compose(before, after, label) {
  const gap = 24
  const headroom = 30
  const canvas = createCanvas(
    before.width + after.width + gap * 3,
    Math.max(before.height, after.height) + headroom + gap
  )
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#f4f4f5'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#18181b'
  ctx.font = 'bold 15px sans-serif'
  ctx.fillText(`${label}  —  before`, gap, 21)
  ctx.fillText('after', before.width + gap * 2, 21)
  ctx.drawImage(before, gap, headroom)
  ctx.drawImage(after, before.width + gap * 2, headroom)
  ctx.strokeStyle = '#a1a1aa'
  ctx.lineWidth = 1
  ctx.strokeRect(gap - 0.5, headroom - 0.5, before.width + 1, before.height + 1)
  ctx.strokeRect(before.width + gap * 2 - 0.5, headroom - 0.5, after.width + 1, after.height + 1)
  return canvas
}

const DEFAULT_CASES = [
  ['simple-helvetica.pdf', 'Simple Helvetica Fixture', 'Edited heading'],
  ['colored-background.pdf', 'Light text on a dark panel', 'Edited on dark'],
  ['tj-kerning.pdf', 'Total amount due now', 'Total amount paid'],
  ['multi-op-line.pdf', 'Invoice number', 'Invoice number INV-9999 is settled'],
  ['rotated-90.pdf', 'ROTATE MARKER', 'EDITED MARKER'],
  ['form-xobject.pdf', 'Text inside a Form XObject', 'Edited inside XObject'],
  ['embedded-truetype.pdf', 'Plain ASCII', 'Edited embedded TrueType text'],
  ['type0-identity-h.pdf', 'composite', 'edited composite'],
  ['text-state.pdf', 'Tz 60', 'Tz 60: edited condensed'],
  ['unbalanced-q.pdf', 'Before any clip', 'Edited before the clip'],
  ['type3.pdf', 'Result : PASS', 'Result : FAIL Marks : 0900/1800'],
]

const argv = process.argv.slice(2)
const cases = argv.length >= 3 ? [[argv[0], argv[1], argv[2]]] : DEFAULT_CASES

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

let failures = 0
let skipped = 0
for (const [file, match, newText] of cases) {
  const src = path.join(fixtures, file)
  if (!fs.existsSync(src)) {
    // The font-embedding fixtures are not checked in; see .gitignore.
    console.log(`SKIP ${file} (not generated — run \`npm run fixtures\`)`)
    skipped++
    continue
  }
  const bytes = new Uint8Array(fs.readFileSync(src))
  const loaded = await loadPdf(bytes)
  const target = loaded.model.lines.find(
    (l) => l.blockers.length === 0 && l.text.includes(match)
  )
  if (!target) {
    console.log(`FAIL ${file}: no editable line matching ${JSON.stringify(match)}`)
    failures++
    continue
  }
  const result = await exportEditedPdf(
    bytes,
    loaded,
    new Map([[target.id, { lineId: target.id, text: newText, overflow: 'shrink', anchor: 'left' }]])
  )

  const before = await renderPage(bytes, target.pageIndex)
  const after = await renderPage(result.bytes, target.pageIndex)
  const d = diff(before, after)

  const name = file.replace(/\.pdf$/, '')
  fs.writeFileSync(path.join(outDir, `${name}.png`), compose(before, after, name).toBuffer('image/png'))

  // The edit must change something, and it must be confined to the line it
  // touched — a stray change elsewhere means the rewrite disturbed the page.
  const expected = {
    x: target.bbox.x * SCALE,
    y: (loaded.model.pages[target.pageIndex].height - target.bbox.y - target.bbox.height) * SCALE,
    w: target.bbox.width * SCALE,
    h: target.bbox.height * SCALE,
  }
  const rotated = loaded.model.pages[target.pageIndex].rotation !== 0
  const changedSomething = d.fraction > 0.00002
  const contained =
    rotated || !d.box
      ? true
      : d.box.y >= expected.y - 12 && d.box.y + d.box.h <= expected.y + expected.h + 12

  const ok = changedSomething && contained
  if (!ok) failures++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(22)} changed=${(d.fraction * 100).toFixed(3)}% ` +
      `box=${d.box ? `${d.box.x},${d.box.y} ${d.box.w}x${d.box.h}` : 'none'} ` +
      `expectedRow=${expected.y.toFixed(0)}..${(expected.y + expected.h).toFixed(0)}` +
      (rotated ? ' (rotated: containment not checked)' : '')
  )
  for (const w of result.warnings) console.log(`       ! ${w.code}`)
}

const ran = cases.length - skipped
console.log(
  `\n${ran - failures}/${ran} rendered as expected` +
    (skipped ? ` (${skipped} skipped)` : '') +
    ` -> ${outDir}`
)
process.exit(failures ? 1 : 0)
