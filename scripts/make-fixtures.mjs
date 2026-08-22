#!/usr/bin/env node
/**
 * PDF test-fixture generator.
 *
 * Run with:  node scripts/make-fixtures.mjs      (or `npm run fixtures`)
 *
 * Writes a set of small, deliberately awkward PDFs into ./fixtures so the
 * engine can be tested against real files rather than synthetic token streams.
 *
 * Almost every fixture is HAND-WRITTEN raw PDF bytes with a real cross-reference
 * table. That is on purpose: the interesting cases here (TJ kerning, unbalanced
 * `q`, /Contents arrays that split BT from ET, inline images with operator-shaped
 * payloads, Type0 /W arrays using both encodings) are precisely the things a
 * well-behaved writer such as pdf-lib will never emit. pdf-lib is used for what
 * it is genuinely good at: standard-14 text metrics, so the fixtures can place
 * text at exact, assertable coordinates.
 *
 * Every generated file is a valid PDF that opens in a viewer.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'fixtures')

/* ------------------------------------------------------------------ */
/* Raw PDF writer                                                      */
/* ------------------------------------------------------------------ */

/** Latin-1 is the right encoding for PDF syntax: one char == one byte. */
const L1 = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'))

/** Escape a JS string into a PDF literal string operand. */
const lit = (s) => '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'

/** Bytes -> `<AABB..>` hex string operand. */
const hex = (bytes) => '<' + Buffer.from(bytes).toString('hex').toUpperCase() + '>'

/** A 16-bit big-endian code as four uppercase hex digits (no angle brackets). */
const h4 = (n) => n.toString(16).toUpperCase().padStart(4, '0')

class Builder {
  constructor() {
    // Index 0 is the free head of the xref chain and is never used.
    this.objs = [null]
  }

  /** Reserve an object number so it can be referenced before it is written. */
  alloc() {
    this.objs.push(null)
    return this.objs.length - 1
  }

  /** Fill in a previously reserved object number. */
  put(num, body) {
    this.objs[num] = L1(body)
    return num
  }

  /** Append a new indirect object and return its number. */
  add(body) {
    return this.put(this.alloc(), body)
  }

  /**
   * Append a stream object. `dictBody` is the dictionary content WITHOUT the
   * enclosing `<< >>`; /Length is appended automatically.
   */
  addStream(dictBody, data) {
    const d = L1(data)
    return this.add(
      Buffer.concat([
        L1(`<< ${dictBody} /Length ${d.length} >>\nstream\n`),
        d,
        L1('\nendstream'),
      ]),
    )
  }

  /** Serialise the whole file, including a real (uncompressed) xref table. */
  build(rootRef) {
    const chunks = []
    let off = 0
    const push = (b) => {
      const buf = L1(b)
      chunks.push(buf)
      off += buf.length
    }

    push('%PDF-1.7\n')
    // Binary comment so tools treat the file as binary.
    push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

    const offsets = new Array(this.objs.length).fill(0)
    for (let i = 1; i < this.objs.length; i++) {
      if (this.objs[i] === null) throw new Error(`object ${i} was allocated but never filled in`)
      offsets[i] = off
      push(`${i} 0 obj\n`)
      push(this.objs[i])
      push('\nendobj\n')
    }

    const xrefOff = off
    // xref entries are exactly 20 bytes each — parsers rely on that.
    let x = `xref\n0 ${this.objs.length}\n0000000000 65535 f \n`
    for (let i = 1; i < this.objs.length; i++) {
      x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
    }
    x += `trailer\n<< /Size ${this.objs.length} /Root ${rootRef} 0 R >>\n`
    x += `startxref\n${xrefOff}\n%%EOF\n`
    push(x)

    return Buffer.concat(chunks)
  }
}

/**
 * Build a document. The callback receives helpers and declares pages; page
 * objects are reserved up front so XObjects can reference them and vice versa.
 */
