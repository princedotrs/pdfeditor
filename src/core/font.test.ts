import { describe, it, expect, beforeAll } from 'vitest'
import { PDFDocument, PDFName, type PDFContext, type PDFDict } from 'pdf-lib'
import { PdfFont } from './font'
import { latin1ToBytes, bytesToLatin1 } from './lexer'

let context: PDFContext

beforeAll(async () => {
  context = (await PDFDocument.create()).context
})

/** Build a font from a literal dict, registering any streams it needs. */
function makeFont(literal: Record<string, unknown>, streams: Record<string, string> = {}): PdfFont {
  const dict = context.obj(literal as never) as unknown as PDFDict
  for (const [key, body] of Object.entries(streams)) {
    const stream = context.stream(latin1ToBytes(body))
    dict.set(PDFName.of(key), context.register(stream))
  }
  return new PdfFont(context, dict, `test:${Math.random()}`)
}

const toUnicodeCMap = (entries: Array<[number, string]>, byteLen = 2): string => {
  const hex = (n: number, len: number) => n.toString(16).padStart(len * 2, '0').toUpperCase()
  const pairs = entries
    .map(([code, uni]) => {
      const dst = [...uni].map((c) => hex(c.charCodeAt(0), 2)).join('')
      return `<${hex(code, byteLen)}> <${dst}>`
    })
    .join('\n')
  return `1 begincodespacerange <${'00'.repeat(byteLen)}> <${'FF'.repeat(byteLen)}> endcodespacerange
${entries.length} beginbfchar
${pairs}
endbfchar`
}

describe('simple font widths', () => {
  it('reads /Widths relative to /FirstChar', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'Test',
      FirstChar: 65,
      LastChar: 67,
      Widths: [100, 200, 300],
    })
    expect(f.widthOf(65, 1)).toBe(100)
    expect(f.widthOf(66, 1)).toBe(200)
    expect(f.widthOf(67, 1)).toBe(300)
  })

  it('falls back to /MissingWidth outside the range', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'Test',
      FirstChar: 65,
      LastChar: 65,
      Widths: [100],
      FontDescriptor: { Type: 'FontDescriptor', MissingWidth: 42, Flags: 32 },
    })
    expect(f.widthOf(90, 1)).toBe(42)
  })

  it('uses the standard-14 AFM metrics when there is no /Widths', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    expect(f.widthOf(65, 1)).toBe(667) // A
    expect(f.widthOf(32, 1)).toBe(278) // space
    expect(f.widthOf(87, 1)).toBe(944) // W
  })

  it('recognises standard-14 aliases such as ArialMT', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ArialMT' })
    expect(f.standard14).toBe('Helvetica')
    expect(f.widthOf(65, 1)).toBe(667)
  })

  it('scales Type3 widths by the font matrix', () => {
    // A 1/2000-unit glyph space: a width of 1000 is half an em.
    const f = makeFont({
      Type: 'Font',
      Subtype: 'Type3',
      FontMatrix: [0.0005, 0, 0, 0.0005, 0, 0],
      FirstChar: 65,
      LastChar: 65,
      Widths: [1000],
      CharProcs: {},
      Encoding: { Type: 'Encoding', Differences: [65, 'A'] },
    })
    expect(f.isType3).toBe(true)
    expect(f.widthOf(65, 1)).toBeCloseTo(500, 6)
  })
})

describe('simple font encodings', () => {
  it('applies /Differences over a base encoding', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: {
        Type: 'Encoding',
        BaseEncoding: 'WinAnsiEncoding',
        Differences: [65, 'eacute', 'ccedilla'],
      },
    })
    expect(f.unicodeOf(65, 1)).toBe('é')
    expect(f.unicodeOf(66, 1)).toBe('ç')
    expect(f.unicodeOf(67, 1)).toBe('C') // untouched by Differences
  })

  it('decodes a string through the encoding', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    const glyphs = f.decodeString(latin1ToBytes('Hi!'))
    expect(glyphs.map((g) => g.unicode).join('')).toBe('Hi!')
    expect(glyphs[0].offset).toBe(0)
    expect(glyphs[1].offset).toBe(glyphs[0].width)
  })

  it('prefers /ToUnicode over the encoding', () => {
    const f = makeFont(
      { Type: 'Font', Subtype: 'TrueType', BaseFont: 'Test', FirstChar: 1, LastChar: 1, Widths: [500] },
      { ToUnicode: toUnicodeCMap([[1, 'Z']], 1) }
    )
    expect(f.unicodeOf(1, 1)).toBe('Z')
  })
})

