/**
 * End-to-end tests over real PDFs: load a fixture, edit a line, export, then
 * re-load the exported bytes and check what actually came out.
 *
 * These are the tests that matter. Unit tests prove the arithmetic; only a
 * round-trip proves that the file a user downloads says what they typed, that
 * the original text is genuinely gone rather than painted over, and that
 * nothing else on the page moved.
 *
 * Run `npm run fixtures` if `fixtures/` is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPdf, type LoadedPdf } from './document'
import { exportEditedPdf } from './export'
import type { LineEdit, TextLine } from './model'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures')

const read = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))

/**
 * Two fixtures embed a TrueType font found on the build machine, so they are
 * not checked in (see .gitignore) and only exist after `npm run fixtures` on a
 * machine that has one. Tests that need them skip rather than fail, so a fresh
 * clone — or a CI box with no fonts installed — still runs green.
 */
const hasFixture = (name: string): boolean => fs.existsSync(path.join(FIXTURES, name))

const edit = (line: TextLine, text: string, over: LineEdit['overflow'] = 'overflow'): Map<string, LineEdit> =>
  new Map([[line.id, { lineId: line.id, text, overflow: over, anchor: 'left' as const }]])

/** Multiset of line texts, so duplicate lines are compared correctly. */
function textCounts(lines: TextLine[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l.text, (counts.get(l.text) ?? 0) + 1)
  return counts
}

async function roundTrip(name: string, pick: (lines: TextLine[]) => TextLine, text: string) {
  const bytes = read(name)
  const before = await loadPdf(bytes)
  const target = pick(before.model.lines)
  const result = await exportEditedPdf(bytes, before, edit(target, text))
  const after = await loadPdf(result.bytes)
  return { before, after, target, result }
}

/**
 * The document's text must be exactly what it was, with one occurrence of the
 * edited line's text swapped for the new text. This catches both "the old text
 * is still there" and "something else got clobbered".
 */
function expectOnlyLineChanged(
  before: LoadedPdf,
  after: LoadedPdf,
  target: TextLine,
  newText: string
): void {
  const expected = textCounts(before.model.lines)
  const oldCount = expected.get(target.text) ?? 0
  if (oldCount <= 1) expected.delete(target.text)
  else expected.set(target.text, oldCount - 1)
  expected.set(newText, (expected.get(newText) ?? 0) + 1)

  expect(Object.fromEntries(textCounts(after.model.lines))).toEqual(
    Object.fromEntries(expected)
  )
}

const editable = (lines: TextLine[], match?: string): TextLine => {
  const found = lines.find(
    (l) => l.blockers.length === 0 && (match ? l.text.includes(match) : l.text.trim().length > 4)
  )
  if (!found) throw new Error(`no editable line${match ? ` matching ${match}` : ''}`)
  return found
}

let hasFixtures = false
beforeAll(() => {
  hasFixtures = fs.existsSync(FIXTURES) && fs.readdirSync(FIXTURES).some((f) => f.endsWith('.pdf'))
  if (!hasFixtures) throw new Error(`fixtures missing — run \`npm run fixtures\` (looked in ${FIXTURES})`)
})

describe('round-trip: text replacement', () => {
  const cases: Array<[string, string | undefined]> = [
    ['simple-helvetica.pdf', 'Simple Helvetica Fixture'],
    ['tj-kerning.pdf', 'Other information'],
    ['multi-op-line.pdf', 'Invoice number'],
    ['embedded-truetype.pdf', 'Text from Differences'],
    ['type0-identity-h.pdf', 'composite'],
    ['cropbox-offset.pdf', undefined],
    ['mediabox-origin.pdf', undefined],
    ['rotated-90.pdf', 'ROTATE MARKER'],
    ['rotated-180.pdf', 'ROTATE MARKER'],
    ['rotated-270.pdf', 'ROTATE MARKER'],
    ['form-xobject.pdf', 'Text inside a Form XObject'],
    ['inline-image.pdf', 'Text before'],
    ['multi-part-contents.pdf', 'Stream one opens'],
    ['unbalanced-q.pdf', 'Before any clip'],
    ['colored-background.pdf', 'Light text on a dark panel'],
    ['text-state.pdf', 'Tz 60'],
    ['invisible-ocr.pdf', 'This caption is visible'],
    ['type3.pdf', 'Result : PASS'],
  ]

  for (const [file, match] of cases) {
    it.skipIf(!hasFixture(file))(`replaces a line in ${file} and removes the original`, async () => {
      const replacement = 'Replaced line 12345'
      const { before, after, target } = await roundTrip(
        file,
        (lines) => editable(lines, match),
        replacement
      )
      expectOnlyLineChanged(before, after, target, replacement)
    })
  }
})

