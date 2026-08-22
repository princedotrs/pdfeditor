import { describe, it, expect } from 'vitest'
import {
  applyReplacements,
  buildDrawBlock,
  escapeName,
  segmentsWidth,
  wrapAndAppend,
  type DrawSegment,
} from './rewrite'
import { bytesToLatin1, latin1ToBytes, parseOperations } from './lexer'
import { IDENTITY, apply, mul, type Matrix } from './matrix'

const bytes = latin1ToBytes
const str = bytesToLatin1

describe('applyReplacements', () => {
  it('splices a single replacement', () => {
    const out = applyReplacements(bytes('abcdef'), [{ start: 2, end: 4, bytes: bytes('XY') }])
    expect(str(out)).toBe('abXYef')
  })

  it('applies several replacements of differing lengths', () => {
    const out = applyReplacements(bytes('one two three'), [
      { start: 4, end: 7, bytes: bytes('SECOND') },
      { start: 0, end: 3, bytes: bytes('1') },
    ])
    expect(str(out)).toBe('1 SECOND three')
  })

  it('supports pure deletion and pure insertion', () => {
    expect(str(applyReplacements(bytes('abcdef'), [{ start: 2, end: 4, bytes: bytes('') }]))).toBe('abef')
    expect(str(applyReplacements(bytes('abcdef'), [{ start: 3, end: 3, bytes: bytes('++') }]))).toBe('abc++def')
  })

  it('returns the source untouched when there is nothing to do', () => {
    const src = bytes('abc')
    expect(applyReplacements(src, [])).toBe(src)
  })

  it('collapses byte-identical duplicate replacements', () => {
    const out = applyReplacements(bytes('abcdef'), [
      { start: 2, end: 4, bytes: bytes('XY') },
      { start: 2, end: 4, bytes: bytes('XY') },
    ])
    expect(str(out)).toBe('abXYef')
  })

  it('throws when two different replacements claim the same span', () => {
    expect(() =>
      applyReplacements(bytes('abcdef'), [
        { start: 2, end: 4, bytes: bytes('XY') },
        { start: 2, end: 4, bytes: bytes('ZZ') },
      ])
    ).toThrow(/overlapping/)
  })

  it('throws on overlapping spans rather than corrupting the stream', () => {
    expect(() =>
      applyReplacements(bytes('abcdef'), [
        { start: 1, end: 4, bytes: bytes('X') },
        { start: 3, end: 5, bytes: bytes('Y') },
      ])
    ).toThrow(/overlapping/)
  })

  it('throws on out-of-range spans', () => {
    expect(() => applyReplacements(bytes('abc'), [{ start: 1, end: 9, bytes: bytes('X') }])).toThrow(
      /out of range/
    )
    expect(() => applyReplacements(bytes('abc'), [{ start: 2, end: 1, bytes: bytes('X') }])).toThrow(
      /out of range/
    )
  })

  it('allows abutting replacements', () => {
    const out = applyReplacements(bytes('abcdef'), [
      { start: 0, end: 3, bytes: bytes('X') },
      { start: 3, end: 6, bytes: bytes('Y') },
    ])
    expect(str(out)).toBe('XY')
  })

  it('is binary safe', () => {
    const src = new Uint8Array([0, 1, 2, 255, 254])
    const out = applyReplacements(src, [{ start: 1, end: 3, bytes: new Uint8Array([0x80, 0x00]) }])
    expect([...out]).toEqual([0, 0x80, 0x00, 255, 254])
  })
})

describe('wrapAndAppend', () => {
  it('balances the original content and appends after it', () => {
    const out = str(wrapAndAppend(bytes('q 1 0 0 1 0 0 cm BT ET'), 'q BT ET Q'))
    expect(out.startsWith('q\n')).toBe(true)
    expect(out).toContain('\nQ\n')
    expect(out.trimEnd().endsWith('q BT ET Q')).toBe(true)
  })

  it('still balances when there is nothing to append', () => {
    const out = str(wrapAndAppend(bytes('BT ET'), ''))
    expect(out).toBe('q\nBT ET\nQ\n')
  })
})

