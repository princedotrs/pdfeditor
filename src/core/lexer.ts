/**
 * A byte-exact tokenizer for PDF content streams (ISO 32000-1 §7.2, §8-9).
 *
 * Everything is done over raw bytes rather than a decoded string: content
 * streams embed binary string operands and inline image data, so any lossy
 * text decode would corrupt them. Every token records its byte span, which is
 * what makes surgical rewrites possible — we can replace exactly the bytes of
 * one show operator and leave the remaining stream untouched.
 */

export type CSObject =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'string'; bytes: Uint8Array; hex: boolean }
  | { type: 'array'; items: CSObject[] }
  | { type: 'dict'; entries: Map<string, CSObject> }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }

export interface InlineImage {
  dict: Map<string, CSObject>
  /** Byte offset of the first byte of image data (just past `ID` + 1 whitespace). */
  dataStart: number
  /** Byte offset just past the last byte of image data (i.e. at the `EI`). */
  dataEnd: number
}

export interface CSOperation {
  op: string
  operands: CSObject[]
  /** Byte offset of the first operand (or of the operator when there are none). */
  start: number
  /** Byte offset just past the operator token. */
  end: number
  /** Byte offset of the operator token itself. */
  opStart: number
  inlineImage?: InlineImage
}

const WS = new Uint8Array(256)
for (const b of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[b] = 1

const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

/** Sentinel: this token was skipped, read another. */
const SKIP = Symbol('skip')

/** Maximum array/dict nesting we will descend into before flattening. */
const MAX_NESTING = 64

/** Runaway guard on operand accumulation; see `operations()`. */
const MAX_OPERANDS = 1_000_000

const isWhite = (b: number) => WS[b] === 1
const isDelim = (b: number) => DELIM[b] === 1
const isRegular = (b: number) => !isWhite(b) && !isDelim(b)

function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10
  return -1
}

/** Decoding of PDF names, including `#xx` escapes. */
function decodeName(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x23 && i + 2 < bytes.length) {
      const hi = hexVal(bytes[i + 1])
      const lo = hexVal(bytes[i + 2])
      if (hi >= 0 && lo >= 0) {
        out += String.fromCharCode(hi * 16 + lo)
        i += 2
        continue
      }
    }
    out += String.fromCharCode(b)
  }
  return out
}