describe('round-trip: geometry is preserved', () => {
  it('keeps the replacement on the original baseline', async () => {
    const { after, target } = await roundTrip(
      'simple-helvetica.pdf',
      (lines) => editable(lines, 'Simple Helvetica Fixture'),
      'Short text'
    )
    const line = after.model.lines.find((l) => l.text === 'Short text')
    expect(line).toBeDefined()
    expect(line!.origin[0]).toBeCloseTo(target.origin[0], 3)
    expect(line!.origin[1]).toBeCloseTo(target.origin[1], 3)
    expect(line!.effectiveSize).toBeCloseTo(target.effectiveSize, 3)
  })

  it('respects the CropBox offset when replacing text', async () => {
    const { after, target } = await roundTrip('cropbox-offset.pdf', (l) => editable(l), 'Moved text')
    const line = after.model.lines.find((l) => l.text === 'Moved text')!
    expect(after.model.pages[0].offsetX).toBe(50)
    expect(line.origin[0]).toBeCloseTo(target.origin[0], 3)
    expect(line.origin[1]).toBeCloseTo(target.origin[1], 3)
  })

  it('keeps rotated pages rotated and the text in place', async () => {
    for (const [file, rotation] of [
      ['rotated-90.pdf', 90],
      ['rotated-180.pdf', 180],
      ['rotated-270.pdf', 270],
    ] as const) {
      const { after, target } = await roundTrip(file, (l) => editable(l, 'ROTATE MARKER'), 'NEW MARKER')
      expect(after.model.pages[0].rotation).toBe(rotation)
      const line = after.model.lines.find((l) => l.text === 'NEW MARKER')!
      expect(line.origin[0]).toBeCloseTo(target.origin[0], 3)
      expect(line.origin[1]).toBeCloseTo(target.origin[1], 3)
    }
  })

  it('preserves the original fill colour', async () => {
    const { after, target } = await roundTrip(
      'colored-background.pdf',
      (l) => editable(l, 'Light text on a dark panel'),
      'Still light on dark'
    )
    const line = after.model.lines.find((l) => l.text === 'Still light on dark')!
    expect(line.fill).toEqual(target.fill)
  })

  it('keeps text inside a Form XObject positioned correctly', async () => {
    const { after, target } = await roundTrip(
      'form-xobject.pdf',
      (l) => editable(l, 'Text inside a Form XObject'),
      'Edited inside the XObject'
    )
    const line = after.model.lines.find((l) => l.text === 'Edited inside the XObject')!
    expect(line.origin[0]).toBeCloseTo(target.origin[0], 2)
    expect(line.origin[1]).toBeCloseTo(target.origin[1], 2)
    expect(line.effectiveSize).toBeCloseTo(target.effectiveSize, 2)
  })
})

describe('round-trip: multi-line and multi-page', () => {
  it('applies several edits on one page independently', async () => {
    const bytes = read('simple-helvetica.pdf')
    const before = await loadPdf(bytes)
    const targets = before.model.lines.filter((l) => l.blockers.length === 0).slice(0, 3)
    const edits = new Map<string, LineEdit>(
      targets.map((l, i) => [
        l.id,
        { lineId: l.id, text: `Edited line ${i}`, overflow: 'overflow' as const, anchor: 'left' as const },
      ])
    )
    const result = await exportEditedPdf(bytes, before, edits)
    const after = await loadPdf(result.bytes)
    const texts = after.model.lines.map((l) => l.text)
    for (let i = 0; i < targets.length; i++) expect(texts).toContain(`Edited line ${i}`)
    for (const t of targets) expect(texts).not.toContain(t.text)
    expect(after.model.lines.length).toBe(before.model.lines.length)
  })

  it('edits one page without disturbing the other', async () => {
    const bytes = read('form-xobject-shared.pdf')
    const before = await loadPdf(bytes)
    const target = before.model.lines.find((l) => l.text.startsWith('Page one'))!
    expect(target.blockers).toEqual([])
    const result = await exportEditedPdf(bytes, before, edit(target, 'Page one edited'))
    const after = await loadPdf(result.bytes)
    const texts = after.model.lines.map((l) => l.text)
    expect(texts).toContain('Page one edited')
    expect(texts).toContain('Page two owns unique text.')
    expect(texts).not.toContain('Page one owns unique text.')
  })

  it('gives every run a document-unique id', async () => {
    const loaded = await loadPdf(read('form-xobject-shared.pdf'))
    const ids = [...loaded.model.runs.keys()]
    expect(new Set(ids).size).toBe(ids.length)
    // Every line must point at runs that actually exist and sit on its page.
    for (const line of loaded.model.lines) {
      for (const id of line.runIds) {
        const run = loaded.model.runs.get(id)
        expect(run, `line ${line.id} references missing run ${id}`).toBeDefined()
        expect(run!.pageIndex).toBe(line.pageIndex)
      }
    }
  })
})

