/**
 * CMap parsing (ISO 32000-1 §9.7.5, §9.10.3 and the Adobe CMap specification).
 *
 * Handles both flavours we care about:
 *  - `/ToUnicode` CMaps, which map character codes to Unicode strings; and
 *  - CID CMaps used as a Type0 font's `/Encoding`, which map codes to CIDs.
 *
 * Both share the same syntax, so one parser covers them. Codes of different
 * byte lengths are kept in separate tables because a 1-byte 0x41 and a 2-byte
 * 0x0041 are different codes that happen to share a numeric value.
 */
import { ContentLexer, type CSObject } from './lexer'

export interface CodespaceRange {
  low: number
  high: number
  byteLen: number
}

export interface DecodedCode {
  code: number
  byteLen: number
  /** True when the bytes did not fall inside any declared codespace range. */
  outOfRange: boolean
}

const MAX_CODE_BYTES = 4

function bytesToInt(bytes: Uint8Array, start: number, len: number): number {
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + (bytes[start + i] ?? 0)
  return v
}

/** UTF-16BE bytes to a JS string, joining surrogate pairs. */
export function utf16beToString(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  }
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1])
  return out
}

export class CMap {
  /** Declared codespace ranges. Empty means "assume single byte". */
  readonly codespaces: CodespaceRange[] = []
  /** byteLen -> (code -> destination string). Used by ToUnicode CMaps. */
  private readonly uni: Array<Map<number, string>> = []
  /** byteLen -> (code -> CID). Used by encoding CMaps. */
  private readonly cids: Array<Map<number, number>> = []
  /** Set when the CMap declares `/Identity-H` / `/Identity-V` semantics. */
  identity = false
  vertical = false
  /** `usecmap` target name, if any — reported so callers can warn. */
  useCMap: string | null = null

  constructor() {
    for (let i = 0; i <= MAX_CODE_BYTES; i++) {
      this.uni.push(new Map())
      this.cids.push(new Map())
    }
  }

  static identityH(vertical = false): CMap {
    const m = new CMap()
    m.identity = true
    m.vertical = vertical
    m.codespaces.push({ low: 0, high: 0xffff, byteLen: 2 })
    return m
  }

  /** A CMap standing in for a simple font: every byte is its own code. */
  static singleByte(): CMap {
    const m = new CMap()
    m.codespaces.push({ low: 0, high: 0xff, byteLen: 1 })
    return m
  }

  get hasUnicode(): boolean {
    return this.uni.some((m) => m.size > 0)
  }

  setUnicode(code: number, byteLen: number, value: string): void {
    if (byteLen < 1 || byteLen > MAX_CODE_BYTES) return
    this.uni[byteLen].set(code, value)
  }

  setCid(code: number, byteLen: number, cid: number): void {
    if (byteLen < 1 || byteLen > MAX_CODE_BYTES) return
    this.cids[byteLen].set(code, cid)
  }

  lookupUnicode(code: number, byteLen: number): string | undefined {
    return this.uni[byteLen]?.get(code)
  }

  lookupCid(code: number, byteLen: number): number | undefined {
    if (this.identity) return code
    return this.cids[byteLen]?.get(code)
  }

  /** Every (code, byteLen, unicode) entry, for building reverse maps. */
  *unicodeEntries(): Generator<{ code: number; byteLen: number; value: string }> {
    for (let byteLen = 1; byteLen <= MAX_CODE_BYTES; byteLen++) {
      for (const [code, value] of this.uni[byteLen]) yield { code, byteLen, value }
    }
  }

  /** The byte length a code of `n` bytes would occupy, per the codespaces. */
  get defaultCodeLength(): number {
    if (this.codespaces.length === 0) return 1
    let min = MAX_CODE_BYTES
    for (const cs of this.codespaces) min = Math.min(min, cs.byteLen)
    return min
  }

