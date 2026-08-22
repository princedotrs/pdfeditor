/**
 * Turning a PDF font descriptor into something the browser can actually draw.
 *
 * We are never going to match the embedded font exactly — that is what the
 * rendered preview is for. What we need is a stack that is *metrically close
 * enough* that an in-place editable box sits convincingly on top of the glyphs
 * it is covering, and that keeps serif text serif and monospace text monospace.
 */
import type { RGB, TextLine } from '../core/model'

const SERIF = '"Times New Roman", Times, "Liberation Serif", Georgia, serif'
const SANS = 'Helvetica, Arial, "Liberation Sans", "Helvetica Neue", sans-serif'
const MONO = '"Courier New", Courier, "Liberation Mono", monospace'
const NARROW = '"Arial Narrow", "Helvetica Narrow", Helvetica, Arial, sans-serif'

/**
 * Map a PDF font family name onto a web font stack.
 *
 * The base-14 names are matched first because they are exact, then we fall
 * back to keyword sniffing on the family name, which is what subset fonts
 * ("ABCDEF+MinionPro-Regular") give us once the subset tag is stripped.
 */
export function fontStack(family: string): string {
  const name = family.replace(/^[A-Z]{6}\+/, '').toLowerCase()

  if (/courier|mono|consol|menlo/.test(name)) return MONO
  if (/narrow|condensed/.test(name)) return NARROW
  if (/symbol/.test(name)) return '"Segoe UI Symbol", Symbol, serif'
  if (/zapf|dingbat/.test(name)) return '"Zapf Dingbats", "Segoe UI Symbol", serif'
  if (
    /times|serif|roman|georgia|garamond|minion|caslon|baskerville|book|cambria|palatino|century|utopia|charter/.test(
      name
    )
  ) {
    return SERIF
  }
  if (
    /helvetica|arial|sans|verdana|tahoma|calibri|segoe|frutiger|myriad|univers|futura|gill|lato|roboto|open/.test(
      name
    )
  ) {
    return SANS
  }
  // Unknown embedded font: sans is the least surprising default for body text.
  return SANS
}

/** A CSS `font` shorthand, which is what canvas metrics measurement needs. */
export function fontShorthand(line: TextLine, sizePx: number): string {
  const style = line.italic ? 'italic ' : ''
  const weight = line.bold ? '700 ' : '400 '
  return `${style}${weight}${sizePx}px ${fontStack(line.fontFamily)}`
}

/** `rgb()` string for a PDF fill colour, defaulting to black. */
export function fillToCss(fill: RGB | null): string {
  if (!fill) return 'rgb(0, 0, 0)'
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return `rgb(${c(fill.r)}, ${c(fill.g)}, ${c(fill.b)})`
}

/** Relative luminance, used to pick a readable outline over a fill colour. */
export function isLightFill(fill: RGB | null): boolean {
  if (!fill) return false
  return 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b > 0.6
}

/** Human-readable label for why a line cannot be edited. */
export const BLOCKER_LABELS: Record<string, string> = {
  invisible: 'Invisible text (an OCR layer under a scanned image)',
  type3: 'Type 3 font — glyphs are drawn as procedures, not characters',
  'no-unicode': 'No Unicode mapping — the characters cannot be identified',
  'shared-xobject': 'Drawn from a form shared by several pages',
  'clipping-mode': 'Used as a clipping path, not painted text',
  vertical: 'Vertical writing mode',
}

export function describeBlockers(blockers: readonly string[]): string {
  if (blockers.length === 0) return ''
  return blockers.map((b) => BLOCKER_LABELS[b] ?? b).join('. ')
}