describe('round-trip: safety rails', () => {
  it('refuses to edit text shared across pages', async () => {
    const loaded = await loadPdf(read('form-xobject-shared.pdf'))
    const shared = loaded.model.lines.filter((l) => l.text.includes('SHARED XObject'))
    expect(shared.length).toBeGreaterThan(0)
    for (const l of shared) expect(l.blockers).toContain('shared-xobject')
  })

  it('skips a locked line and says so instead of writing it', async () => {
    const bytes = read('form-xobject-shared.pdf')
    const loaded = await loadPdf(bytes)
    const shared = loaded.model.lines.find((l) => l.blockers.includes('shared-xobject'))!
    const result = await exportEditedPdf(bytes, loaded, edit(shared, 'should not appear'))
    expect(result.stats.linesChanged).toBe(0)
    expect(result.warnings.some((w) => w.code === 'locked-line')).toBe(true)
    const after = await loadPdf(result.bytes)
    expect(after.model.lines.map((l) => l.text)).not.toContain('should not appear')
  })

  it('marks an invisible OCR layer as not editable', async () => {
    const loaded = await loadPdf(read('invisible-ocr.pdf'))
    const hidden = loaded.model.lines.filter((l) => l.text.includes('Invisible OCR'))
    expect(hidden.length).toBeGreaterThan(0)
    for (const l of hidden) expect(l.blockers).toContain('invisible')
    // The genuinely visible caption on the same page stays editable.
    expect(loaded.model.lines.find((l) => l.text.includes('This caption is visible'))!.blockers).toEqual([])
  })

  it('reports a document with no text instead of pretending to edit it', async () => {
    const loaded = await loadPdf(read('no-text.pdf'))
    expect(loaded.model.hasEditableText).toBe(false)
    expect(loaded.model.warnings.some((w) => w.code === 'no-text')).toBe(true)
  })

  it.skipIf(!hasFixture('type0-identity-h.pdf'))('warns when the original font cannot draw the new characters', async () => {
    const bytes = read('type0-identity-h.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'composite')
    // The fixture embeds a subset; Cyrillic is certainly not in it.
    const result = await exportEditedPdf(bytes, loaded, edit(target, 'Привет'))
    expect(result.stats.usedFallbackFont).toBeGreaterThan(0)
    // Helvetica cannot draw Cyrillic either, so the user must be told plainly
    // rather than handed a file with the characters silently missing.
    const unrenderable = result.warnings.find((w) => w.code === 'unrenderable')
    expect(unrenderable).toBeDefined()
    expect(unrenderable!.level).toBe('error')
    expect(unrenderable!.message).toContain('П')
  })

  it.skipIf(!hasFixture('type0-identity-h.pdf'))('uses the fallback font for characters the original lacks but Latin-1 has', async () => {
    const bytes = read('type0-identity-h.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'composite')
    // The subset has no capital Z/X/Q; Helvetica does.
    const result = await exportEditedPdf(bytes, loaded, edit(target, 'ZXQ zxq'))
    expect(result.stats.usedFallbackFont).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.code === 'font-substituted')).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unrenderable')).toBe(false)
    const after = await loadPdf(result.bytes)
    expect(after.model.lines.map((l) => l.text)).toContain('ZXQ zxq')
  })

  it.skipIf(!hasFixture('embedded-truetype.pdf'))('reuses the original font when it can encode the new text', async () => {
    const bytes = read('embedded-truetype.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Plain ASCII')
    const result = await exportEditedPdf(bytes, loaded, edit(target, 'Plain ASCII edited'))
    expect(result.stats.reusedOriginalFont).toBeGreaterThan(0)
    expect(result.stats.usedFallbackFont).toBe(0)
    expect(result.warnings.some((w) => w.code === 'font-substituted')).toBe(false)
  })

  it('produces a byte-identical document when nothing changed', async () => {
    const bytes = read('simple-helvetica.pdf')
    const loaded = await loadPdf(bytes)
    const line = editable(loaded.model.lines)
    const result = await exportEditedPdf(bytes, loaded, edit(line, line.text))
    expect(result.stats.linesChanged).toBe(0)
    const after = await loadPdf(result.bytes)
    expect(after.model.lines.map((l) => l.text)).toEqual(loaded.model.lines.map((l) => l.text))
  })

  it('is deterministic: exporting the same edits twice gives the same result', async () => {
    const bytes = read('tj-kerning.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Other information')
    const a = await exportEditedPdf(bytes, loaded, edit(target, 'Repeatable'))
    const b = await exportEditedPdf(bytes, loaded, edit(target, 'Repeatable'))
    const textsOf = async (u: Uint8Array) => (await loadPdf(u)).model.lines.map((l) => l.text)
    expect(await textsOf(a.bytes)).toEqual(await textsOf(b.bytes))
  })

  it('does not detach the source bytes, so repeated exports keep working', async () => {
    const bytes = read('simple-helvetica.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines)
    await exportEditedPdf(bytes, loaded, edit(target, 'One'))
    const second = await exportEditedPdf(bytes, loaded, edit(target, 'Two'))
    expect((await loadPdf(second.bytes)).model.lines.map((l) => l.text)).toContain('Two')
  })

  it('clears a line when the text is emptied', async () => {
    const bytes = read('simple-helvetica.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Simple Helvetica Fixture')
    const result = await exportEditedPdf(bytes, loaded, edit(target, ''))
    const after = await loadPdf(result.bytes)
    expect(after.model.lines.map((l) => l.text)).not.toContain(target.text)
    expect(after.model.lines.length).toBe(loaded.model.lines.length - 1)
  })
})

/**
 * Type3 glyphs are content-stream procedures rather than outlines, so no *new*
 * glyph can be added to such a font — but the ones it already defines can be
 * re-used, and /CharProcs says exactly which those are. Refusing to edit Type3
 * at all would lock out a whole class of real documents (TeX output, and pages
 * that have been vectorised) for no good reason.
 */
describe('round-trip: Type3 fonts', () => {
  it('reads the text rather than reporting it as unmappable', async () => {
    const loaded = await loadPdf(read('type3.pdf'))
    const line = loaded.model.lines.find((l) => l.text.includes('PASS'))
    expect(line, 'the Type3 line should be found and decoded').toBeDefined()
    expect(line!.text).toBe('Result : PASS Marks : 1090/1800')
    expect(line!.blockers).toEqual([])
  })

  it('edits a Type3 line using the document\'s own Type3 font', async () => {
    const bytes = read('type3.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Result : PASS')
    const replacement = 'Result : FAIL Marks : 0900/1800'
    const result = await exportEditedPdf(bytes, loaded, edit(target, replacement))

    // Every character used is already in /CharProcs, so no substitute is needed.
    expect(result.stats.reusedOriginalFont).toBeGreaterThan(0)
    expect(result.stats.usedFallbackFont).toBe(0)
    expect(result.warnings.some((w) => w.code === 'font-substituted')).toBe(false)

    const after = await loadPdf(result.bytes)
    expectOnlyLineChanged(loaded, after, target, replacement)
    const line = after.model.lines.find((l) => l.text === replacement)!
    expect(line.origin[0]).toBeCloseTo(target.origin[0], 3)
    expect(line.origin[1]).toBeCloseTo(target.origin[1], 3)
  })

  it('keeps the fill colour of a Type3 line', async () => {
    const { after, target } = await roundTrip(
      'type3.pdf',
      (l) => editable(l, 'Audit 1'),
      'Audit 1 : Pending Audit 2 : Cleared'
    )
    expect(target.fill).toEqual({ r: 0, g: 0, b: 0.8 })
    const line = after.model.lines.find((l) => l.text === 'Audit 1 : Pending Audit 2 : Cleared')!
    expect(line.fill).toEqual(target.fill)
  })

  it('falls back when the Type3 font has no procedure for a character', async () => {
    const bytes = read('type3.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Result : PASS')
    // The fixture defines letters, digits and a little punctuation — no '%'.
    const result = await exportEditedPdf(bytes, loaded, edit(target, 'Result : 95% overall'))
    expect(result.stats.usedFallbackFont).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.code === 'font-substituted')).toBe(true)
    const after = await loadPdf(result.bytes)
    expect(after.model.lines.map((l) => l.text)).toContain('Result : 95% overall')
  })

  it('measures Type3 widths through the font matrix', async () => {
    const loaded = await loadPdf(read('type3.pdf'))
    const line = loaded.model.lines.find((l) => l.text.includes('PASS'))!
    // 31 characters at 14pt with widths of 560/1000 (300 for space, 340 for
    // colon and slash) lands in this range; a missing FontMatrix scale would
    // put it out by a factor of 1000.
    expect(line.width).toBeGreaterThan(150)
    expect(line.width).toBeLessThan(300)
  })
})