  /**
   * Split a string operand into character codes (ISO 32000-1 §9.7.6.2).
   *
   * The spec's matching rule: try successively longer byte sequences; if none
   * lands inside a codespace range, consume as many bytes as the range whose
   * first-byte span contains this byte, so that a malformed code still resyncs.
   */
  decode(bytes: Uint8Array): DecodedCode[] {
    const out: DecodedCode[] = []
    if (this.codespaces.length === 0) {
      for (let i = 0; i < bytes.length; i++) {
        out.push({ code: bytes[i], byteLen: 1, outOfRange: false })
      }
      return out
    }
    let i = 0
    while (i < bytes.length) {
      let matched = false
      for (let n = 1; n <= MAX_CODE_BYTES && i + n <= bytes.length; n++) {
        const code = bytesToInt(bytes, i, n)
        for (const cs of this.codespaces) {
          if (cs.byteLen === n && code >= cs.low && code <= cs.high) {
            out.push({ code, byteLen: n, outOfRange: false })
            i += n
            matched = true
            break
          }
        }
        if (matched) break
      }
      if (matched) continue

      // No exact hit — pick the codespace whose leading byte range covers this
      // byte, so we consume the right number of bytes and stay in sync.
      const b = bytes[i]
      let take = this.defaultCodeLength
      for (const cs of this.codespaces) {
        const shift = (cs.byteLen - 1) * 8
        const lowFirst = Math.floor(cs.low / 2 ** shift)
        const highFirst = Math.floor(cs.high / 2 ** shift)
        if (b >= lowFirst && b <= highFirst) {
          take = cs.byteLen
          break
        }
      }
      take = Math.max(1, Math.min(take, bytes.length - i))
      out.push({ code: bytesToInt(bytes, i, take), byteLen: take, outOfRange: true })
      i += take
    }
    return out
  }
}

const isString = (o: CSObject | undefined): o is { type: 'string'; bytes: Uint8Array; hex: boolean } =>
  !!o && o.type === 'string'

/**
 * Parse a CMap program. Accepts both `bf*` (ToUnicode) and `cid*` sections.
 *
 * Rather than implement a PostScript interpreter, we scan the operator stream
 * for the `begin…/end…` section keywords — which is how every real-world CMap
 * is structured and what other implementations do.
 */