describe('buildDrawBlock', () => {
  const seg = (over: Partial<DrawSegment> = {}): DrawSegment => ({
    fontResource: 'F1',
    fontSize: 10,
    fill: null,
    bytes: bytes('AB'),
    width1000: 1000,
    glyphCount: 2,
    spaceCount: 0,
    ...over,
  })

  const base = { charSpacing: 0, wordSpacing: 0 }

  it('emits a self-contained, balanced block', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: [1, 0, 0, 1, 72, 700],
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg()],
      offsetX: 0,
    })
    const ops = parseOperations(bytes(block)).map((o) => o.op)
    expect(ops[0]).toBe('q')
    expect(ops[ops.length - 1]).toBe('Q')
    expect(ops.filter((o) => o === 'q').length).toBe(ops.filter((o) => o === 'Q').length)
    expect(ops.filter((o) => o === 'BT').length).toBe(ops.filter((o) => o === 'ET').length)
    // Text state is stated explicitly rather than inherited from ambient.
    expect(block).toContain('0 Tc')
    expect(block).toContain('0 Tw')
    expect(block).toContain('100 Tz')
  })

  it('reproduces the original character and word spacing', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: [1, 0, 0, 1, 0, 0],
      horizScale: 1,
      charSpacing: 2,
      wordSpacing: 5,
      rise: 0,
      renderMode: 0,
      segments: [seg({ width1000: 1000, glyphCount: 3, spaceCount: 1 }), seg()],
      offsetX: 0,
    })
    expect(block).toContain('2 Tc')
    expect(block).toContain('5 Tw')
    // Advance = glyphs (1000/1000 * 10) + 3 * Tc + 1 * Tw
    const tms = parseOperations(bytes(block)).filter((o) => o.op === 'Tm')
    expect((tms[1].operands[4] as { value: number }).value).toBeCloseTo(10 + 3 * 2 + 5, 6)
  })

  it('emits stroke state only for the stroking render modes', () => {
    const opts = {
      ctm: IDENTITY,
      textMatrix: IDENTITY,
      horizScale: 1,
      charSpacing: 0,
      wordSpacing: 0,
      rise: 0,
      stroke: { r: 1, g: 0, b: 0 },
      lineWidth: 0.5,
      segments: [seg()],
      offsetX: 0,
    }
    expect(buildDrawBlock({ ...opts, renderMode: 0 })).not.toContain('RG')
    const stroked = buildDrawBlock({ ...opts, renderMode: 2 })
    expect(stroked).toContain('1 0 0 RG')
    expect(stroked).toContain('0.5 w')
  })

  it('positions each segment with an explicit Tm so widths cannot cascade', () => {
    const tm: Matrix = [1, 0, 0, 1, 72, 700]
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: tm,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg({ width1000: 500 }), seg({ width1000: 250, fontResource: 'F2' })],
      offsetX: 0,
    })
    const tms = parseOperations(bytes(block))
      .filter((o) => o.op === 'Tm')
      .map((o) => o.operands.map((n) => (n.type === 'number' ? n.value : NaN)))
    expect(tms).toHaveLength(2)
    expect(tms[0][4]).toBeCloseTo(72, 6)
    // Second segment starts one first-segment-advance further along.
    expect(tms[1][4]).toBeCloseTo(72 + (500 / 1000) * 10, 6)
  })

  it('places segments along the baseline of a rotated text matrix', () => {
    // 90 degrees counter-clockwise, origin (100, 200).
    const tm: Matrix = [0, 1, -1, 0, 100, 200]
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: tm,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg({ width1000: 1000 }), seg({ width1000: 1000 })],
      offsetX: 0,
    })
    const tms = parseOperations(bytes(block))
      .filter((o) => o.op === 'Tm')
      .map((o) => o.operands.map((n) => (n.type === 'number' ? n.value : NaN)))
    // Advancing 10 units of text space must move +10 in Y, not in X.
    expect(tms[1][4]).toBeCloseTo(100, 6)
    expect(tms[1][5]).toBeCloseTo(210, 6)
    // Cross-check against the matrix algebra directly.
    const expected = mul([1, 0, 0, 1, 10, 0], tm)
    expect(tms[1][4]).toBeCloseTo(expected[4], 6)
    expect(tms[1][5]).toBeCloseTo(expected[5], 6)
  })

  it('honours the anchor offset', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: [1, 0, 0, 1, 72, 700],
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg()],
      offsetX: 30,
    })
    const tm = parseOperations(bytes(block)).find((o) => o.op === 'Tm')!
    expect((tm.operands[4] as { value: number }).value).toBeCloseTo(102, 6)
  })

  it('scales the advance by the horizontal scaling factor', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: [1, 0, 0, 1, 0, 0],
      horizScale: 0.5,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg({ width1000: 1000 }), seg()],
      offsetX: 0,
    })
    const tms = parseOperations(bytes(block)).filter((o) => o.op === 'Tm')
    expect((tms[1].operands[4] as { value: number }).value).toBeCloseTo(10 * 0.5, 6)
    expect(block).toContain('50 Tz')
  })

  it('emits the fill colour once per change, not per segment', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: IDENTITY,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [
        seg({ fill: { r: 1, g: 0, b: 0 } }),
        seg({ fill: { r: 1, g: 0, b: 0 } }),
        seg({ fill: { r: 0, g: 0, b: 1 } }),
      ],
      offsetX: 0,
    })
    expect(block.match(/rg/g)).toHaveLength(2)
  })

  it('reproduces the CTM so text inside a transformed context lands correctly', () => {
    const ctm: Matrix = [2, 0, 0, 2, 10, 20]
    const block = buildDrawBlock({
      ctm,
      textMatrix: [1, 0, 0, 1, 5, 5],
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg()],
      offsetX: 0,
    })
    const cm = parseOperations(bytes(block)).find((o) => o.op === 'cm')!
    const values = cm.operands.map((o) => (o.type === 'number' ? o.value : NaN))
    expect(values).toEqual([2, 0, 0, 2, 10, 20])
    // The glyph origin ends up where the original run drew it.
    expect(apply(mul([1, 0, 0, 1, 5, 5], ctm), 0, 0)).toEqual([20, 30])
  })

  it('skips empty segments and returns nothing for an empty line', () => {
    expect(buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: IDENTITY,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [],
      offsetX: 0,
    })).toBe('')
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: IDENTITY,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg({ bytes: new Uint8Array(0) })],
      offsetX: 0,
    })
    expect(block).not.toContain('Tj')
  })

  it('writes text as a hex string so any byte is safe', () => {
    const block = buildDrawBlock({
      ctm: IDENTITY,
      textMatrix: IDENTITY,
      horizScale: 1,
      ...base,
      rise: 0,
      renderMode: 0,
      segments: [seg({ bytes: new Uint8Array([0x28, 0x29, 0x5c, 0x00]) })],
      offsetX: 0,
    })
    expect(block).toContain('<28295C00> Tj')
    // And it survives a round trip through the tokenizer intact.
    const op = parseOperations(bytes(block)).find((o) => o.op === 'Tj')!
    expect([...(op.operands[0] as { bytes: Uint8Array }).bytes]).toEqual([0x28, 0x29, 0x5c, 0x00])
  })
})

describe('helpers', () => {
  it('measures segment width in text space', () => {
    const w = { fontResource: 'F', fontSize: 12, fill: null, bytes: new Uint8Array(), width1000: 500, glyphCount: 1, spaceCount: 0 }
    expect(segmentsWidth([w], 1)).toBeCloseTo(6)
    expect(segmentsWidth([w], 0.5)).toBeCloseTo(3)
    // Tc adds per glyph, Tw per single-byte space.
    expect(segmentsWidth([w], 1, 2, 0)).toBeCloseTo(8)
  })

  it('escapes characters that are not legal in a PDF name', () => {
    expect(escapeName('F1')).toBe('F1')
    expect(escapeName('A B')).toBe('A#20B')
    expect(escapeName('a/b#c')).toBe('a#2Fb#23c')
  })
})