describe('round-trip: text state is reproduced', () => {
  it('keeps character and word spacing, so the line does not narrow', async () => {
    // text-state.pdf draws this line with Tc 2 and Tw 6. Redrawing it without
    // them would collapse it to a fraction of its original width.
    const { after, target } = await roundTrip(
      'text-state.pdf',
      (l) => editable(l, 'Tc 2 and Tw 6'),
      'Tc 2 and Tw 6 edited here'
    )
    const line = after.model.lines.find((l) => l.text === 'Tc 2 and Tw 6 edited here')!
    // Per-character width varies a little with the glyph mix, but dropping
    // Tc 2 / Tw 6 at 16pt would narrow it by roughly 40%.
    const perChar = target.width / target.text.length
    const newPerChar = line.width / line.text.length
    expect(newPerChar / perChar).toBeGreaterThan(0.85)
    expect(newPerChar / perChar).toBeLessThan(1.15)
  })

  it('keeps horizontal scaling', async () => {
    const { after, target } = await roundTrip(
      'text-state.pdf',
      (l) => editable(l, 'Tz 60'),
      'Tz 60: still condensed'
    )
    const line = after.model.lines.find((l) => l.text === 'Tz 60: still condensed')!
    const ratio = line.width / line.text.length / (target.width / target.text.length)
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(1.15)
  })
})

