/**
 * Small, forgiving accessors over pdf-lib's object model.
 *
 * pdf-lib's typed `lookup` overloads throw on a type mismatch, which is the
 * wrong behaviour when walking arbitrary real-world PDFs — a malformed entry
 * should degrade, not abort the whole document. Everything here returns
 * `undefined` instead.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib'

export function resolve(context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj === undefined) return undefined
  try {
    return obj instanceof PDFRef ? context.lookup(obj) : obj
  } catch {
    return undefined
  }
}

export function dictGet(
  context: PDFContext,
  dict: PDFDict | undefined,
  key: string
): PDFObject | undefined {
  if (!dict) return undefined
  try {
    return resolve(context, dict.get(PDFName.of(key)))
  } catch {
    return undefined
  }
}

export function asDict(obj: PDFObject | undefined): PDFDict | undefined {
  if (obj instanceof PDFDict) return obj
  // A stream's dict is often what callers want (e.g. a Form XObject).
  if (obj instanceof PDFStream) return obj.dict
  return undefined
}

export function asArray(obj: PDFObject | undefined): PDFArray | undefined {
  return obj instanceof PDFArray ? obj : undefined
}

export function asNumber(obj: PDFObject | undefined): number | undefined {
  return obj instanceof PDFNumber ? obj.asNumber() : undefined
}

export function asName(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.asString().replace(/^\//, '') : undefined
}

export function asBool(obj: PDFObject | undefined): boolean | undefined {
  if (obj instanceof PDFBool) return obj.asBoolean()
  return undefined
}

export function asText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText()
    } catch {
      return undefined
    }
  }
  return undefined
}

export function dictNumber(context: PDFContext, dict: PDFDict | undefined, key: string): number | undefined {
  return asNumber(dictGet(context, dict, key))
}

export function dictName(context: PDFContext, dict: PDFDict | undefined, key: string): string | undefined {
  return asName(dictGet(context, dict, key))
}

export function dictDict(context: PDFContext, dict: PDFDict | undefined, key: string): PDFDict | undefined {
  return asDict(dictGet(context, dict, key))
}

export function dictArray(context: PDFContext, dict: PDFDict | undefined, key: string): PDFArray | undefined {
  return asArray(dictGet(context, dict, key))
}

/** Numbers from a PDF array, resolving indirect elements. */
export function numbersFrom(context: PDFContext, arr: PDFArray | undefined): (number | undefined)[] {
  if (!arr) return []
  const out: (number | undefined)[] = []
  for (let i = 0; i < arr.size(); i++) {
    out.push(asNumber(resolve(context, arr.get(i))))
  }
  return out
}

/** Elements of a PDF array, resolved. */
export function elementsOf(context: PDFContext, arr: PDFArray | undefined): (PDFObject | undefined)[] {
  if (!arr) return []
  const out: (PDFObject | undefined)[] = []
  for (let i = 0; i < arr.size(); i++) out.push(resolve(context, arr.get(i)))
  return out
}

/** Fully decoded bytes of a stream, applying its /Filter chain. */
export function streamBytes(obj: PDFObject | undefined): Uint8Array | undefined {
  try {
    if (obj instanceof PDFRawStream) return decodePDFRawStream(obj).decode()
    if (obj instanceof PDFStream) {
      const anyStream = obj as unknown as { getUnencodedContents?: () => Uint8Array }
      if (typeof anyStream.getUnencodedContents === 'function') return anyStream.getUnencodedContents()
      return obj.getContents()
    }
  } catch {
    return undefined
  }
  return undefined
}

/** A stable identity string for an object, used to key caches. */
export function refKey(obj: PDFObject | undefined, fallback: string): string {
  if (obj instanceof PDFRef) return obj.tag
  return fallback
}

/** The ref a dict entry points at, without resolving it. */
export function rawRef(dict: PDFDict | undefined, key: string): PDFRef | undefined {
  if (!dict) return undefined
  const v = dict.get(PDFName.of(key))
  return v instanceof PDFRef ? v : undefined
}

export function joinBytes(parts: Uint8Array[], separator?: number): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  if (separator !== undefined && parts.length > 1) total += parts.length - 1
  const out = new Uint8Array(total)
  let at = 0
  parts.forEach((p, i) => {
    if (separator !== undefined && i > 0) out[at++] = separator
    out.set(p, at)
    at += p.length
  })
  return out
}
