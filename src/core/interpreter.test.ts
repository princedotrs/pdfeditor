import { describe, it, expect, beforeAll } from 'vitest'
import { StandardFonts } from 'pdf-lib'
import { makeHarness, type Harness } from './testkit'
import { neutralizeRun, applyReplacements } from './rewrite'
import { latin1ToBytes, bytesToLatin1 } from './lexer'
import type { TextRun } from './model'

let h: Harness

beforeAll(async () => {
  h = await makeHarness({ F1: StandardFonts.Helvetica, F2: StandardFonts.TimesRomanBold })
})

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('ContentInterpreter', () => {
  it('reads a simple Tj with correct position and width', () => {
    const runs = h.interpret('BT /F1 12 Tf 72 720 Td (Hello) Tj ET')
    expect(runs).toHaveLength(1)
    const r = runs[0]
    expect(r.text).toBe('Hello')
    expect(r.fontName).toBe('F1')
    expect(r.fontSize).toBe(12)
    near(r.origin[0], 72)
    near(r.origin[1], 720)
    // Helvetica: H=722 e=556 l=222 l=222 o=556 => 2278/1000 * 12
    near(r.advance, (2278 / 1000) * 12)
    expect(r.glyphs.map((g) => g.unicode).join('')).toBe('Hello')
  })

  it('accumulates TJ kerning into the advance and the glyph offsets', () => {
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td [(A) -25 (B)] TJ ET')
    const r = runs[0]
    // A small kern is tracking, not a word break, so no space is invented.
    expect(r.text).toBe('AB')
    expect(r.tjAdjustment).toBe(-25)
    // A=667, then +25/1000*10 from the kern, then B starts.
    near(r.glyphs[1].offset, (667 / 1000) * 10 + (25 / 1000) * 10)
    near(r.advance, ((667 + 667) / 1000) * 10 + (25 / 1000) * 10)
  })

  it('reads a wide TJ gap as the word break the producer meant it to be', () => {
    // Helvetica's space is 278/1000, so -278 is a space expressed as kerning.
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td [(Total)-278(amount)-278(due)] TJ ET')
    expect(runs[0].text).toBe('Total amount due')
    // The synthesised spaces are text only; the geometry is untouched.
    near(runs[0].advance, runs[0].glyphs.reduce((a, g) => a + g.width, 0) / 100 + (278 * 2 / 1000) * 10)
  })

  it('does not double a synthesised space next to a real one', () => {
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td [(a)-400( b)] TJ ET')
    expect(runs[0].text).toBe('a b')
  })

  it('applies Tc, Tw and Tz to the advance', () => {
    const runs = h.interpret('BT /F1 10 Tf 2 Tc 5 Tw 50 Tz 0 0 Td (A B) Tj ET')
    const r = runs[0]
    expect(r.horizScale).toBe(0.5)
    // widths: A=667 space=278 B=667 ; Tc on all 3, Tw only on the space
    const expected = ((667 + 278 + 667) / 1000) * 10 + 3 * 2 + 1 * 5
    near(r.advance, expected * 0.5)
  })

  it('tracks Td, TD, T* and TL relative to the line matrix', () => {
    const runs = h.interpret(`BT /F1 10 Tf 14 TL 100 700 Td (a) Tj 0 -20 TD (b) Tj T* (c) Tj ET`)
    expect(runs.map((r) => r.text)).toEqual(['a', 'b', 'c'])
    near(runs[0].origin[1], 700)
    near(runs[1].origin[1], 680)
    // TD set the leading to 20, so T* moves another 20 down.
    near(runs[2].origin[1], 660)
    near(runs[2].origin[0], 100)
  })

  it("handles the ' and \" operators including their side effects", () => {
    const runs = h.interpret(`BT /F1 10 Tf 12 TL 50 500 Td (a) Tj (b) ' 3 1 (c) " ET`)
    expect(runs.map((r) => r.text)).toEqual(['a', 'b', 'c'])
    near(runs[1].origin[1], 488)
    near(runs[2].origin[1], 476)
    expect(runs[2].wordSpacing).toBe(3)
    expect(runs[2].charSpacing).toBe(1)
    expect(runs[2].quote).toEqual({ wordSpacing: 3, charSpacing: 1 })
  })

  it('composes the CTM from cm and restores it on Q', () => {
    const runs = h.interpret(
      'q 2 0 0 2 10 10 cm BT /F1 10 Tf 5 5 Td (a) Tj ET Q BT /F1 10 Tf 5 5 Td (b) Tj ET'
    )
    near(runs[0].origin[0], 10 + 5 * 2)
    near(runs[0].origin[1], 10 + 5 * 2)
    near(runs[0].effectiveSize, 20)
    near(runs[1].origin[0], 5)
    near(runs[1].effectiveSize, 10)
  })

  it('records the fill colour in force', () => {
    const runs = h.interpret('BT 1 0 0 rg /F1 10 Tf 0 0 Td (a) Tj 0.5 g (b) Tj ET')
    expect(runs[0].fill).toEqual({ r: 1, g: 0, b: 0 })
    expect(runs[1].fill).toEqual({ r: 0.5, g: 0.5, b: 0.5 })
  })

  it('captures the render mode, including invisible OCR text', () => {
    const runs = h.interpret('BT 3 Tr /F1 10 Tf 0 0 Td (hidden) Tj ET')
    expect(runs[0].renderMode).toBe(3)
  })

  it('picks up /ActualText from marked content', () => {
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td /Span <</ActualText (real)>> BDC (x) Tj EMC ET')
    expect(runs[0].actualText).toBe('real')
  })

  it('marks a run safe to delete when a positioning op follows', () => {
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td (a) Tj 0 -12 Td (b) Tj ET')
    expect(runs[0].safeDelete).toBe(true) // followed by Td
    expect(runs[1].safeDelete).toBe(true) // followed by ET
  })

  it('marks a run unsafe when another show op follows directly', () => {
    const runs = h.interpret('BT /F1 10 Tf 0 0 Td (a) Tj (b) Tj 0 0 Td (c) Tj ET')
    expect(runs[0].safeDelete).toBe(false)
    expect(runs[1].safeDelete).toBe(true)
  })

  it('records byte spans that map back onto the source', () => {
    const src = 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET'
    const runs = h.interpret(src)
    expect(src.slice(runs[0].start, runs[0].end)).toBe('(Hello) Tj')
  })

  it('ignores show operators outside a text object', () => {
    expect(h.interpret('/F1 10 Tf (a) Tj')).toHaveLength(0)
  })
})