describe('round-trip: overflow handling', () => {
  const long = 'This replacement text is considerably longer than the line it replaces'

  const exportWith = async (over: LineEdit['overflow'], text: string) => {
    const bytes = read('simple-helvetica.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Simple Helvetica Fixture')
    const result = await exportEditedPdf(
      bytes,
      loaded,
      new Map([[target.id, { lineId: target.id, text, overflow: over, anchor: 'left' as const }]])
    )
    const after = await loadPdf(result.bytes)
    return { target, result, line: after.model.lines.find((l) => l.text === text)! }
  }

  it('shrinks the font toward the original width', async () => {
    const plain = await exportWith('overflow', long)
    const shrunk = await exportWith('shrink', long)
    expect(shrunk.line.effectiveSize).toBeLessThan(plain.target.effectiveSize)
    expect(shrunk.line.width).toBeLessThan(plain.line.width)
  })

  it('condenses horizontally without changing the em height', async () => {
    const plain = await exportWith('overflow', long)
    const condensed = await exportWith('condense', long)
    expect(condensed.line.effectiveSize).toBeCloseTo(plain.target.effectiveSize, 1)
    expect(condensed.line.width).toBeLessThan(plain.line.width)
  })

  it('still warns when even the clamped fit overflows', async () => {
    // Shrinking is capped so text never becomes unreadable; when the cap is hit
    // the result genuinely does not fit and the user has to be told.
    const shrunk = await exportWith('shrink', long)
    expect(shrunk.result.warnings.some((w) => w.code === 'overflow')).toBe(true)
  })

  it('leaves a fitting replacement untouched by overflow handling', async () => {
    const fitted = await exportWith('shrink', 'Short')
    expect(fitted.line.effectiveSize).toBeCloseTo(fitted.target.effectiveSize, 3)
    expect(fitted.result.warnings.some((w) => w.code === 'overflow')).toBe(false)
  })

  it('right-anchors a shorter replacement against the original right edge', async () => {
    const bytes = read('simple-helvetica.pdf')
    const loaded = await loadPdf(bytes)
    const target = editable(loaded.model.lines, 'Simple Helvetica Fixture')
    const result = await exportEditedPdf(
      bytes,
      loaded,
      new Map([[target.id, { lineId: target.id, text: 'Short', overflow: 'overflow' as const, anchor: 'right' as const }]])
    )
    const after = await loadPdf(result.bytes)
    const line = after.model.lines.find((l) => l.text === 'Short')!
    expect(line.origin[0]).toBeGreaterThan(target.origin[0])
    expect(line.origin[0] + line.width).toBeCloseTo(target.origin[0] + target.width, 1)
  })
})