function makeDoc(fn) {
  const b = new Builder()
  const catalogRef = b.alloc()
  const pagesRef = b.alloc()
  const pages = []

  const api = {
    b,
    obj: (body) => b.add(body),
    stream: (dictBody, data) => b.addStream(dictBody, data),
    /** `spec`: { mediaBox, cropBox, rotate, resources, contents } */
    page: (spec) => {
      const ref = b.alloc()
      pages.push({ ref, spec })
      return ref
    },
  }

  fn(api)

  for (const { ref, spec } of pages) {
    let s = `<< /Type /Page /Parent ${pagesRef} 0 R`
    s += ` /MediaBox ${spec.mediaBox ?? '[0 0 612 792]'}`
    if (spec.cropBox) s += ` /CropBox ${spec.cropBox}`
    if (spec.rotate !== undefined) s += ` /Rotate ${spec.rotate}`
    s += ` /Resources ${spec.resources ?? '<< /ProcSet [/PDF /Text] >>'}`
    const c = spec.contents
    s += Array.isArray(c)
      ? ` /Contents [${c.map((r) => `${r} 0 R`).join(' ')}]`
      : ` /Contents ${c} 0 R`
    s += ' >>'
    b.put(ref, s)
  }

  b.put(pagesRef, `<< /Type /Pages /Kids [${pages.map((p) => `${p.ref} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  b.put(catalogRef, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`)
  return b.build(catalogRef)
}

const written = []
function write(name, bytes) {
  fs.writeFileSync(path.join(OUT, name), bytes)
  written.push({ name, size: bytes.length })
  console.log(`  ${name.padEnd(28)} ${String(bytes.length).padStart(8)} bytes`)
}

/* ------------------------------------------------------------------ */
/* Standard-14 metrics, borrowed from pdf-lib                          */
/* ------------------------------------------------------------------ */

const metricsDoc = await PDFDocument.create()
const HELV = await metricsDoc.embedFont(StandardFonts.Helvetica)
const HELV_BOLD = await metricsDoc.embedFont(StandardFonts.HelveticaBold)

const HELV_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const HELV_BOLD_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
const RES_HELV = `<< /ProcSet [/PDF /Text] /Font << /F1 ${HELV_FONT} >> >>`

/* ------------------------------------------------------------------ */
/* ToUnicode CMap scaffolding                                          */
/* ------------------------------------------------------------------ */

function cmapWrapper(codespace, body) {
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    codespace,
    'endcodespacerange',
    body,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

/** Split a list of `beginX`/`endX` lines into the spec-mandated ≤100 per block. */
function cmapBlocks(kind, lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 100) {
    const chunk = lines.slice(i, i + 100)
    out.push(`${chunk.length} begin${kind}\n${chunk.join('\n')}\nend${kind}`)
  }
  return out.join('\n')
}

const utf16be = (s) => Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()

/* ================================================================== */
/* 1. simple-helvetica.pdf                                             */
/* ================================================================== */

function simpleHelvetica() {
  return makeDoc((d) => {
    const content = [
      'BT',
      '/F1 24 Tf',
      '72 720 Td',
      `${lit('Simple Helvetica Fixture')} Tj`,
      '/F1 12 Tf',
      '0 -32 Td',
      `${lit('Standard-14 Type1, WinAnsiEncoding, no /Widths array.')} Tj`,
      '0 -18 Td',
      // WinAnsi high bytes: e-acute, i-diaeresis, guillemets.
      '(Accented WinAnsi: caf\\351 na\\357ve \\253quoted\\273) Tj',
      '0 -18 Td',
      `${lit('A fourth line so baseline grouping has something to chew on.')} Tj`,
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 2. tj-kerning.pdf                                                   */
/* ================================================================== */

function tjKerning() {
  return makeDoc((d) => {
    const content = [
      'BT',
      '/F1 12 Tf',
      '72 720 Td',
      // The canonical case: one visual word chopped up by kerning adjustments.
      '[(O)-16(ther i)-20(nformati)-11(on)]TJ',
      '0 -20 Td',
      // Large negative adjustments standing in for spaces (no space glyphs at all).
      '[(Total)-278(amount)-278(due)-278(now)]TJ',
      '0 -20 Td',
      // Positive adjustment (moves left/tightens), plus a leading number.
      '[(-4)(Tight)25(ened)-500(and)-500(spaced)]TJ',
      '0 -20 Td',
      // Mixed with a plain Tj on the same baseline via a second TJ.
      `${lit('Plain Tj, ')} Tj`,
      '[(then )-10(a )-10(TJ )-10(continues )-10(the )-10(same )-10(line.)]TJ',
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 3. multi-op-line.pdf                                                */
/* ================================================================== */

function multiOpLine() {
  // One visual line assembled from four Tj ops, each with its own Td, alternating
  // bold and regular. Offsets are computed from real standard-14 metrics so the
  // pieces butt up exactly — a correct engine must merge them into ONE line.
  const size = 14
  const parts = [
    { text: 'Invoice ', bold: true },
    { text: 'number ', bold: false },
    { text: 'INV-', bold: true },
    { text: '0042 is overdue', bold: false },
  ]

  // Each Td is relative to the previous line matrix, so the offsets accumulate.
  const out = ['BT']
  let cursor = 0
  parts.forEach((p, i) => {
    const font = p.bold ? HELV_BOLD : HELV
    out.push(`/${p.bold ? 'FB' : 'FR'} ${size} Tf`)
    if (i === 0) out.push('72 700 Td')
    else out.push(`${cursor.toFixed(3)} 0 Td`)
    out.push(`${lit(p.text)} Tj`)
    cursor = font.widthOfTextAtSize(p.text, size)
  })
  // A second, shorter multi-op line so tests have two samples.
  out.push('ET')
  out.push('BT')
  out.push('/FR 10 Tf')
  out.push('72 670 Td')
  out.push(`${lit('Segment A ')} Tj`)
  out.push(`${HELV.widthOfTextAtSize('Segment A ', 10).toFixed(3)} 0 Td`)
  out.push('/FB 10 Tf')
  out.push(`${lit('Segment B')} Tj`)
  out.push('ET')

  return makeDoc((d) => {
    const c = d.stream('', out.join('\n'))
    d.page({
      resources: `<< /ProcSet [/PDF /Text] /Font << /FR ${HELV_FONT} /FB ${HELV_BOLD_FONT} >> >>`,
      contents: c,
    })
  })
}

/* ================================================================== */
/* 4. embedded-truetype.pdf                                            */
/* ================================================================== */

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Verdana.ttf',
  '/System/Library/Fonts/Supplemental/Tahoma.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
]

function findTrueType() {
  for (const p of FONT_CANDIDATES) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Shared font-file analysis for the two embedded-font fixtures. */
function loadFontInfo(file) {
  const raw = fs.readFileSync(file)
  const font = fontkit.create(raw)
  const upem = font.unitsPerEm
  const s = (v) => Math.round((v * 1000) / upem)
  return {
    raw,
    font,
    upem,
    scale: s,
    psName: (font.postscriptName || 'EmbeddedFont').replace(/[^A-Za-z0-9-]/g, ''),
    bbox: `[${s(font.bbox.minX)} ${s(font.bbox.minY)} ${s(font.bbox.maxX)} ${s(font.bbox.maxY)}]`,
    ascent: s(font.ascent),
    descent: s(font.descent),
    capHeight: s(font.capHeight ?? font.ascent),
    italicAngle: Math.round(font.italicAngle ?? 0),
  }
}

function embeddedTrueType(info) {
  const { raw, font, scale, psName, bbox, ascent, descent, capHeight, italicAngle } = info

  // Codes 1..4 are remapped by /Differences to T, e, x, t. Codes 32..126 keep
  // their WinAnsi meaning. That combination is what forces a reader to consult
  // /Differences and /ToUnicode rather than assuming ASCII.
  const DIFF = { 1: 'T', 2: 'e', 3: 'x', 4: 't' }
  const FIRST = 1
  const LAST = 126

  const widths = []
  for (let code = FIRST; code <= LAST; code++) {
    const ch = DIFF[code] ?? (code >= 32 ? String.fromCharCode(code) : null)
    if (ch === null) {
      widths.push(0)
      continue
    }
    const g = font.glyphForCodePoint(ch.codePointAt(0))
    widths.push(g ? scale(g.advanceWidth) : 0)
  }

  const bfchar = Object.entries(DIFF).map(
    ([code, ch]) => `<${Number(code).toString(16).toUpperCase().padStart(2, '0')}> <${utf16be(ch)}>`,
  )
  const toUnicode = cmapWrapper(
    '<00> <FF>',
    [
      cmapBlocks('bfchar', bfchar),
      // Increment-last-byte range covering all of printable ASCII.
      '1 beginbfrange\n<20> <7E> <0020>\nendbfrange',
    ].join('\n'),
  )

  return makeDoc((d) => {
    const fileRef = d.stream(`/Length1 ${raw.length}`, raw)
    const descRef = d.obj(
      `<< /Type /FontDescriptor /FontName /${psName} /Flags 32 /FontBBox ${bbox} ` +
        `/ItalicAngle ${italicAngle} /Ascent ${ascent} /Descent ${descent} /CapHeight ${capHeight} ` +
        `/StemV 80 /FontFile2 ${fileRef} 0 R >>`,
    )
    const tuRef = d.stream('', toUnicode)
    const encRef = d.obj(
      '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /T /e /x /t] >>',
    )
    const fontRef = d.obj(
      `<< /Type /Font /Subtype /TrueType /BaseFont /${psName} /FirstChar ${FIRST} /LastChar ${LAST} ` +
        `/Widths [${widths.join(' ')}] /FontDescriptor ${descRef} 0 R /Encoding ${encRef} 0 R ` +
        `/ToUnicode ${tuRef} 0 R >>`,
    )

    const content = [
      'BT',
      '/TT 22 Tf',
      '72 700 Td',
      // \001..\004 come out as "Text" only via /Differences + /ToUnicode.
      '(\\001\\002\\003\\004 from Differences) Tj',
      '/TT 13 Tf',
      '0 -28 Td',
      `${lit('Plain ASCII through the same embedded TrueType font.')} Tj`,
      '0 -20 Td',
      '[(Kerned )-40(embedded )-40(TrueType)]TJ',
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({
      resources: `<< /ProcSet [/PDF /Text] /Font << /TT ${fontRef} 0 R /F1 ${HELV_FONT} >> >>`,
      contents: c,
    })
  })
}

/* ================================================================== */
/* 5. type0-identity-h.pdf                                             */
/* ================================================================== */

function type0IdentityH(info) {
  const { raw, font, scale, psName, bbox, ascent, descent, capHeight, italicAngle } = info

  const line1 = 'Type0 Identity-H'
  const line2 = 'abcdef ghij composite'

  /** Map a JS string to the GID sequence Identity-H expects. */
  const gidsFor = (text) =>
    [...text].map((ch) => {
      const g = font.glyphForCodePoint(ch.codePointAt(0))
      return { gid: g ? g.id : 0, ch, width: g ? scale(g.advanceWidth) : 0 }
    })

  const g1 = gidsFor(line1)
  const g2 = gidsFor(line2)
  const all = [...g1, ...g2]

  const byGid = new Map()
  for (const g of all) if (!byGid.has(g.gid)) byGid.set(g.gid, g)
  const gids = [...byGid.keys()].sort((a, b) => a - b)

  const encode = (gs) => Buffer.from(gs.flatMap((g) => [(g.gid >> 8) & 0xff, g.gid & 0xff]))

  /* ---- /W array, using BOTH permitted forms -------------------------- */
  // Consecutive GIDs are grouped into runs. Runs alternate between the
  // `c [w1 w2 ...]` form and the `cFirst cLast w` form, so a parser that
  // implements only one of them produces visibly wrong advances.
  const runs = []
  for (const gid of gids) {
    const last = runs[runs.length - 1]
    if (last && gid === last[last.length - 1] + 1) last.push(gid)
    else runs.push([gid])
  }
  const wParts = []
  runs.forEach((run, i) => {
    const ws = run.map((gid) => byGid.get(gid).width)
    if (i % 2 === 0) {
      wParts.push(`${run[0]} [${ws.join(' ')}]`)
      return
    }
    // Range form: split the run into maximal equal-width stretches so that
    // real, multi-code `cFirst cLast w` entries appear.
    let s = 0
    for (let k = 1; k <= run.length; k++) {
      if (k === run.length || ws[k] !== ws[s]) {
        wParts.push(`${run[s]} ${run[k - 1]} ${ws[s]}`)
        s = k
      }
    }
  })
  // Guarantee both forms exist even if the font gave us an unlucky GID layout.
  // These map GIDs the content stream never uses, so they are inert.
  const hasRealRange = wParts.some((p) => {
    const m = /^(\d+) (\d+) \d+$/.exec(p)
    return m !== null && m[1] !== m[2]
  })
  if (!hasRealRange) wParts.push('3000 3010 500')
  if (!wParts.some((p) => p.includes('['))) wParts.push('3020 [500 500]')

  /* ---- /ToUnicode with bfchar + both bfrange forms -------------------- */
  const bfchar = []
  const bfrangeInc = []
  const bfrangeArr = []
  runs.forEach((run, i) => {
    if (run.length === 1) {
      bfchar.push(`<${h4(run[0])}> <${utf16be(byGid.get(run[0]).ch)}>`)
      return
    }
    const cps = run.map((gid) => byGid.get(gid).ch.codePointAt(0))
    const consecutive = cps.every((cp, k) => k === 0 || cp === cps[k - 1] + 1)
    const sameHighByte = (run[0] >> 8) === (run[run.length - 1] >> 8)
    if (consecutive && sameHighByte && i % 2 === 0) {
      // Increment-last-byte destination form.
      bfrangeInc.push(`<${h4(run[0])}> <${h4(run[run.length - 1])}> <${utf16be(byGid.get(run[0]).ch)}>`)
    } else {
      // Array destination form.
      const dsts = run.map((gid) => `<${utf16be(byGid.get(gid).ch)}>`).join(' ')
      bfrangeArr.push(`<${h4(run[0])}> <${h4(run[run.length - 1])}> [${dsts}]`)
    }
  })
  // Belt and braces: make sure every form is exercised no matter what the font
  // happened to give us. These map unused GIDs, so they are inert at render time.
  if (bfchar.length === 0) bfchar.push('<F000> <0041>')
  if (bfrangeInc.length === 0) bfrangeInc.push('<F010> <F013> <0050>')
  if (bfrangeArr.length === 0) bfrangeArr.push('<F020> <F021> [<0051> <0052>]')

  const toUnicode = cmapWrapper(
    '<0000> <FFFF>',
    [cmapBlocks('bfchar', bfchar), cmapBlocks('bfrange', [...bfrangeInc, ...bfrangeArr])].join('\n'),
  )

  return makeDoc((d) => {
    const fileRef = d.stream(`/Length1 ${raw.length}`, raw)
    const descRef = d.obj(
      `<< /Type /FontDescriptor /FontName /${psName} /Flags 32 /FontBBox ${bbox} ` +
        `/ItalicAngle ${italicAngle} /Ascent ${ascent} /Descent ${descent} /CapHeight ${capHeight} ` +
        `/StemV 80 /FontFile2 ${fileRef} 0 R >>`,
    )
    const cidRef = d.obj(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${psName} ` +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
        `/FontDescriptor ${descRef} 0 R /DW 1000 /W [${wParts.join(' ')}] /CIDToGIDMap /Identity >>`,
    )
    const tuRef = d.stream('', toUnicode)
    const fontRef = d.obj(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${psName} /Encoding /Identity-H ` +
        `/DescendantFonts [${cidRef} 0 R] /ToUnicode ${tuRef} 0 R >>`,
    )

    const content = [
      'BT',
      '/T0 22 Tf',
      '72 700 Td',
      `${hex(encode(g1))} Tj`,
      '/T0 14 Tf',
      '0 -30 Td',
      `${hex(encode(g2))} Tj`,
      '0 -24 Td',
      // A TJ over 2-byte codes: kerning plus composite encoding together.
      `[${hex(encode(g1.slice(0, 5)))} -35 ${hex(encode(g1.slice(5)))}] TJ`,
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({
      resources: `<< /ProcSet [/PDF /Text] /Font << /T0 ${fontRef} 0 R >> >>`,
      contents: c,
    })
  })
}

/* ================================================================== */
/* 6. rotated-{90,180,270}.pdf                                         */
/* ================================================================== */

const ROTATED_CONTENT = [
  // A 20x20 marker square whose lower-left corner sits at user space (72, 700),
  // i.e. exactly the text baseline origin. Tests can assert where both land.
  '0.85 0.1 0.1 rg',
  '72 700 20 20 re f',
  '0 g',
  'BT',
  '/F1 24 Tf',
  '1 0 0 1 100 700 Tm',
  `${lit('ROTATE MARKER')} Tj`,
  'ET',
  'BT',
  '/F1 10 Tf',
  '1 0 0 1 100 680 Tm',
  `${lit('baseline at user-space (100, 700) and (100, 680)')} Tj`,
  'ET',
].join('\n')

function rotated(deg) {
  return makeDoc((d) => {
    const c = d.stream('', ROTATED_CONTENT)
    d.page({ rotate: deg, resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 7. cropbox-offset.pdf / mediabox-origin.pdf                         */
/* ================================================================== */

const BOX_CONTENT = [
  '0.9 0.9 0.6 rg',
  '100 690 200 40 re f',
  '0 g',
  'BT',
  '/F1 16 Tf',
  '1 0 0 1 100 700 Tm',
  `${lit('Anchor at user-space (100, 700)')} Tj`,
  'ET',
  'BT',
  '/F1 10 Tf',
  '1 0 0 1 100 100 Tm',
  `${lit('Second anchor at user-space (100, 100)')} Tj`,
  'ET',
].join('\n')

function cropboxOffset() {
  return makeDoc((d) => {
    const c = d.stream('', BOX_CONTENT)
    d.page({
      mediaBox: '[0 0 612 792]',
      cropBox: '[50 60 562 742]',
      resources: RES_HELV,
      contents: c,
    })
  })
}

function mediaboxOrigin() {
  return makeDoc((d) => {
    const c = d.stream('', BOX_CONTENT)
    d.page({ mediaBox: '[20 20 632 812]', resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 8. form-xobject.pdf / form-xobject-shared.pdf                       */
/* ================================================================== */

function formXObject() {
  return makeDoc((d) => {
    const formContent = [
      '0.85 0.9 1 rg',
      '0 0 400 120 re f',
      '0 g',
      'BT',
      '/FF 18 Tf',
      '10 40 Td',
      `${lit('Text inside a Form XObject')} Tj`,
      '0 -24 Td',
      `${lit('form space (10,16) -> user space (107.5, 512)')} Tj`,
      'ET',
    ].join('\n')
    const formRef = d.stream(
      '/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 400 120] ' +
        `/Matrix [0.75 0 0 0.75 100 500] /Resources << /ProcSet [/PDF /Text] /Font << /FF ${HELV_FONT} >> >>`,
      formContent,
    )
    const content = [
      'BT',
      '/F1 12 Tf',
      '72 740 Td',
      `${lit('Page-level text, outside any XObject.')} Tj`,
      'ET',
      'q',
      '/Fx Do',
      'Q',
    ].join('\n')
    const c = d.stream('', content)
    d.page({
      resources: `<< /ProcSet [/PDF /Text] /Font << /F1 ${HELV_FONT} >> /XObject << /Fx ${formRef} 0 R >> >>`,
      contents: c,
    })
  })
}

function formXObjectShared() {
  return makeDoc((d) => {
    const formContent = [
      '0.85 0.9 1 rg',
      '0 0 400 120 re f',
      '0 g',
      'BT',
      '/FF 18 Tf',
      '10 40 Td',
      `${lit('SHARED XObject - editing it changes both pages')} Tj`,
      'ET',
    ].join('\n')
    const formRef = d.stream(
      '/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 400 120] ' +
        `/Matrix [0.75 0 0 0.75 100 500] /Resources << /ProcSet [/PDF /Text] /Font << /FF ${HELV_FONT} >> >>`,
      formContent,
    )
    const res = `<< /ProcSet [/PDF /Text] /Font << /F1 ${HELV_FONT} >> /XObject << /Fx ${formRef} 0 R >> >>`
    for (const label of ['Page one owns unique text.', 'Page two owns unique text.']) {
      const c = d.stream(
        '',
        ['BT', '/F1 12 Tf', '72 740 Td', `${lit(label)} Tj`, 'ET', 'q', '/Fx Do', 'Q'].join('\n'),
      )
      d.page({ resources: res, contents: c })
    }
  })
}

/* ================================================================== */
/* 9. invisible-ocr.pdf                                                */
/* ================================================================== */

function invisibleOcr() {
  return makeDoc((d) => {
    const content = [
      // Stand-in for the scanned page image.
      '0.72 0.70 0.66 rg',
      '52 560 508 200 re f',
      '0.35 0.33 0.30 rg',
      '72 700 300 6 re f',
      '72 676 420 6 re f',
      '72 652 380 6 re f',
      '0 g',
      // The OCR layer: render mode 3, invisible but selectable.
      'BT',
      '3 Tr',
      '/F1 14 Tf',
      '72 698 Td',
      `${lit('INVOICE 2024-0917')} Tj`,
      '0 -24 Td',
      `${lit('Invisible OCR text layer, render mode 3.')} Tj`,
      '0 -24 Td',
      `${lit('A correct editor must not silently drop this.')} Tj`,
      'ET',
      // One genuinely visible line, so the page is not entirely mode 3.
      'BT',
      '0 Tr',
      '/F1 10 Tf',
      '72 540 Td',
      `${lit('This caption is visible (render mode 0).')} Tj`,
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 10. unbalanced-q.pdf                                                */
/* ================================================================== */

function unbalancedQ() {
  return makeDoc((d) => {
    const content = [
      'q',
      '1 0 0 1 0 0 cm',
      'BT /F1 12 Tf 72 740 Td ' + lit('Before any clip, inside q #1.') + ' Tj ET',
      'q',
      // Clip path left active, and this q is never closed.
      '60 560 300 160 re W n',
      '0.9 0.95 0.9 rg',
      '0 0 612 792 re f',
      '0 g',
      'BT',
      '/F1 14 Tf',
      '72 690 Td',
      `${lit('Clipped text inside an unbalanced q.')} Tj`,
      '0 -22 Td',
      `${lit('This line is clipped away on the right ---------------->')} Tj`,
      'ET',
      // Deliberately NO matching Q: the stream ends with two open q levels.
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 11. no-text.pdf                                                     */
/* ================================================================== */

function noText() {
  return makeDoc((d) => {
    const content = [
      '0.15 0.35 0.65 rg',
      '72 600 200 120 re f',
      '0.9 0.6 0.1 RG',
      '6 w',
      '320 600 m 520 720 l 520 600 l h S',
      'q',
      '0.5 0 0 0.5 100 200 cm',
      '0 0.6 0.3 rg',
      '0 0 m 400 0 l 400 400 l 0 400 l h',
      '100 100 m 300 100 l 300 300 l 100 300 l h',
      'f*',
      'Q',
      '0 G',
      '2 w',
      '72 120 m 540 120 l S',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: '<< /ProcSet [/PDF] >>', contents: c })
  })
}

/* ================================================================== */
/* 12. inline-image.pdf                                                */
/* ================================================================== */

function inlineImage() {
  // 8x8 grayscale, 8 bpc, no filter => exactly 64 bytes of data.
  const data = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) data[i] = (i * 4) & 0xff
  // Operator-shaped bytes in the middle of the payload. Note the `EI` at offset
  // 25 is preceded by `x` (non-whitespace) and followed by a space: a naive
  // "scan for EI" tokenizer stops here and corrupts the rest of the stream.
  Buffer.from('Tj()xEI q Q BT(', 'latin1').copy(data, 20)
  if (data.length !== 64) throw new Error('inline image payload must be exactly 64 bytes')

  const head = L1(
    [
      'BT /F1 12 Tf 72 740 Td ' + lit('Text before the inline images.') + ' Tj ET',
      'q',
      '120 0 0 120 72 590 cm',
      'BI /W 8 /H 8 /CS /G /BPC 8 /D [0 1] ID ',
    ].join('\n'),
  )
  const mid = L1(
    [
      '\nEI',
      'Q',
      // A second inline image, this one filtered, so the byte-count shortcut does
      // not apply and the tokenizer has to fall back to scanning for EI.
      'q',
      '80 0 0 80 240 590 cm',
      'BI /W 4 /H 4 /CS /G /BPC 8 /F /AHx ID',
      '00204060 8090A0B0 C0D0E0F0 102030FF>',
      'EI',
      'Q',
      'BT',
      '/F1 16 Tf',
      '72 520 Td',
      `${lit('Real text AFTER the inline images.')} Tj`,
      '0 -22 Td',
      '[(And )-30(a )-30(TJ )-30(after )-30(them )-30(too.)]TJ',
      'ET',
      '',
    ].join('\n'),
  )

  return makeDoc((d) => {
    const c = d.stream('', Buffer.concat([head, data, mid]))
    d.page({
      resources: `<< /ProcSet [/PDF /Text /ImageB] /Font << /F1 ${HELV_FONT} >> >>`,
      contents: c,
    })
  })
}

/* ================================================================== */
/* 13. multi-part-contents.pdf                                         */
/* ================================================================== */

function multiPartContents() {
  return makeDoc((d) => {
    // Streams are concatenated (with whitespace between) before parsing, so a
    // text object may legally begin in one stream and end in another.
    const s1 = d.stream('', ['BT', '/F1 18 Tf', '72 720 Td', `${lit('Stream one opens BT, ')} Tj`].join('\n'))
    const s2 = d.stream(
      '',
      [`${lit('stream two closes ET.')} Tj`, 'ET', 'BT', '/F1 12 Tf', '72 690 Td', `${lit('Stream two also opens its own BT, ')} Tj`].join('\n'),
    )
    const s3 = d.stream(
      '',
      [
        `${lit('and stream three closes it.')} Tj`,
        'ET',
        'BT',
        '/F1 10 Tf',
        '72 660 Td',
        `${lit('Self-contained text object in stream three.')} Tj`,
        'ET',
      ].join('\n'),
    )
    d.page({ resources: RES_HELV, contents: [s1, s2, s3] })
  })
}

/* ================================================================== */
/* 14. text-state.pdf                                                  */
/* ================================================================== */

function textState() {
  return makeDoc((d) => {
    const content = [
      'BT',
      '/F1 16 Tf',
      '20 TL', // leading, used by T* / ' / "
      '2 Tc', // char spacing
      '6 Tw', // word spacing
      '72 730 Td',
      `${lit('Tc 2 and Tw 6 applied to this line')} Tj`,
      'T*',
      `${lit('T-star moved down by TL 20')} Tj`,
      `${lit('apostrophe operator also moves down')} '`,
      // aw ac string "  -> sets word spacing 12, char spacing 0, then shows.
      `12 0 ${lit('double-quote sets Tw and Tc then shows')} "`,
      '0 Tc 0 Tw',
      'T*',
      '60 Tz', // condensed horizontal scaling
      `${lit('Tz 60: horizontally condensed text')} Tj`,
      'T*',
      '140 Tz',
      `${lit('Tz 140: horizontally expanded')} Tj`,
      '100 Tz',
      'T*',
      `${lit('normal, then ')} Tj`,
      '7 Ts',
      `${lit('raised')} Tj`,
      '-5 Ts',
      `${lit('lowered')} Tj`,
      '0 Ts',
      `${lit(' back to baseline')} Tj`,
      'ET',
      // Nested q/Q with cm scaling: the effective font size on the page is
      // 12 * 2 * 0.5 = 12 for the inner run, but 12 * 2 = 24 for the outer one.
      'q',
      '2 0 0 2 60 250 cm',
      'BT /F1 12 Tf 0 40 Td ' + lit('outer cm scale 2x') + ' Tj ET',
      'q',
      '0.5 0 0 0.5 0 0 cm',
      'BT /F1 12 Tf 0 40 Td ' + lit('inner cm scale 2x then 0.5x') + ' Tj ET',
      'Q',
      'BT /F1 12 Tf 0 0 Td ' + lit('after inner Q, still 2x') + ' Tj ET',
      'Q',
      // A skewed/rotated text matrix for good measure.
      'BT',
      '/F1 14 Tf',
      '0.9659 0.2588 -0.2588 0.9659 72 150 Tm',
      `${lit('Rotated 15 degrees by Tm')} Tj`,
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* 15. colored-background.pdf                                          */
/* ================================================================== */

function coloredBackground() {
  return makeDoc((d) => {
    const content = [
      // Full-bleed dark background.
      '0.09 0.11 0.20 rg',
      '0 0 612 792 re f',
      // A slightly different dark panel behind the body text.
      '0.16 0.19 0.30 rg',
      '48 480 516 220 re f',
      // Light text on top: painting a white box over it would be obvious.
      '0.96 0.96 0.92 rg',
      'BT',
      '/F1 26 Tf',
      '72 650 Td',
      `${lit('Light text on a dark panel')} Tj`,
      '/F1 12 Tf',
      '0 -34 Td',
      `${lit('Covering this line with a white rectangle would be visible.')} Tj`,
      '0 -18 Td',
      `${lit('An editor must reuse the original fill colour when rewriting.')} Tj`,
      'ET',
      // An accent-coloured line, so not every run shares one fill colour.
      '0.98 0.72 0.22 rg',
      'BT',
      '/F1 14 Tf',
      '72 520 Td',
      `${lit('Accent coloured line (orange on dark).')} Tj`,
      'ET',
      // Dark text on the light strip at the bottom.
      '0.94 0.94 0.90 rg',
      '48 120 516 120 re f',
      '0.10 0.10 0.12 rg',
      'BT',
      '/F1 14 Tf',
      '72 190 Td',
      `${lit('Dark text on a light strip, same page.')} Tj`,
      'ET',
    ].join('\n')
    const c = d.stream('', content)
    d.page({ resources: RES_HELV, contents: c })
  })
}

/* ================================================================== */
/* main                                                                */
/* ================================================================== */

fs.mkdirSync(OUT, { recursive: true })

console.log(`Writing fixtures to ${OUT}`)

write('simple-helvetica.pdf', simpleHelvetica())
write('tj-kerning.pdf', tjKerning())
write('multi-op-line.pdf', multiOpLine())

/* ------------------------------------------------------------------ */
/* Type3 font: glyphs are content-stream procedures, not outlines       */
/* ------------------------------------------------------------------ */

/**
 * Real documents in this shape exist in quantity — TeX bitmap fonts, and the
 * output of tools that vectorise scanned pages. The glyphs here are simple
 * shapes rather than legible letters; what matters for the editor is that the
 * repertoire is enumerable via /CharProcs, the widths come from /Widths scaled
 * by /FontMatrix, and /ToUnicode makes the text readable.
 */
function type3() {
  // Codes are plain ASCII, as a real Type3 font's /Differences almost always
  // arranges, so the content stream reads normally.
  const NAMES = {
    ' ': 'space', ':': 'colon', '-': 'hyphen', '(': 'parenleft', ')': 'parenright',
    '/': 'slash', ',': 'comma', '.': 'period',
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  }
  const glyphName = (ch) => NAMES[ch] ?? (/[A-Za-z]/.test(ch) ? ch : null)
  const widthOf = (ch) => (ch === ' ' ? 300 : ':-,.'.includes(ch) ? 340 : 560)

  const FIRST = 32
  const LAST = 122 // 'z'
  const codes = []
  for (let c = FIRST; c <= LAST; c++) {
    const ch = String.fromCharCode(c)
    const name = glyphName(ch)
    if (name) codes.push({ code: c, ch, name })
  }

  return makeDoc((d) => {
    const procs = codes.map(({ ch, name }) => {
      const w = widthOf(ch)
      if (ch === ' ') return { name, ref: d.stream('', `${w} 0 0 0 0 0 d1\n`) }
      // `d1` makes the glyph take its colour from the graphics state, so the
      // editor's colour handling is exercised. The notch position varies with
      // the character so the shapes are distinguishable on screen.
      const notch = 120 + (ch.charCodeAt(0) % 5) * 90
      const body =
        `${w} 0 40 0 ${w - 40} 700 d1\n` +
        `40 0 ${w - 80} 700 re\n` +
        `140 ${notch} ${w - 280} 140 re\n` +
        'f*\n'
      return { name, ref: d.stream('', body) }
    })

    const charProcs = '<< ' + procs.map((p) => `/${p.name} ${p.ref} 0 R`).join(' ') + ' >>'
    const differences =
      '[ ' + codes.map(({ code, name }) => `${code} /${name}`).join(' ') + ' ]'
    const widths =
      '[ ' +
      Array.from({ length: LAST - FIRST + 1 }, (_, i) => {
        const ch = String.fromCharCode(FIRST + i)
        return glyphName(ch) ? widthOf(ch) : 500
      }).join(' ') +
      ' ]'

    const toUnicode = d.stream(
      '',
      cmapWrapper(
        '<00> <FF>',
        cmapBlocks(
          'bfchar',
          codes.map(({ code, ch }) => `<${code.toString(16).toUpperCase().padStart(2, '0')}> <${utf16be(ch)}>`),
        ),
      ),
    )

    const font = d.obj(
      '<< /Type /Font /Subtype /Type3' +
        ' /FontBBox [0 0 600 700]' +
        ' /FontMatrix [0.001 0 0 0.001 0 0]' +
        ` /CharProcs ${charProcs}` +
        ` /Encoding << /Type /Encoding /Differences ${differences} >>` +
        ` /FirstChar ${FIRST} /LastChar ${LAST}` +
        ` /Widths ${widths}` +
        ' /Resources << /ProcSet [/PDF] >>' +
        ` /ToUnicode ${toUnicode} 0 R >>`,
    )

    const resources = `<< /ProcSet [/PDF /Text] /Font << /T3 ${font} 0 R /F1 ${HELV_FONT} >> >>`
    const contents = d.stream(
      '',
      [
        'BT /T3 14 Tf 40 720 Td',
        `${lit('Session : 2021-22 (REGULAR) Semesters : 1,2')} Tj`,
        '0 -22 Td',
        `${lit('Result : PASS Marks : 1090/1800')} Tj`,
        '0 -22 Td',
        '0 0 0.8 rg',
        `${lit('Audit 1 : Cleared Audit 2 : Cleared')} Tj`,
        'ET',
        'BT /F1 11 Tf 40 620 Td (A Helvetica line for contrast.) Tj ET',
      ].join('\n'),
    )
    d.page({ resources, contents })
  })
}


const fontFile = findTrueType()
if (fontFile) {
  console.log(`  (embedding ${fontFile})`)
  const info = loadFontInfo(fontFile)
  write('embedded-truetype.pdf', embeddedTrueType(info))
  write('type0-identity-h.pdf', type0IdentityH(info))
} else {
  console.warn(
    '  !! No usable TrueType file found on this machine; skipping\n' +
      '     embedded-truetype.pdf and type0-identity-h.pdf.\n' +
      `     Looked in:\n${FONT_CANDIDATES.map((p) => `       ${p}`).join('\n')}`,
  )
}

write('rotated-90.pdf', rotated(90))
write('rotated-180.pdf', rotated(180))
write('rotated-270.pdf', rotated(270))
write('cropbox-offset.pdf', cropboxOffset())
write('mediabox-origin.pdf', mediaboxOrigin())
write('form-xobject.pdf', formXObject())
write('form-xobject-shared.pdf', formXObjectShared())
write('invisible-ocr.pdf', invisibleOcr())
write('unbalanced-q.pdf', unbalancedQ())
write('no-text.pdf', noText())
write('inline-image.pdf', inlineImage())
write('multi-part-contents.pdf', multiPartContents())
write('text-state.pdf', textState())
write('colored-background.pdf', coloredBackground())
write('type3.pdf', type3())

console.log(`\n${written.length} fixtures written.`)