describe('text-space to page-space scale', () => {
  it('accounts for a font size baked into the text matrix', () => {
    // Two ways to draw the same 20pt text: via Tf, and via a scaled Tm with
    // Tf 1. Plenty of producers do the latter, and the page-space advance has
    // to come out the same either way.
    const viaTf = h.interpret('BT /F1 20 Tf 0 700 Td (Wide) Tj ET')[0]
    const viaTm = h.interpret('BT /F1 1 Tf 20 0 0 20 0 700 Tm (Wide) Tj ET')[0]

    near(viaTf.advance * viaTf.textToPageScale, viaTm.advance * viaTm.textToPageScale, 1e-4)
    near(viaTm.effectiveSize, 20)
    near(viaTf.bbox.width, viaTm.bbox.width, 1e-4)
  })

  it('includes the CTM as well as the text matrix', () => {
    const plain = h.interpret('BT /F1 10 Tf 0 0 Td (abc) Tj ET')[0]
    const scaled = h.interpret('q 3 0 0 3 0 0 cm BT /F1 10 Tf 0 0 Td (abc) Tj ET Q')[0]
    near(scaled.textToPageScale, plain.textToPageScale * 3, 1e-6)
  })
})

describe('colour spaces', () => {
  it('reads a Separation tint as ink coverage, not as a grey level', () => {
    // 1 means full colorant, i.e. dark. Treating it as DeviceGray would make it
    // white and the redrawn text invisible.
    const runs = h.interpret('/Sep cs 1 scn BT /F1 10 Tf 0 0 Td (a) Tj ET')
    expect(runs[0].fill).toEqual({ r: 0, g: 0, b: 0 })
    const light = h.interpret('/Sep cs 0 scn BT /F1 10 Tf 0 0 Td (a) Tj ET')
    expect(light[0].fill).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('tracks stroke colour and line width for stroked text', () => {
    const runs = h.interpret('1 0 0 RG 0.75 w BT 2 Tr /F1 10 Tf 0 0 Td (a) Tj ET')
    expect(runs[0].stroke).toEqual({ r: 1, g: 0, b: 0 })
    expect(runs[0].lineWidth).toBe(0.75)
    expect(runs[0].renderMode).toBe(2)
  })
})

/**
 * Text state is part of the graphics state (ISO 32000-1 §9.3), so `Q` has to
 * restore the *resolved* font, not merely its resource name. Getting this wrong
 * measures later runs with one font's widths while labelling them with
 * another's name, which corrupts both the deletion compensation and the
 * re-encoding of edited text — silently, and only in some documents.
 */
describe('graphics state save and restore', () => {
  it('restores the resolved font on Q, not just its name', () => {
    const runs = h.interpret(
      '/F2 20 Tf q /F1 20 Tf BT 0 700 Td (i) Tj ET Q BT 0 600 Td (WWW) Tj ET'
    )
    const inner = runs[0]
    const after = runs[1]
    expect(inner.fontName).toBe('F1')
    expect(after.fontName).toBe('F2')
    // Times-Bold W is 1000/1000; Helvetica W is 944/1000. The advance proves
    // which font's metrics were actually used.
    expect(after.fontKey).not.toBe(inner.fontKey)
    near(after.advance, 3 * 20)

    const timesOnly = h.interpret('/F2 20 Tf BT 0 600 Td (WWW) Tj ET')
    expect(after.fontKey).toBe(timesOnly[0].fontKey)
    near(after.advance, timesOnly[0].advance)
  })

  it('restores the full text state on Q', () => {
    const runs = h.interpret(
      'BT /F1 10 Tf 2 Tc 5 Tw 50 Tz 3 Ts 2 Tr 0 0 Td q 0 Tc 0 Tw 100 Tz 0 Ts 0 Tr (a) Tj Q (b) Tj ET'
    )
    expect(runs[0]).toMatchObject({ charSpacing: 0, wordSpacing: 0, horizScale: 1, rise: 0, renderMode: 0 })
    expect(runs[1]).toMatchObject({ charSpacing: 2, wordSpacing: 5, horizScale: 0.5, rise: 3, renderMode: 2 })
  })
})

/**
 * A Form XObject's content is painted in the graphics state current at the `Do`
 * (ISO 32000-1 §8.10.2). Only the CTM is additionally composed with the form's
 * `/Matrix`.
 */
describe('Form XObject state inheritance', () => {
  let hx: Harness
  beforeAll(async () => {
    hx = await makeHarness(
      { F1: StandardFonts.Helvetica },
      {
        Inherit: { content: 'BT 0 0 Td (Inherited) Tj ET' },
        Own: {
          content: 'BT /FF 12 Tf 0 0 Td (Own) Tj ET',
          fonts: { FF: StandardFonts.Helvetica },
        },
        Shifted: {
          content: 'BT 0 0 Td (Shifted) Tj ET',
          matrix: [1, 0, 0, 1, 50, 20],
        },
      }
    )
  })

  it('inherits the font selected before Do', () => {
    const runs = hx.interpret('/F1 24 Tf 1 0 0 rg q 1 0 0 1 100 500 cm /Inherit Do Q')
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toBe('Inherited')
    expect(runs[0].fontSize).toBe(24)
    near(runs[0].origin[0], 100)
    near(runs[0].origin[1], 500)
  })

  it('inherits the fill colour and text state', () => {
    const runs = hx.interpret('/F1 24 Tf 1 0 0 rg 3 Tc q 1 0 0 1 0 0 cm /Own Do Q')
    expect(runs[0].text).toBe('Own')
    expect(runs[0].fill).toEqual({ r: 1, g: 0, b: 0 })
    expect(runs[0].charSpacing).toBe(3)
    // The form set its own font, which must win over the inherited one.
    expect(runs[0].fontName).toBe('FF')
    expect(runs[0].fontSize).toBe(12)
  })

  it('composes the form /Matrix with the CTM at the Do', () => {
    const runs = hx.interpret('/F1 10 Tf q 2 0 0 2 10 10 cm /Shifted Do Q')
    // form (0,0) -> Matrix -> (50,20) -> CTM -> (10 + 100, 10 + 40)
    near(runs[0].origin[0], 110)
    near(runs[0].origin[1], 50)
    near(runs[0].effectiveSize, 20)
  })

  it('does not leak the form state back to the caller', () => {
    const runs = hx.interpret(
      '/F1 24 Tf 1 0 0 rg q 1 0 0 1 0 0 cm /Own Do Q BT 0 100 Td (after) Tj ET'
    )
    const after = runs[runs.length - 1]
    expect(after.text).toBe('after')
    expect(after.fontName).toBe('F1')
    expect(after.fontSize).toBe(24)
    expect(after.fill).toEqual({ r: 1, g: 0, b: 0 })
  })
})

/**
 * The core invariant: neutralising a run must leave every *other* run in the
 * stream at exactly the position it had before.
 */
describe('neutralizeRun preserves downstream positions', () => {
  const check = (content: string, targetIndex: number) => {
    const before = h.interpret(content)
    const target = before[targetIndex]
    const { bytes, mode } = neutralizeRun(target)
    const patched = applyReplacements(latin1ToBytes(content), [
      { start: target.start, end: target.end, bytes },
    ])
    const after = h.interpret(bytesToLatin1(patched))
    return { before, after, target, mode, patched: bytesToLatin1(patched) }
  }

  const sameGeometry = (a: TextRun, b: TextRun) => {
    expect(b.text).toBe(a.text)
    for (let i = 0; i < 6; i++) near(b.textMatrix[i], a.textMatrix[i], 1e-4)
    near(b.origin[0], a.origin[0], 1e-4)
    near(b.origin[1], a.origin[1], 1e-4)
  }

  it('deletes outright when a positioning op follows', () => {
    const { before, after, mode } = check('BT /F1 10 Tf 0 700 Td (a) Tj 0 -12 Td (b) Tj ET', 0)
    expect(mode).toBe('delete')
    expect(after).toHaveLength(1)
    sameGeometry(before[1], after[0])
  })

  it('compensates with [ N ] TJ when another show op follows', () => {
    const { before, after, mode } = check('BT /F1 10 Tf 0 700 Td (Hello) Tj (World) Tj ET', 0)
    expect(mode).toBe('adjust')
    expect(after).toHaveLength(1)
    sameGeometry(before[1], after[0])
  })

  it('compensates correctly with Tc, Tw and Tz active', () => {
    const { before, after, mode } = check(
      'BT /F1 11 Tf 1.5 Tc 4 Tw 80 Tz 0 700 Td (a b c) Tj (rest) Tj ET',
      0
    )
    expect(mode).toBe('adjust')
    sameGeometry(before[1], after[0])
  })

  it('compensates correctly for a TJ array with kerning', () => {
    const { before, after } = check(
      'BT /F1 12 Tf 0 700 Td [(Ke) -120 (rn) 45 (ing)] TJ (tail) Tj ET',
      0
    )
    sameGeometry(before[1], after[0])
  })

  it('preserves the line matrix so a later T* still lands correctly', () => {
    const { before, after } = check(
      'BT /F1 10 Tf 15 TL 20 700 Td (first) Tj (second) Tj T* (third) Tj ET',
      1
    )
    expect(after.map((r) => r.text)).toEqual(['first', 'third'])
    sameGeometry(before[0], after[0])
    sameGeometry(before[2], after[1])
  })

  it("preserves the T* side effect when neutralising a ' operator", () => {
    const { before, after } = check('BT /F1 10 Tf 13 TL 30 700 Td (a) Tj (b) \' (c) Tj ET', 1)
    expect(after.map((r) => r.text)).toEqual(['a', 'c'])
    sameGeometry(before[2], after[1])
  })

  it('preserves the Tw/Tc side effects when neutralising a " operator', () => {
    const { before, after } = check(
      'BT /F1 10 Tf 13 TL 30 700 Td (a) Tj 7 2 (b) " (c d) Tj ET',
      1
    )
    expect(after.map((r) => r.text)).toEqual(['a', 'c d'])
    sameGeometry(before[2], after[1])
    expect(after[1].wordSpacing).toBe(7)
    expect(after[1].charSpacing).toBe(2)
  })

  it('falls back to invisible rendering when the font size is zero', () => {
    const { after, mode } = check('BT /F1 0 Tf 0 700 Td (a) Tj (b) Tj ET', 0)
    expect(mode).toBe('invisible')
    expect(after[0].renderMode).toBe(3)
  })

  it('neutralises several runs in one pass without drift', () => {
    const content = 'BT /F1 10 Tf 40 700 Td (one) Tj (two) Tj (three) Tj (four) Tj ET'
    const before = h.interpret(content)
    const replacements = [before[0], before[2]].map((r) => ({
      start: r.start,
      end: r.end,
      ...neutralizeRun(r),
    }))
    const patched = applyReplacements(latin1ToBytes(content), replacements)
    const after = h.interpret(bytesToLatin1(patched))
    expect(after.map((r) => r.text)).toEqual(['two', 'four'])
    sameGeometry(before[1], after[0])
    sameGeometry(before[3], after[1])
  })
})
