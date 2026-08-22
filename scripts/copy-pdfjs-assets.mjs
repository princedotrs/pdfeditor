/**
 * pdf.js loads CMaps, standard font data, ICC profiles and its wasm decoders
 * at runtime over HTTP. Vite will not bundle a directory, so copy them into
 * public/pdfjs/ where they are served in dev and emitted on build.
 *
 * Run automatically via the `predev` / `prebuild` npm scripts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const from = path.join(root, 'node_modules/pdfjs-dist')
const to = path.join(root, 'public/pdfjs')

const DIRS = ['cmaps', 'standard_fonts', 'iccs', 'wasm']

fs.rmSync(to, { recursive: true, force: true })
for (const dir of DIRS) {
  const src = path.join(from, dir)
  if (!fs.existsSync(src)) {
    console.warn(`pdfjs-dist/${dir} not found — skipping`)
    continue
  }
  fs.cpSync(src, path.join(to, dir), { recursive: true })
  const count = fs.readdirSync(path.join(to, dir)).length
  console.log(`copied ${dir} (${count} files)`)
}