describe('Type0 fonts', () => {
  const type0 = (w: unknown[], entries: Array<[number, string]> = [[3, 'a']]) =>
    makeFont(
      {
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Test',
        Encoding: 'Identity-H',
        DescendantFonts: [
          { Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Test', DW: 1000, W: w },
        ],
      },
      { ToUnicode: toUnicodeCMap(entries) }
    )

  it('parses both /W forms', () => {
    const f = type0([3, [226, 326, 401], 17, 25, 507, 26, [337, 337]])
    expect(f.widthOf(3, 2)).toBe(226)
    expect(f.widthOf(5, 2)).toBe(401)
    expect(f.widthOf(20, 2)).toBe(507)
    expect(f.widthOf(26, 2)).toBe(337)
    expect(f.widthOf(27, 2)).toBe(337)
  })

  it('falls back to /DW for CIDs /W does not cover', () => {
    expect(type0([3, [226]]).widthOf(999, 2)).toBe(1000)
  })

  it('lets a later /W entry override an earlier one', () => {
    // Per ISO 32000-1 9.7.4.3 the array is applied in order, so the range
    // written after the single wins.
    expect(type0([5, [500], 0, 10, 700]).widthOf(5, 2)).toBe(700)
    // ...and the reverse order gives the reverse answer.
    expect(type0([0, 10, 700, 5, [500]]).widthOf(5, 2)).toBe(500)
    // A CID the later entry does not cover keeps the earlier value.
    expect(type0([0, 10, 700, 5, [500]]).widthOf(6, 2)).toBe(700)
  })

  it('decodes two-byte Identity-H codes', () => {
    const f = type0([3, [226]], [[3, 'a'], [4, 'b']])
    const glyphs = f.decodeString(new Uint8Array([0x00, 0x03, 0x00, 0x04]))
    expect(glyphs.map((g) => g.unicode).join('')).toBe('ab')
    expect(glyphs.map((g) => g.cid)).toEqual([3, 4])
  })
})

describe('re-encoding Unicode back to the font', () => {
  it('round-trips text through a standard font', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    const enc = f.encode('Hello')
    expect(enc.ok).toBe(true)
    expect(bytesToLatin1(enc.bytes)).toBe('Hello')
    expect(enc.totalWidth).toBe(f.decodeString(latin1ToBytes('Hello')).reduce((a, g) => a + g.width, 0))
    expect(enc.glyphCount).toBe(5)
  })

  it('counts single-byte spaces, which is what Tw applies to', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    expect(f.encode('a b c').wordSpaceCount).toBe(2)
  })

  it('encodes through /Differences back to the right codes', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, 'eacute'] },
    })
    const enc = f.encode('é')
    expect(enc.ok).toBe(true)
    // Both code 1 (via Differences) and 0xE9 (WinAnsi) render é; the lowest wins.
    expect([...enc.bytes]).toEqual([1])
  })

  it('prefers the code the run already used when several map to one character', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, 'eacute'] },
    })
    const hinted = f.encode('é', [{ code: 0xe9, byteLen: 1, unicode: 'é' }])
    expect([...hinted.bytes]).toEqual([0xe9])
  })

  it('reports characters the font cannot draw instead of guessing', () => {
    const f = makeFont(
      {
        Type: 'Font',
        Subtype: 'TrueType',
        BaseFont: 'ABCDEF+Subset',
        FirstChar: 1,
        LastChar: 2,
        Widths: [500, 500],
      },
      { ToUnicode: toUnicodeCMap([[1, 'a'], [2, 'b']], 1) }
    )
    const enc = f.encode('abz')
    expect(enc.ok).toBe(false)
    expect(enc.unmapped.map((u) => u.char)).toEqual(['z'])
    expect([...enc.bytes]).toEqual([1, 2])
  })

  it('does not trust a subset mapping with no corroborating width', () => {
    const f = makeFont(
      {
        Type: 'Font',
        Subtype: 'TrueType',
        BaseFont: 'ABCDEF+Subset',
        FirstChar: 1,
        LastChar: 1,
        Widths: [500],
      },
      { ToUnicode: toUnicodeCMap([[1, 'a'], [9, 'q']], 1) }
    )
    // Code 9 is mapped but outside /Widths, so subsetting probably dropped it.
    expect(f.encode('q').ok).toBe(false)
    expect(f.encode('a').ok).toBe(true)
  })

  it('folds typographic characters the font lacks', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' })
    const enc = f.encode('a‑b') // non-breaking hyphen
    expect(enc.ok).toBe(true)
    expect(bytesToLatin1(enc.bytes)).toBe('a-b')
    expect(enc.warnings.some((w) => w.startsWith('substituted:'))).toBe(true)
  })

  it('never loops or drops characters on astral input', () => {
    const f = makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    const enc = f.encode('a\u{1F600}b')
    expect(enc.ok).toBe(false)
    expect(bytesToLatin1(enc.bytes)).toBe('ab')
    // The emoji is reported once, as one character, not as two surrogates.
    expect(enc.unmapped).toHaveLength(1)
    expect(enc.unmapped[0].char).toBe('\u{1F600}')
  })

  it('encodes Type0 text as two-byte big-endian CIDs', () => {
    const f = makeFont(
      {
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Test',
        Encoding: 'Identity-H',
        DescendantFonts: [{ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Test', DW: 1000, W: [3, [500], 4, [500]] }],
      },
      { ToUnicode: toUnicodeCMap([[3, 'x'], [4, 'y']]) }
    )
    const enc = f.encode('xy')
    expect(enc.ok).toBe(true)
    expect([...enc.bytes]).toEqual([0, 3, 0, 4])
  })

  it('refuses to reuse a Type3 font', () => {
    const f = makeFont({
      Type: 'Font',
      Subtype: 'Type3',
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: {},
      FirstChar: 65,
      LastChar: 65,
      Widths: [500],
      Encoding: { Type: 'Encoding', Differences: [65, 'A'] },
    })
    expect(f.canReuse).toBe(false)
  })

  it('reports the space width used for word-gap detection', () => {
    expect(makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }).spaceWidth).toBe(278)
    expect(makeFont({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' }).spaceWidth).toBe(600)
  })
})