export function parseCMap(source: Uint8Array): CMap {
  const cmap = new CMap()
  const lexer = new ContentLexer(source)
  // A rolling operand window: CMap sections put their data *before* the
  // `endbfchar`-style keyword, batched between `begin`/`end`.
  let pending: CSObject[] = []
  let section: string | null = null

  const asInt = (o: CSObject | undefined): { value: number; byteLen: number } | null => {
    if (isString(o)) return { value: bytesToInt(o.bytes, 0, o.bytes.length), byteLen: o.bytes.length }
    if (o && o.type === 'number') return { value: o.value, byteLen: 2 }
    return null
  }

  const destString = (o: CSObject | undefined): string | null => {
    if (isString(o)) return utf16beToString(o.bytes)
    if (o && o.type === 'name') return o.value
    return null
  }

  const flush = (): void => {
    if (!section) {
      pending = []
      return
    }
    switch (section) {
      case 'codespacerange': {
        for (let i = 0; i + 1 < pending.length; i += 2) {
          const lo = pending[i]
          const hi = pending[i + 1]
          if (!isString(lo) || !isString(hi)) continue
          cmap.codespaces.push({
            low: bytesToInt(lo.bytes, 0, lo.bytes.length),
            high: bytesToInt(hi.bytes, 0, hi.bytes.length),
            byteLen: lo.bytes.length || 1,
          })
        }
        break
      }
      case 'bfchar': {
        for (let i = 0; i + 1 < pending.length; i += 2) {
          const src = asInt(pending[i])
          const dst = destString(pending[i + 1])
          if (!src || dst === null) continue
          cmap.setUnicode(src.value, src.byteLen, dst)
        }
        break
      }
      case 'bfrange': {
        for (let i = 0; i + 2 < pending.length; i += 3) {
          const lo = asInt(pending[i])
          const hi = asInt(pending[i + 1])
          const dst = pending[i + 2]
          if (!lo || !hi) continue
          const count = Math.min(hi.value - lo.value, 65535)
          if (count < 0) continue
          if (dst && dst.type === 'array') {
            // Form: <lo> <hi> [ <d0> <d1> ... ]
            for (let k = 0; k <= count && k < dst.items.length; k++) {
              const s = destString(dst.items[k])
              if (s !== null) cmap.setUnicode(lo.value + k, lo.byteLen, s)
            }
          } else if (isString(dst)) {
            // Form: <lo> <hi> <dstStart>. Increment the LAST UTF-16 code unit.
            const base = dst.bytes
            // The spec says "increment the last byte"; in practice producers
            // mean the last UTF-16 code unit, which is what every reader does.
            const baseStr = utf16beToString(base)
            const head = baseStr.slice(0, -1)
            const tail = baseStr.length ? baseStr.charCodeAt(baseStr.length - 1) : 0
            for (let k = 0; k <= count; k++) {
              cmap.setUnicode(
                lo.value + k,
                lo.byteLen,
                head + String.fromCharCode((tail + k) & 0xffff)
              )
            }
          } else if (dst && dst.type === 'number') {
            for (let k = 0; k <= count; k++) {
              cmap.setUnicode(lo.value + k, lo.byteLen, String.fromCodePoint(dst.value + k))
            }
          }
        }
        break
      }
      case 'cidchar': {
        for (let i = 0; i + 1 < pending.length; i += 2) {
          const src = asInt(pending[i])
          const dst = pending[i + 1]
          if (!src || !dst || dst.type !== 'number') continue
          cmap.setCid(src.value, src.byteLen, dst.value)
        }
        break
      }
      case 'cidrange': {
        for (let i = 0; i + 2 < pending.length; i += 3) {
          const lo = asInt(pending[i])
          const hi = asInt(pending[i + 1])
          const dst = pending[i + 2]
          if (!lo || !hi || !dst || dst.type !== 'number') continue
          const count = Math.min(hi.value - lo.value, 65535)
          for (let k = 0; k <= count; k++) cmap.setCid(lo.value + k, lo.byteLen, dst.value + k)
        }
        break
      }
    }
    pending = []
  }

  for (const op of lexer.operations()) {
    const name = op.op
    if (name.startsWith('begin') && name.length > 5) {
      section = name.slice(5)
      pending = []
      continue
    }
    if (name.startsWith('end') && name.length > 3) {
      if (section && name.slice(3) === section) {
        pending.push(...op.operands)
        flush()
      }
      section = null
      pending = []
      continue
    }
    if (name === 'usecmap') {
      const prev = op.operands[op.operands.length - 1]
      if (prev && prev.type === 'name') cmap.useCMap = prev.value
      continue
    }
    if (name === 'def') {
      // `/WMode 1 def` — the only `def` we care about.
      const [key, value] = op.operands
      if (key && key.type === 'name' && key.value === 'WMode' && value && value.type === 'number') {
        cmap.vertical = value.value === 1
      }
      continue
    }
    if (section) pending.push(...op.operands)
  }
  // A CMap with no explicit codespace still needs one to decode with.
  if (cmap.codespaces.length === 0) {
    const anyTwoByte = [...cmap.unicodeEntries()].some((e) => e.byteLen === 2)
    cmap.codespaces.push(
      anyTwoByte ? { low: 0, high: 0xffff, byteLen: 2 } : { low: 0, high: 0xff, byteLen: 1 }
    )
  }
  return cmap
}

/** Recognise the predefined Identity CMaps without needing resource files. */
export function predefinedCMap(name: string): CMap | null {
  if (name === 'Identity-H') return CMap.identityH(false)
  if (name === 'Identity-V') return CMap.identityH(true)
  return null
}
