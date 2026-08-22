# PDF Text Editor

Upload a PDF, edit the text in place, download a real PDF.

Everything runs in the browser. The file is never uploaded anywhere — there is
no server, no backend, no network request with your document in it.

```bash
npm install
npm run dev      # http://localhost:5173
```

---

## What makes this different

Most browser "PDF editors" draw a white rectangle over the old text and paint
new text on top. That is quick to build and wrong in ways you notice later:

- the original text is still in the file — it copies out, it turns up in search,
  it is visible to anything that reads the PDF rather than looks at it;
- the white box is visible over anything that is not white paper;
- the replacement is set in a substitute font, so the edit does not match the
  document around it.

This editor does the real thing instead. It **rewrites the page's content
stream**: the original text-showing operators are removed from the PDF, and the
replacement is re-encoded **in the document's own embedded font** whenever that
font can draw the characters you typed.

The dark-panel fixture below is the whole argument. Heading edited, same font,
same colour, same baseline, panel untouched — no cover box anywhere:

| before | after |
|---|---|
| `Light text on a dark panel` | `Edited on dark` |

Run `npm run render-check` to regenerate that comparison and nine others.

---

## How it works

```
                 ┌──────────────┐
  your PDF ──────│   pdf-lib    │──── object model, and the final save
                 └──────┬───────┘
                        │ decoded content streams
                 ┌──────▼───────┐
                 │ interpreter  │  our own graphics/text state machine
                 └──────┬───────┘
                        │ TextRun[]  (text + geometry + exact byte spans)
                 ┌──────▼───────┐
                 │   grouping   │──── TextLine[]  ← what you click and edit
                 └──────┬───────┘
                        │
        edit ───────────┤
                        │
                 ┌──────▼───────┐
                 │   rewrite    │  neutralise originals, draw replacement
                 └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │  pdf.js      │──── renders pages for display + preview
                 └──────────────┘
```

**We do not use pdf.js to find the text.** pdf.js is excellent at *rendering*,
and it is what paints the page you see. But `getTextContent()` splits and merges
show operators according to its own heuristics — kerning thresholds, synthesised
spaces, marked-content flush points — so its Nth text item is emphatically not
the Nth operator in the content stream. Interpreting the stream ourselves makes
that correspondence exact by construction: every run carries the byte range of
the operator it came from, which is what makes byte-precise surgery possible.

### Removing text without moving everything after it

Deleting a show operator changes the text matrix, which would shift every glyph
after it. The fix has to reproduce both `Tm` and `Tlm` exactly, and only a
text-showing operator can leave those two matrices in the state the original
did. So (ISO 32000-1 §9.4.4):

1. **Delete outright** when the next operator to touch `Tm` is `Td`/`TD`/`Tm`/
   `T*`/`'`/`"`/`ET`. Nothing downstream depends on the advance, so no
   compensation is needed at all. This covers most real edits.
2. Otherwise emit **`[ N ] TJ`** — a showing operator with no glyphs, carrying
   exactly the displacement the original produced:

   ```
   N = −1000·Σw₀ − 1000·n·Tc/Tfs − 1000·n₃₂·Tw/Tfs + ΣNⱼ
   ```

   `Tz` cancels out of that derivation, so it stays correct under any horizontal
   scaling.
3. If the run cannot be measured at all (font size 0, unparseable widths), fall
   back to hiding it with text render mode 3 — exact by construction, since the
   operator still runs — and say so in the warnings, because the text is then
   invisible but not gone.

Emitting `Tm` or `Td` instead — the obvious-looking fix — silently corrupts
`Tlm`, so a later `T*` lands on the wrong line. `src/core/interpreter.test.ts`
asserts the invariant directly: neutralising any run leaves every *other* run in
the stream at byte-identical coordinates.

The replacement text is drawn by a self-contained block appended to the page,
wrapped in `q … Q` with its own `cm` and `Tm`. Because it never executes inside
an original text object, it cannot disturb the surrounding state — and wrapping
the original content in `q … Q` first also neutralises unbalanced graphics state
or a leftover clipping path, which is the classic reason appended content
mysteriously fails to appear.

### Keeping the document's own fonts

Given `/ToUnicode` and the font's encoding, the map from character codes to
Unicode can be inverted — so edited text can be re-encoded with the **original
embedded font**, at its original widths. That is what makes an edit invisible.

`src/core/font.ts` handles simple fonts (`/Widths`, `/FirstChar`, `/Encoding`
with `/BaseEncoding` + `/Differences`, the standard-14 AFM metrics), composite
Type0 fonts (`/W` in both forms, `/DW`, Identity-H and embedded CMaps), and
Type3 fonts, whose glyphs are drawn procedures. For subset fonts a mapping
alone is not proof the glyph survived subsetting, so codes must be corroborated
by the width tables before they are trusted. Type3 is the one case where the
answer is exact: a glyph exists precisely when `/CharProcs` defines a procedure
for it, so those documents — TeX output, vectorised scans, a lot of
institutional paperwork — edit as cleanly as any other.

When the original font genuinely cannot draw a character, the editor embeds a
fallback and tells you which characters were substituted. When even the fallback
cannot (the built-in one covers Western European text only), it says that
plainly rather than shipping you a file with characters silently missing.

Mixed formatting survives, because edits are mapped back onto individual runs
rather than flattening the line:

> **Invoice** number **INV-**0042 is overdue &nbsp;→&nbsp; **Invoice** number **INV-**9999 is settled

Only the changed characters were rewritten; the bold runs were left alone.

---

## What it handles

