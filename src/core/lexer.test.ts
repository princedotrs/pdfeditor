import { describe, it, expect } from 'vitest'
import { parseOperations, latin1ToBytes, bytesToLatin1, toHexString } from './lexer'

const ops = (s: string) => parseOperations(latin1ToBytes(s))

describe('ContentLexer', () => {
  it('parses a simple text object', () => {
    const r = ops('BT /F1 12 Tf 72 720 Td (Hello) Tj ET')
    expect(r.map((o) => o.op)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET'])
    expect(r[1].operands).toEqual([
      { type: 'name', value: 'F1' },
      { type: 'number', value: 12 },
    ])
    const tj = r[3]
    expect(tj.operands[0]).toMatchObject({ type: 'string', hex: false })
    expect(bytesToLatin1((tj.operands[0] as any).bytes)).toBe('Hello')
  })

  it('records exact byte spans for surgery', () => {
    const src = 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET'
    const r = ops(src)
    const tj = r[3]
    expect(src.slice(tj.start, tj.end)).toBe('(Hello) Tj')
    expect(src.slice(tj.opStart, tj.end)).toBe('Tj')
  })

  it('handles nested parens, escapes and octal in literal strings', () => {
    const r = ops(String.raw`((a\)b) (c\\d) (\101\102) (x\
y) (tab\there)) Tj`)
    // The whole thing is one balanced string.
    const s = bytesToLatin1((r[0].operands[0] as any).bytes)
    expect(s).toBe('(a)b) (c\\d) (AB) (xy) (tab\there)')
  })

  it('translates CR and CRLF inside literal strings to LF', () => {
    const r = parseOperations(latin1ToBytes('(a\r\nb\rc) Tj'))
    expect(bytesToLatin1((r[0].operands[0] as any).bytes)).toBe('a\nb\nc')
  })

  it('parses hex strings, ignoring whitespace and padding odd digits', () => {
    const r = ops('<48 65 6C 6C 6F> Tj <41F> Tj')
    expect(bytesToLatin1((r[0].operands[0] as any).bytes)).toBe('Hello')
    expect([...((r[1].operands[0] as any).bytes as Uint8Array)]).toEqual([0x41, 0xf0])
  })

  it('parses TJ arrays with mixed strings and kerns', () => {
    const r = ops('[(A) -250 (W) 120 <42>] TJ')
    const arr = r[0].operands[0] as any
    expect(arr.type).toBe('array')
    expect(arr.items.map((i: any) => (i.type === 'number' ? i.value : bytesToLatin1(i.bytes)))).toEqual([
      'A', -250, 'W', 120, 'B',
    ])
  })

  it('decodes #-escapes in names', () => {
    const r = ops('/A#20B#28 Do')
    expect(r[0].operands[0]).toEqual({ type: 'name', value: 'A B(' })
  })

  it('skips comments', () => {
    const r = ops('% a comment (with parens\n1 0 0 1 0 0 cm % trailing\nQ')
    expect(r.map((o) => o.op)).toEqual(['cm', 'Q'])
  })

  it('parses dictionaries (BDC properties)', () => {
    const r = ops('/OC <</Type /OCMD /Name (x)>> BDC EMC')
    const d = r[0].operands[1] as any
    expect(d.type).toBe('dict')
    expect(d.entries.get('Type')).toEqual({ type: 'name', value: 'OCMD' })
  })

  it('parses booleans and null as operands', () => {
    const r = ops('true false null /X gs')
    expect(r[0].operands.slice(0, 3)).toEqual([
      { type: 'bool', value: true },
      { type: 'bool', value: false },
      { type: 'null' },
    ])
  })

  it('skips inline image data without mis-parsing it as operators', () => {
    // 4x2 1-bit image mask => ceil(4*1/8)=1 byte per row, 2 rows.
    const data = '\x51\x00' // contains bytes that look like operators
    const src = `q BI /W 4 /H 2 /IM true /BPC 1 ID ${data} EI Q BT (ok) Tj ET`
    const r = ops(src)
    expect(r.map((o) => o.op)).toEqual(['q', 'EI', 'Q', 'BT', 'Tj', 'ET'])
    expect(r[1].inlineImage).toBeDefined()
    expect(r[1].inlineImage!.dataEnd - r[1].inlineImage!.dataStart).toBe(2)
    expect(bytesToLatin1((r[4].operands[0] as any).bytes)).toBe('ok')
  })

  it('falls back to scanning when /CS names a resource colour space', () => {
    // /CS /Cs6 could be any number of components, so the byte-count shortcut
    // must not be taken — guessing 1 would resynchronise mid-image and swallow
    // the rest of the page.
    const data = 'ABCDEFGHIJKL' // 4x1 RGB = 12 bytes
    const src = `BI /W 4 /H 1 /CS /Cs6 /BPC 8 ID ${data} EI BT (after) Tj ET`
    const r = ops(src)
    expect(r.map((o) => o.op)).toEqual(['EI', 'BT', 'Tj', 'ET'])
    expect(bytesToLatin1((r[2].operands[0] as any).bytes)).toBe('after')
  })

  it('ignores a computed length that is not followed by EI', () => {
    // Declared 4x1 gray = 4 bytes, but the real payload is longer. Trusting the
    // arithmetic blindly would leave the parser inside the image data.
    const src = 'BI /W 4 /H 1 /CS /DeviceGray /BPC 8 ID abcdefghijkl EI BT (tail) Tj ET'
    const r = ops(src)
    expect(r.map((o) => o.op)).toEqual(['EI', 'BT', 'Tj', 'ET'])
    expect(bytesToLatin1((r[2].operands[0] as any).bytes)).toBe('tail')
  })

  it('uses the exact byte count for a recognised colour space', () => {
    // 4x2 RGB at 8bpc = 24 bytes, deliberately containing an "EI" that a pure
    // scan would stop at.
    const data = 'AB EI CDEFGHIJKLMNOPQRST'
    expect(data.length).toBe(24)
    const src = `BI /W 4 /H 2 /CS /DeviceRGB /BPC 8 ID ${data} EI BT (end) Tj ET`
    const r = ops(src)
    expect(r[0].inlineImage!.dataEnd - r[0].inlineImage!.dataStart).toBe(24)
    expect(bytesToLatin1((r[2].operands[0] as any).bytes)).toBe('end')
  })

  it('finds the end of a filtered inline image heuristically', () => {
    const src = 'BI /W 4 /H 4 /F /AHx ID 4142434445 > EI Q'
    const r = ops(src)
    expect(r.map((o) => o.op)).toEqual(['EI', 'Q'])
  })

  it('tolerates stray closing delimiters', () => {
    const r = ops('] >> ) 1 0 0 1 5 5 cm')
    expect(r[r.length - 1].op).toBe('cm')
  })

  it('does not stall on unexpected bytes', () => {
    const r = ops('@#$ BT ET')
    expect(r.some((o) => o.op === 'BT')).toBe(true)
  })

  it("parses the ' and \" operators", () => {
    const r = ops(`(a) ' 1 2 (b) "`)
    expect(r.map((o) => o.op)).toEqual([`'`, `"`])
    expect(r[1].operands.length).toBe(3)
  })

  it('survives a long run of stray closing delimiters without recursing', () => {
    // A corrupt stream can carry hundreds of thousands of these in a row.
    // Skipping them by recursion overflows the stack; this must not throw.
    for (const ch of [']', ')', '>', '}']) {
      const r = ops(ch.repeat(50_000) + ' 1 0 0 1 5 5 cm')
      expect(r[r.length - 1].op, `after ${ch} x50000`).toBe('cm')
    }
    // 50,000 unterminated arrays swallow the rest of the stream, as any parser
    // must — but it has to terminate rather than overflow the stack.
    expect(() => ops('['.repeat(50_000) + ' 1 0 0 1 5 5 cm')).not.toThrow()
  })

  it('flattens absurdly nested arrays instead of blowing the stack', () => {
    const r = ops('['.repeat(5000) + ']'.repeat(5000) + ' TJ')
    expect(r[r.length - 1].op).toBe('TJ')
  })

  it('keeps every operand of a very large section', () => {
    // CMap sections legitimately carry thousands of operands before their
    // terminating keyword; truncating them would silently drop ToUnicode
    // mappings.
    const pairs = Array.from({ length: 4000 }, (_, i) => `<${i.toString(16).padStart(4, '0')}> <0041>`)
    const r = ops(`beginbfchar ${pairs.join(' ')} endbfchar`)
    const end = r.find((o) => o.op === 'endbfchar')!
    expect(end.operands.length).toBe(8000)
  })

  it('round-trips hex serialisation', () => {
    expect(toHexString(new Uint8Array([0x00, 0xff, 0x41]))).toBe('<00FF41>')
  })
})
