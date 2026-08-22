/**
 * Mapping edited line text back onto the individual runs it came from.
 *
 * A line is frequently several show operators — `[(O)-16(ther i)-20(nfo)]TJ`,
 * or a bold word inside a regular sentence. Rewriting the whole line with one
 * font would silently flatten that formatting, so instead we work out which
 * characters actually changed and leave the rest attributed to their original
 * run, preserving its font, size and colour.
 *
 * A prefix/suffix diff is deliberate rather than a full LCS: it is stable and
 * predictable, and it exactly matches how people edit PDFs in practice — fixing
 * a typo, changing a number, swapping a name.
 */

export interface Distribution {
  /** New text for each run, in the same order as the input. */
  texts: string[]
  /** Index of the run that received inserted characters, or -1 if none. */
  insertedInto: number
  changed: boolean
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

export function distribute(runTexts: readonly string[], newText: string): Distribution {
  const old = runTexts.join('')
  if (old === newText) {
    return { texts: [...runTexts], insertedInto: -1, changed: false }
  }

  let prefix = 0
  while (prefix < old.length && prefix < newText.length && old[prefix] === newText[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < old.length - prefix &&
    suffix < newText.length - prefix &&
    old[old.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1
  }

  // Both loops walk UTF-16 code units, so either can stop between the halves of
  // a surrogate pair. Splitting one there hands a lone surrogate to the encoder
  // and the astral character is silently dropped, so back each boundary off to
  // the nearest code-point boundary.
  if (prefix > 0 && isLowSurrogate(newText.charCodeAt(prefix))) prefix -= 1
  if (suffix > 0 && isHighSurrogate(newText.charCodeAt(newText.length - suffix))) suffix -= 1
  if (prefix + suffix > Math.min(old.length, newText.length)) {
    suffix = Math.max(0, Math.min(old.length, newText.length) - prefix)
  }

  const removeStart = prefix
  const removeEnd = old.length - suffix
  const inserted = newText.slice(prefix, newText.length - suffix)

  // Byte ranges of each run within `old`.
  const bounds: Array<[number, number]> = []
  let at = 0
  for (const t of runTexts) {
    bounds.push([at, at + t.length])
    at += t.length
  }

  // Who receives the inserted characters depends on the kind of edit:
  //  - a replacement puts them in the first run whose text is being replaced,
  //    so "World" -> "Earth" keeps Earth in World's run rather than merging it
  //    into the preceding one;
  //  - a pure insertion extends the run that ends at the caret, so typing at a
  //    boundary inherits the font of the text being extended.
  let owner = -1
  if (removeEnd > removeStart) {
    owner = bounds.findIndex(([a, b]) => b > removeStart && a < removeEnd)
  } else {
    for (let i = 0; i < bounds.length; i++) {
      const [a, b] = bounds[i]
      if (removeStart > a && removeStart <= b) owner = i
    }
  }
  if (owner === -1 && bounds.length > 0) owner = 0

  const texts = runTexts.map((_, i) => {
    const [a, b] = bounds[i]
    let out = ''
    if (a < removeStart) out += old.slice(a, Math.min(b, removeStart))
    if (i === owner) out += inserted
    if (b > removeEnd) out += old.slice(Math.max(a, removeEnd), b)
    return out
  })

  if (bounds.length === 0 && inserted) {
    return { texts: [inserted], insertedInto: 0, changed: true }
  }

  return { texts, insertedInto: owner, changed: true }
}