| | |
|---|---|
| `/Rotate` 90 / 180 / 270 | ✅ |
| `/CropBox` ≠ `/MediaBox`, non-zero `/MediaBox` origin | ✅ |
| `/Contents` as an array of streams (a `BT` in one, its `ET` in the next) | ✅ |
| Text inside Form XObjects, with their own `/Matrix` and `/Resources` | ✅ |
| `TJ` arrays with kerning, including word gaps expressed as kerning | ✅ |
| One visual line built from several operators and several fonts | ✅ |
| `Tc` / `Tw` / `Tz` / `Ts` / `TL`, and the `'` and `"` operators | ✅ |
| Type0 / Identity-H, embedded TrueType, standard-14 | ✅ |
| Type3 fonts, where glyphs are drawn procedures | ✅ (re-uses glyphs `/CharProcs` defines) |
| Inline images whose binary data looks like operators | ✅ |
| Non-white and image backgrounds | ✅ (nothing is covered up) |
| Unbalanced `q` / leftover clipping paths | ✅ |

### Deliberately locked, with a reason shown in the UI

- **Invisible OCR layers** (render mode 3) — editing them changes nothing you
  can see, so the editor refuses instead of pretending.
- **Text shared across pages** (a letterhead in a reused Form XObject) — editing
  it would change every page that uses it.
- **Vertical writing mode.**
- Lines whose glyphs have no recoverable character mapping.

### Not supported

- **Encrypted / password-protected PDFs.** Detected and refused at load, because
  pdf-lib cannot decrypt them and "ignore encryption" produces a broken file.
- **Scans and text drawn as vector outlines** — there is no text to edit, and
  the editor says so instead of showing an empty page.
- Paragraph reflow and re-wrapping. Editing is per line, by design: lines are
  what the content stream actually gives you, and guessing paragraphs breaks
  tables and multi-column layouts badly.
- RTL bidi, Arabic/Indic shaping.
- Digital signatures survive — saving rewrites the whole file, which invalidates
  any signature. You are warned before downloading.

---

## Using it

1. Drop a PDF onto the page (or paste one, or pick a file).
2. Editable lines outline on hover. Click one and type. Locked lines are marked
   with the reason.
3. The Inspector shows the font, size and colour, whether the new text still
   fits, and any characters the original font cannot draw. When it overflows you
   choose: let it overflow, shrink to fit, or condense. You can also anchor the
   line left, centre or right.
4. **Rendered preview** re-renders the page through the actual export pipeline,
   so what you are looking at is what you will download.
5. Download.

Undo/redo (⌘Z / ⌘⇧Z) coalesces typing, so undo steps through edits rather than
characters.

---

## Development

```bash
npm run dev            # dev server
npm test               # 240+ tests: unit, fixture round-trips, and a real app mount
npm run build          # production build
npm run fixtures       # regenerate fixtures/ (19 hand-built PDFs)
npm run render-check   # rasterise before/after comparisons -> tmp/render-check/
npm run tables         # re-extract the vendored pdf.js data tables
```

### Testing approach

Unit tests prove the arithmetic. The tests that actually matter are in
`src/core/roundtrip.test.ts`: they load a real PDF, edit a line, export, reload
the exported bytes, and assert on what came out — that the new text is there,
that the old text is *gone* rather than hidden, and that the rest of the
document's text is character-for-character unchanged.

`src/ui/App.test.tsx` mounts the real app against a stub engine and drives it
the way a person does — open a file, click a line, type, download — because a
typecheck cannot tell you whether a click actually lands on an editable box.

`src/ui/geometry.viewport.test.ts` is worth calling out too: the editable boxes
are positioned by our own page-to-screen formula while the glyphs underneath are
painted by pdf.js's, so that test runs both over real rotated and CropBox-offset
pages and asserts they agree at every text baseline. If they ever diverge, the
boxes drift off the text.

`fixtures/` contains 20 hand-built PDFs covering the cases above; see
`fixtures/README.md` for what each one exercises. Eighteen of them are about a
kilobyte each and are checked in. The two that embed a TrueType font
(`embedded-truetype.pdf`, `type0-identity-h.pdf`) are not: `npm run fixtures`
builds them from whichever font it finds on the machine, which makes them
~760 KB apiece, different on every machine, and a redistribution of a font that
is not ours to ship. Run `npm run fixtures` to generate them; the five tests
that need them skip cleanly when they are absent, so a fresh clone still runs
green.

### Layout

```
src/core/
  lexer.ts         content-stream tokenizer, byte-exact
  cmap.ts          CMap parsing (ToUnicode and CID)
  encoding.ts      encodings + Adobe Glyph List
  font.ts          widths, code↔Unicode, re-encoding
  interpreter.ts   graphics/text state machine → TextRun[]
  grouping.ts      TextRun[] → TextLine[]
  distribute.ts    edited line text → per-run text
  rewrite.ts       operator neutralisation + replacement drawing
  export.ts        applies edits, writes streams, saves
  document.ts      PDF → editable model
  engine.ts        the facade the UI talks to
  contract.ts      the interface between core and UI
  model.ts         shared types
  vendor/          data tables extracted from pdf.js (Apache-2.0)
src/ui/            React UI
```

`src/core/vendor/` holds the Adobe Glyph List, the standard encoding tables and
the standard-14 AFM metrics, extracted verbatim from pdf.js's shipped source
maps by `scripts/extract-pdfjs-tables.mjs` (Apache-2.0, see
`src/core/vendor/LICENSE-pdfjs`). Reimplementing 4,300 glyph names by hand would
be strictly worse than reusing the reference data. The `.d.ts` files are
generated from the actual exports so they cannot drift.

Built with TypeScript, React, Vite, [pdf-lib](https://github.com/Hopding/pdf-lib)
and [pdf.js](https://mozilla.github.io/pdf.js/).