export class ContentLexer {
  readonly buf: Uint8Array
  pos: number

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf
    this.pos = pos
  }

  atEnd(): boolean {
    return this.pos >= this.buf.length
  }

  /** Advance past whitespace and `%` comments. */
  skipTrivia(): void {
    const { buf } = this
    while (this.pos < buf.length) {
      const b = buf[this.pos]
      if (isWhite(b)) {
        this.pos++
      } else if (b === 0x25 /* % */) {
        while (this.pos < buf.length && buf[this.pos] !== 0x0a && buf[this.pos] !== 0x0d) {
          this.pos++
        }
      } else {
        return
      }
    }
  }

  private readLiteralString(): Uint8Array {
    const { buf } = this
    this.pos++ // consume '('
    const out: number[] = []
    let depth = 1
    while (this.pos < buf.length) {
      const b = buf[this.pos++]
      if (b === 0x5c /* \ */) {
        if (this.pos >= buf.length) break
        const e = buf[this.pos++]
        switch (e) {
          case 0x6e: out.push(0x0a); break // \n
          case 0x72: out.push(0x0d); break // \r
          case 0x74: out.push(0x09); break // \t
          case 0x62: out.push(0x08); break // \b
          case 0x66: out.push(0x0c); break // \f
          case 0x28: out.push(0x28); break // \(
          case 0x29: out.push(0x29); break // \)
          case 0x5c: out.push(0x5c); break // backslash
          case 0x0d: // line continuation: \<CR>, \<CR><LF>
            if (this.pos < buf.length && buf[this.pos] === 0x0a) this.pos++
            break
          case 0x0a: // line continuation: \<LF>
            break
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30
              for (let k = 0; k < 2 && this.pos < buf.length; k++) {
                const d = buf[this.pos]
                if (d < 0x30 || d > 0x37) break
                v = v * 8 + (d - 0x30)
                this.pos++
              }
              out.push(v & 0xff)
            } else {
              // Unknown escape: the backslash is dropped, the byte kept.
              out.push(e)
            }
        }
        continue
      }
      if (b === 0x28) {
        depth++
        out.push(b)
        continue
      }
      if (b === 0x29) {
        depth--
        if (depth === 0) break
        out.push(b)
        continue
      }
      if (b === 0x0d) {
        // CR and CRLF inside a literal string both mean a single LF.
        if (this.pos < buf.length && buf[this.pos] === 0x0a) this.pos++
        out.push(0x0a)
        continue
      }
      out.push(b)
    }
    return Uint8Array.from(out)
  }

  private readHexString(): Uint8Array {
    const { buf } = this
    this.pos++ // consume '<'
    const out: number[] = []
    let hi = -1
    while (this.pos < buf.length) {
      const b = buf[this.pos++]
      if (b === 0x3e /* > */) break
      const v = hexVal(b)
      if (v < 0) continue // whitespace and junk are ignored
      if (hi < 0) hi = v
      else {
        out.push(hi * 16 + v)
        hi = -1
      }
    }
    if (hi >= 0) out.push(hi * 16) // odd digit count: pad with a trailing 0
    return Uint8Array.from(out)
  }

  private readNameToken(): string {
    const { buf } = this
    this.pos++ // consume '/'
    const start = this.pos
    while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++
    return decodeName(buf.subarray(start, this.pos))
  }

  private readKeyword(): string {
    const { buf } = this
    const start = this.pos
    while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++
    if (this.pos === start) this.pos++ // never stall on an unexpected delimiter
    let s = ''
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(buf[i])
    return s
  }

  /**
   * Read one object, or return `null` when the next token is a keyword
   * (operator / `true` / `false` / `null` are disambiguated by the caller).
   *
   * `depth` bounds array/dict nesting. Stray closing delimiters are skipped by
   * looping rather than recursing: a corrupt stream can contain hundreds of
   * thousands of them in a row, and recursion there overflows the stack.
   */
  private readObject(depth = 0): CSObject | { keyword: string } | null {
    for (;;) {
      const result = this.readObjectOnce(depth)
      if (result !== SKIP) return result
    }
  }

  private readObjectOnce(depth: number): CSObject | { keyword: string } | null | typeof SKIP {
    this.skipTrivia()
    if (this.atEnd()) return null
    const { buf } = this
    const b = buf[this.pos]

    if (b === 0x28) return { type: 'string', bytes: this.readLiteralString(), hex: false }

    if (b === 0x3c /* < */) {
      if (buf[this.pos + 1] === 0x3c) {
        this.pos += 2
        if (depth >= MAX_NESTING) {
          this.skipNested(0x3c, 0x3e)
          return { type: 'null' }
        }
        return { type: 'dict', entries: this.readDictBody(depth + 1) }
      }
      return { type: 'string', bytes: this.readHexString(), hex: true }
    }

    if (b === 0x2f /* / */) return { type: 'name', value: this.readNameToken() }

    if (b === 0x5b /* [ */) {
      this.pos++
      if (depth >= MAX_NESTING) {
        this.skipNested(0x5b, 0x5d)
        return { type: 'array', items: [] }
      }
      const items: CSObject[] = []
      for (;;) {
        this.skipTrivia()
        if (this.atEnd()) break
        if (buf[this.pos] === 0x5d /* ] */) {
          this.pos++
          break
        }
        const o = this.readObject(depth + 1)
        if (o === null) break
        if ('keyword' in o) {
          // `true` / `false` / `null` can legally appear inside an array.
          const kw = o.keyword
          if (kw === 'true') items.push({ type: 'bool', value: true })
          else if (kw === 'false') items.push({ type: 'bool', value: false })
          else if (kw === 'null') items.push({ type: 'null' })
          // Anything else is malformed; skip it.
          continue
        }
        items.push(o)
      }
      return { type: 'array', items }
    }

    if (b === 0x5d /* ] */ || b === 0x3e /* > */ || b === 0x29 /* ) */) {
      this.pos++ // stray closer; ignore and try again
      return SKIP
    }

    if (b === 0x7b /* { */ || b === 0x7d /* } */) {
      // PostScript calculator function braces — not valid in page content, but
      // tolerate them so a malformed stream doesn't abort the parse.
      this.pos++
      return SKIP
    }

    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const start = this.pos
      while (this.pos < buf.length && isRegular(buf[this.pos])) this.pos++
      let s = ''
      for (let i = start; i < this.pos; i++) s += String.fromCharCode(buf[i])
      const v = parseFloat(s.replace(/^(--+)/, '-').replace(/(\d)-.*$/, '$1'))
      return { type: 'number', value: Number.isFinite(v) ? v : 0 }
    }

    return { keyword: this.readKeyword() }
  }

  /** Skip past a nesting level we refused to descend into. */
  private skipNested(open: number, close: number): void {
    const { buf } = this
    let level = 1
    while (this.pos < buf.length && level > 0) {
      const b = buf[this.pos++]
      if (b === open) level++
      else if (b === close) level--
    }
  }

  private readDictBody(depth = 0): Map<string, CSObject> {
    const entries = new Map<string, CSObject>()
    const { buf } = this
    for (;;) {
      this.skipTrivia()
      if (this.atEnd()) break
      if (buf[this.pos] === 0x3e && buf[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      if (buf[this.pos] !== 0x2f) {
        // Not a key — resynchronise by consuming one object.
        const skipped = this.readObject(depth)
        if (skipped === null) break
        continue
      }
      const key = this.readNameToken()
      const value = this.readObject(depth)
      if (value === null) break
      if ('keyword' in value) {
        if (value.keyword === 'true') entries.set(key, { type: 'bool', value: true })
        else if (value.keyword === 'false') entries.set(key, { type: 'bool', value: false })
        else entries.set(key, { type: 'null' })
        continue
      }
      entries.set(key, value)
    }
    return entries
  }

  /**
   * Locate the end of inline image data. Uses the declared geometry when the
   * data is unfiltered (exact), otherwise scans for a plausible `EI`.
   */
  /**
   * Locate the end of inline image data.
   *
   * The declared geometry gives an exact answer, but only when we can be sure
   * of the component count: `/CS` may name an entry in the page's `/ColorSpace`
   * resources (ISO 32000-1 Table 93), and guessing 1 component for such a name
   * would under-read the data and resynchronise mid-image — losing the rest of
   * the page's text. So the computed length is used only for colour spaces we
   * actually recognise, and is then verified against the `EI` that must follow.
   * Anything else falls back to scanning.
   */
  private findInlineImageEnd(dict: Map<string, CSObject>, dataStart: number): number {
    const { buf } = this
    const get = (...keys: string[]): CSObject | undefined => {
      for (const k of keys) {
        const v = dict.get(k)
        if (v) return v
      }
      return undefined
    }
    const num = (o: CSObject | undefined): number | undefined =>
      o && o.type === 'number' ? o.value : undefined

    const filter = get('F', 'Filter')
    const hasFilter =
      !!filter && !(filter.type === 'array' && filter.items.length === 0) && filter.type !== 'null'

    if (!hasFilter) {
      const w = num(get('W', 'Width'))
      const h = num(get('H', 'Height'))
      const bpc = num(get('BPC', 'BitsPerComponent')) ?? 8
      const mask = get('IM', 'ImageMask')
      const isMask = mask?.type === 'bool' && mask.value
      const cs = get('CS', 'ColorSpace')

      let comps: number | undefined
      if (isMask) comps = 1
      else if (!cs) comps = 1 // no colour space named: DeviceGray
      else if (cs.type === 'name') {
        switch (cs.value) {
          case 'DeviceGray': case 'G': case 'CalGray': comps = 1; break
          case 'DeviceRGB': case 'RGB': case 'CalRGB': comps = 3; break
          case 'DeviceCMYK': case 'CMYK': comps = 4; break
          default: comps = undefined // a named resource colour space
        }
      }

      if (w !== undefined && h !== undefined && comps !== undefined) {
        const rowBytes = Math.ceil((w * comps * (isMask ? 1 : bpc)) / 8)
        const end = dataStart + rowBytes * h
        // Trust the computed length only if an `EI` really does follow it.
        if (end <= buf.length && this.looksLikeEI(end)) return end
      }
    }

    // Heuristic: whitespace + "EI" + (whitespace | delimiter | EOF).
    for (let i = dataStart; i + 1 < buf.length; i++) {
      if (buf[i] !== 0x45 /* E */ || buf[i + 1] !== 0x49 /* I */) continue
      if (i > dataStart && !isWhite(buf[i - 1])) continue
      const after = i + 2
      if (after < buf.length && !isWhite(buf[after]) && !isDelim(buf[after])) continue
      return i > dataStart && isWhite(buf[i - 1]) ? i - 1 : i
    }
    return buf.length
  }

  /** True when `EI`, optionally preceded by whitespace, sits at `at`. */
  private looksLikeEI(at: number): boolean {
    const { buf } = this
    let i = at
    while (i < buf.length && isWhite(buf[i])) i++
    if (i + 1 >= buf.length) return i >= buf.length
    if (buf[i] !== 0x45 || buf[i + 1] !== 0x49) return false
    const after = i + 2
    return after >= buf.length || isWhite(buf[after]) || isDelim(buf[after])
  }

  private readInlineImage(opStart: number): CSOperation {
    const dict = new Map<string, CSObject>()
    const { buf } = this
    // Key/value pairs until `ID`.
    for (;;) {
      this.skipTrivia()
      if (this.atEnd()) break
      if (buf[this.pos] === 0x2f /* / */) {
        const key = this.readNameToken()
        const value = this.readObject()
        if (value === null) break
        if (!('keyword' in value)) dict.set(key, value)
        else if (value.keyword === 'true') dict.set(key, { type: 'bool', value: true })
        else if (value.keyword === 'false') dict.set(key, { type: 'bool', value: false })
        continue
      }
      const o = this.readObject()
      if (o === null) break
      if ('keyword' in o && o.keyword === 'ID') break
    }
    // Exactly one whitespace byte separates `ID` from the data.
    let dataStart = this.pos
    if (dataStart < buf.length && isWhite(buf[dataStart])) dataStart++
    const dataEnd = this.findInlineImageEnd(dict, dataStart)
    this.pos = dataEnd
    // Consume through the `EI`.
    while (this.pos < buf.length && isWhite(buf[this.pos])) this.pos++
    if (buf[this.pos] === 0x45 && buf[this.pos + 1] === 0x49) this.pos += 2
    return {
      op: 'EI',
      operands: [],
      start: opStart,
      end: this.pos,
      opStart,
      inlineImage: { dict, dataStart, dataEnd },
    }
  }

  /**
   * Iterate the stream as a sequence of `operands... operator` groups.
   * Malformed regions are skipped rather than throwing.
   */
  *operations(): Generator<CSOperation> {
    let operands: CSObject[] = []
    let operandsStart = -1
    while (!this.atEnd()) {
      this.skipTrivia()
      if (this.atEnd()) break
      const tokenStart = this.pos
      const o = this.readObject()
      if (o === null) break
      if (!('keyword' in o)) {
        if (operandsStart < 0) operandsStart = tokenStart
        operands.push(o)
        // A cap here has to be generous. Page content operators take a handful
        // of operands, but the same tokenizer parses CMap programs, where a
        // single `beginbfchar … endbfchar` section legitimately carries
        // thousands — silently dropping the oldest would lose ToUnicode
        // mappings and corrupt text extraction. Operand count is bounded by
        // input length regardless, so this is only a runaway guard.
        if (operands.length > MAX_OPERANDS) operands.splice(0, operands.length - MAX_OPERANDS)
        continue
      }
      const kw = o.keyword
      if (kw === 'true' || kw === 'false') {
        if (operandsStart < 0) operandsStart = tokenStart
        operands.push({ type: 'bool', value: kw === 'true' })
        continue
      }
      if (kw === 'null') {
        if (operandsStart < 0) operandsStart = tokenStart
        operands.push({ type: 'null' })
        continue
      }
      if (kw === '') continue
      if (kw === 'BI') {
        yield this.readInlineImage(operandsStart < 0 ? tokenStart : operandsStart)
        operands = []
        operandsStart = -1
        continue
      }
      yield {
        op: kw,
        operands,
        start: operandsStart < 0 ? tokenStart : operandsStart,
        end: this.pos,
        opStart: tokenStart,
      }
      operands = []
      operandsStart = -1
    }
  }
}

export function parseOperations(buf: Uint8Array): CSOperation[] {
  return [...new ContentLexer(buf).operations()]
}

/* ------------------------------------------------------------------ */
/* Serialisation helpers                                               */
/* ------------------------------------------------------------------ */

const HEX = '0123456789ABCDEF'

/** Serialise bytes as a PDF hex string `<...>`, which is always binary-safe. */
export function toHexString(bytes: Uint8Array): string {
  let s = '<'
  for (const b of bytes) s += HEX[(b >> 4) & 0xf] + HEX[b & 0xf]
  return s + '>'
}

/** Latin-1 view of bytes (used for names/operators, never for text semantics). */
export function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)))
  }
  return s
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function objectToNumber(o: CSObject | undefined): number | undefined {
  return o && o.type === 'number' ? o.value : undefined
}
