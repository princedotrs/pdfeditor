/**
 * The document model shared by the PDF engine and the React UI.
 *
 * Geometry note: every rectangle and matrix in this file is in **page space** —
 * PDF user space (y-up) translated so that the visible box's lower-left corner
 * is the origin. The visible box is the CropBox when present, else the MediaBox.
 * `PageInfo.rotation` still has to be applied to get to screen space; the
 * `viewport` helpers in `src/core/viewport.ts` do that.
 */
import type { Matrix, Rect } from './matrix'

export interface RGB {
  r: number
  g: number
  b: number
}

/** One glyph as it appears in the original content stream. */
export interface Glyph {
  /** The character code as it appeared in the string operand. */
  code: number
  /** How many bytes the code occupied (1 for simple fonts, usually 2 for Type0). */
  byteLen: number
  /** CID for composite fonts; equal to `code` for simple fonts. */
  cid: number
  /** Unicode this glyph stands for. Empty when it could not be mapped. */
  unicode: string
  /** Advance width in glyph space (1/1000 text space units). */
  width: number
  /** Text-space x offset of this glyph's origin from the run origin. */
  offset: number
}

export type ShowOp = 'Tj' | 'TJ' | "'" | '"'

/**
 * One text-showing operator, with everything needed to reposition, re-encode
 * or delete it. `start`/`end` are byte offsets into the decoded content stream
 * identified by `streamKey`, which is what makes byte-exact surgery possible.
 */
export interface TextRun {
  id: string
  pageIndex: number
  streamKey: string
  start: number
  end: number
  op: ShowOp

  /** Resource name used by the `Tf` in force, e.g. `F1`. */
  fontName: string
  /** Stable identity of the font object, used to group runs by real font. */
  fontKey: string
  fontSize: number
  charSpacing: number
  wordSpacing: number
  /** Horizontal scaling as a ratio (Tz / 100). */
  horizScale: number
  leading: number
  rise: number
  renderMode: number

  /** Text matrix in force immediately before the operator ran. */
  textMatrix: Matrix
  /** Line matrix in force immediately before the operator ran. */
  lineMatrix: Matrix
  /** Current transformation matrix in force. */
  ctm: Matrix
  /** Text rendering matrix: [Tfs*Th, 0, 0, Tfs, 0, Ts] x Tm x CTM. */
  trm: Matrix

  text: string
  glyphs: Glyph[]
  /** Sum of the numeric adjustments in the original TJ array (0 for other ops). */
  tjAdjustment: number
  /**
   * Total advance produced by the operator, in text space (horizontal scaling
   * already applied) — i.e. the translation it accumulated into `Tm`.
   */
  advance: number
  /** Bounding box in page space. */
  bbox: Rect
  /** Baseline start point in page space. */
  origin: [number, number]
  /** Effective on-page font size (glyph em height after all transforms). */
  effectiveSize: number
  /**
   * Length in page space of one unit of `advance`.
   *
   * `advance` accumulates in text space — the space `Tm` maps *from* — so
   * converting it to a page distance needs the scale of `Tm x CTM`, not of the
   * CTM alone. Plenty of producers write `/F1 1 Tf` and bake the point size
   * into `Tm`, and for those the CTM carries no scale at all.
   */
  textToPageScale: number
  /** Baseline direction angle in page space, radians. */
  angle: number

  fill: RGB | null
  /** Stroke colour and line width, which matter for text render modes 1 and 2. */
  stroke: RGB | null
  lineWidth: number
  /** True when the operator can simply be deleted with no advance compensation. */
  safeDelete: boolean
  /** Nesting depth of marked content carrying /ActualText, if any. */
  actualText: string | null
  /**
   * For the `'` and `"` operators, the word/char spacing they set as a side
   * effect. A rewrite must reproduce these, so it lowers the operator into its
   * primitive form (`aw Tw ac Tc T*` followed by a plain show).
   */
  quote: { wordSpacing: number; charSpacing: number } | null
  /** The raw bytes of the operator's span, kept for the invisible fallback. */
  originalBytes: Uint8Array
}

/** Reasons a run cannot be edited. */
export type RunBlocker =
  | 'invisible'
  | 'type3'
  | 'no-unicode'
  | 'shared-xobject'
  | 'clipping-mode'
  | 'vertical'

/**
 * A group of runs sharing a baseline, presented to the user as one editable
 * field. Lines are the unit of editing: they are what the content stream
 * actually gives us, and grouping further into paragraphs is a heuristic that
 * fails badly on tables and multi-column layouts.
 */
export interface TextLine {
  id: string
  pageIndex: number
  runIds: string[]
  text: string
  /**
   * `text` split per run, including any space this grouping synthesised from a
   * wide gap (attributed to the run before the gap). Always joins back to
   * `text`, which is what lets an edit be mapped back onto individual runs.
   */
  runTexts: string[]
  /** Page-space bounding box of the whole line. */
  bbox: Rect
  origin: [number, number]
  angle: number
  effectiveSize: number
  /** Dominant font of the line, for display. */
  fontName: string
  fontFamily: string
  bold: boolean
  italic: boolean
  fill: RGB | null
  /** Non-empty when this line cannot be edited. */
  blockers: RunBlocker[]
  /** Total advance of the original line in page-space units (its natural width). */
  width: number
}

export interface PageInfo {
  index: number
  /** Visible box size in points, before rotation. */
  width: number
  height: number
  /** /Rotate normalised to 0 | 90 | 180 | 270. */
  rotation: number
  /** Offset of the visible box's lower-left corner in raw PDF user space. */
  offsetX: number
  offsetY: number
  /** Size after rotation is applied — i.e. what the user sees. */
  displayWidth: number
  displayHeight: number
}

export interface DocumentWarning {
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
  pageIndex?: number
}

export interface EditableDocument {
  pages: PageInfo[]
  runs: Map<string, TextRun>
  lines: TextLine[]
  linesByPage: Map<number, TextLine[]>
  warnings: DocumentWarning[]
  /** True when no page has any editable text (scan / outlines only). */
  hasEditableText: boolean
  /**
   * The document can be displayed but not written. Set when there is nothing
   * editable to change; encrypted and unparseable files never load at all.
   */
  readOnly: boolean
}

/** A pending user edit: the new text for one line. */
export interface LineEdit {
  lineId: string
  text: string
  /** How to place text that no longer fits the original advance width. */
  overflow: OverflowMode
  /** Where the line is anchored when its width changes. */
  anchor: 'left' | 'center' | 'right'
}

export type OverflowMode = 'overflow' | 'shrink' | 'condense'

export interface EditStats {
  linesChanged: number
  runsRewritten: number
  runsDeleted: number
  reusedOriginalFont: number
  usedFallbackFont: number
}
