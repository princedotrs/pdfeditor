import { describe, it, expect } from 'vitest'
import { parseCMap, CMap, predefinedCMap, utf16beToString } from './cmap'
import { latin1ToBytes } from './lexer'

const cm = (s: string) => parseCMap(latin1ToBytes(s))

describe('parseCMap', () => {
  it('parses codespace ranges and bfchar', () => {
    const m = cm(`
      /CIDInit /ProcSet findresource begin
      12 dict begin begincmap
      1 begincodespacerange <00> <FF> endcodespacerange
      2 beginbfchar
      <41> <0041>
      <42> <00420043>
      endbfchar
      endcmap end end
    `)
    expect(m.codespaces).toEqual([{ low: 0, high: 0xff, byteLen: 1 }])
    expect(m.lookupUnicode(0x41, 1)).toBe('A')
    expect(m.lookupUnicode(0x42, 1)).toBe('BC')
  })

  it('parses bfrange with the increment-last-unit form', () => {
    const m = cm('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0003> <0006> <0041> endbfrange')
    expect(m.lookupUnicode(3, 2)).toBe('A')
    expect(m.lookupUnicode(4, 2)).toBe('B')
    expect(m.lookupUnicode(6, 2)).toBe('D')
    expect(m.lookupUnicode(7, 2)).toBeUndefined()
  })

  it('parses bfrange with the array destination form', () => {
    const m = cm('1 beginbfrange <0010> <0012> [<0058> <0059> <005A>] endbfrange')
    expect(m.lookupUnicode(0x10, 2)).toBe('X')
    expect(m.lookupUnicode(0x12, 2)).toBe('Z')
  })

  it('handles surrogate pairs in destinations', () => {
    const m = cm('1 beginbfchar <01> <D83DDE00> endbfchar')
    expect(m.lookupUnicode(1, 1)).toBe('\u{1F600}')
  })

  it('parses cidrange and cidchar sections', () => {
    const m = cm(`
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      1 begincidrange <0020> <0029> 10 endcidrange
      1 begincidchar <0041> 99 endcidchar
    `)
    expect(m.lookupCid(0x20, 2)).toBe(10)
    expect(m.lookupCid(0x25, 2)).toBe(15)
    expect(m.lookupCid(0x41, 2)).toBe(99)
  })

  it('records WMode and usecmap', () => {
    const m = cm('/WMode 1 def /UniJIS-UCS2-H usecmap')
    expect(m.vertical).toBe(true)
    expect(m.useCMap).toBe('UniJIS-UCS2-H')
  })

  it('keeps every entry of a large bfchar section', () => {
    // Regression: a 512-operand cap in the tokenizer silently discarded the
    // earliest mappings of any section with more than 256 entries.
    const n = 1500
    const pairs = Array.from(
      { length: n },
      (_, i) => `<${i.toString(16).padStart(4, '0')}> <${(0x4000 + i).toString(16).padStart(4, '0')}>`
    )
    const m = cm(`1 begincodespacerange <0000> <FFFF> endcodespacerange ${n} beginbfchar ${pairs.join('\n')} endbfchar`)
    expect(m.lookupUnicode(0, 2)).toBe(String.fromCharCode(0x4000))
    expect(m.lookupUnicode(n - 1, 2)).toBe(String.fromCharCode(0x4000 + n - 1))
    expect([...m.unicodeEntries()].length).toBe(n)
  })

  it('keeps every entry of a large cidrange section', () => {
    const n = 800
    const ranges = Array.from(
      { length: n },
      (_, i) => `<${(i * 2).toString(16).padStart(4, '0')}> <${(i * 2 + 1).toString(16).padStart(4, '0')}> ${i * 2}`
    )
    const m = cm(`1 begincodespacerange <0000> <FFFF> endcodespacerange ${n} begincidrange ${ranges.join(' ')} endcidrange`)
    expect(m.lookupCid(0, 2)).toBe(0)
    expect(m.lookupCid((n - 1) * 2, 2)).toBe((n - 1) * 2)
  })

  it('infers a codespace when none is declared', () => {
    const m = cm('1 beginbfchar <0041> <0041> endbfchar')
    expect(m.codespaces).toEqual([{ low: 0, high: 0xffff, byteLen: 2 }])
  })
})

describe('CMap.decode', () => {
  it('decodes two-byte codes for Identity-H', () => {
    const m = CMap.identityH()
    const r = m.decode(new Uint8Array([0x00, 0x41, 0x01, 0x02]))
    expect(r).toEqual([
      { code: 0x0041, byteLen: 2, outOfRange: false },
      { code: 0x0102, byteLen: 2, outOfRange: false },
    ])
    expect(m.lookupCid(0x0102, 2)).toBe(0x0102)
  })

  it('decodes single-byte codes for simple fonts', () => {
    const r = CMap.singleByte().decode(new Uint8Array([0x41, 0x42]))
    expect(r.map((x) => x.code)).toEqual([0x41, 0x42])
  })

  it('handles mixed-length codespaces', () => {
    const m = cm('2 begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange')
    const r = m.decode(new Uint8Array([0x41, 0x81, 0x40, 0x20]))
    expect(r.map((x) => [x.code, x.byteLen])).toEqual([
      [0x41, 1],
      [0x8140, 2],
      [0x20, 1],
    ])
  })

  it('resyncs on codes outside every codespace', () => {
    const m = cm('1 begincodespacerange <0000> <00FF> endcodespacerange')
    const r = m.decode(new Uint8Array([0x00, 0x02, 0xff, 0xfe]))
    // In range: two bytes, value <= 0x00FF.
    expect(r[0]).toEqual({ code: 0x0002, byteLen: 2, outOfRange: false })
    // Out of range, but still consumed two bytes so the stream stays in sync.
    expect(r[1]).toEqual({ code: 0xfffe, byteLen: 2, outOfRange: true })
  })

  it('never loops forever on truncated input', () => {
    const m = CMap.identityH()
    expect(m.decode(new Uint8Array([0x00])).length).toBe(1)
  })
})

describe('helpers', () => {
  it('recognises the predefined Identity CMaps', () => {
    expect(predefinedCMap('Identity-H')?.identity).toBe(true)
    expect(predefinedCMap('Identity-V')?.vertical).toBe(true)
    expect(predefinedCMap('UniGB-UCS2-H')).toBeNull()
  })

  it('decodes UTF-16BE', () => {
    expect(utf16beToString(new Uint8Array([0x00, 0x41, 0x00, 0x42]))).toBe('AB')
  })
})
