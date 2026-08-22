/**
 * Extracts pristine data tables from pdf.js's shipped source maps into
 * src/core/vendor/. These are Apache-2.0 licensed (see vendor/LICENSE-pdfjs).
 *
 * We need the Adobe Glyph List (4300+ names), the standard encoding tables and
 * the AFM metrics for the standard 14 fonts. Reimplementing those by hand would
 * be strictly worse than reusing the reference data, and pdfjs-dist ships full
 * source maps, so the original modules can be recovered verbatim.
 *
 * Run: node scripts/extract-pdfjs-tables.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mapPath = path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs.map')
const outDir = path.join(root, 'src/core/vendor')

const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
const source = (needle) => {
  const i = map.sources.findIndex((s) => s.endsWith(needle))
  if (i === -1) throw new Error(`source not found: ${needle}`)
  return map.sourcesContent[i]
}

fs.mkdirSync(outDir, { recursive: true })

const HEADER = `/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED FROM pdf.js (Apache License 2.0) — do not edit by hand.
 * Regenerate with: node scripts/extract-pdfjs-tables.mjs
 */
`

for (const [file, out] of [
  ['core/encodings.js', 'encodings.js'],
  ['core/glyphlist.js', 'glyphlist.js'],
  ['core/metrics.js', 'metrics.js'],
]) {
  let src = source(file)
  // Strip the Apache banner (re-added via HEADER); keep the rest verbatim.
  src = src.replace(/^\/\* Copyright[\s\S]*?\*\/\n/, '')
  fs.writeFileSync(path.join(outDir, out), HEADER + src)
  console.log(`wrote ${out} (${src.length} bytes)`)
}

// glyphlist.js and metrics.js import one helper from pdf.js's core_utils.
fs.writeFileSync(
  path.join(outDir, 'core_utils.js'),
  HEADER +
    `export function getLookupTableFactory(initializer) {
  let lookup;
  return function () {
    if (initializer) {
      lookup = Object.create(null);
      initializer(lookup);
      initializer = null;
    }
    return lookup;
  };
}
`
)
fs.writeFileSync(
  path.join(outDir, 'core_utils.d.ts'),
  `export declare function getLookupTableFactory<T>(initializer: (lookup: T) => void): () => T\n`
)

/*
 * Sidecar .d.ts files.
 *
 * The declared names are read back out of the generated JS rather than
 * hand-written, so they cannot drift from what pdf.js actually exports. A
 * hand-written list previously claimed a `MacExpertEncoding` export that does
 * not exist; TypeScript believed the declaration and only the bundler caught it.
 */
const exportedNames = (file) => {
  const src = fs.readFileSync(path.join(outDir, file), 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  for (const m of src.matchAll(/export\s+(?:const|function)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1])
  }
  return [...names].sort()
}

const declare = (file, typeFor) => {
  const names = exportedNames(file)
  if (names.length === 0) throw new Error(`no exports found in ${file}`)
  const body = names.map((n) => `export declare const ${n}: ${typeFor(n)}`).join('\n')
  fs.writeFileSync(path.join(outDir, file.replace(/\.js$/, '.d.ts')), body + '\n')
  console.log(`typed ${file}: ${names.join(', ')}`)
}

declare('encodings.js', (n) =>
  n === 'getEncoding' ? '(encodingName: string) => string[] | null' : 'string[]'
)
declare('glyphlist.js', () => '() => Record<string, number>')
declare('metrics.js', (n) =>
  n === 'getFontBasicMetrics'
    ? '() => Record<string, { ascent: number; descent: number; capHeight: number; xHeight?: number }>'
    : '() => Record<string, number | (() => Record<string, number>)>'
)

fs.writeFileSync(
  path.join(outDir, 'LICENSE-pdfjs'),
  `The files encodings.js, glyphlist.js and metrics.js in this directory are
extracted verbatim from Mozilla's pdf.js and are licensed under the
Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
`
)
