## PRIOR ART & PITFALLS: BROWSER-BASED PDF TEXT EDITING

Context noted: your stack is already `pdf-lib@1.17` + `pdfjs-dist@6.2` + React/Vite (`/Volumes/Crucial X9/Project/prince981620/pdfeditor/package.json`). Recommendations below are specific to that pairing.

---

## 1. How existing tools actually do it

There are four distinct strategies, and most "PDF editors" quietly use #1.

**(A) Cover-and-redraw ("white box")** — pdf-lib-based editors, PDFescape's free tier (its literal tool is called *Whiteout*), most SaaS "edit PDF" pages, Stirling-PDF's classic Add-Text. Content is *appended* to the page content stream; nothing is removed.
Quality problems, all serious:
- **The old text is still there.** Copy/paste, Ctrl-F, screen readers, and `pdftotext` all still return the original string. This is a correctness bug and, for redaction-adjacent use, a data leak.
- Background mismatch on anything but pure white; hairline seams from anti-aliasing at the box edges; visible at high zoom even when it looks fine at 100%.
- Font/kerning mismatch — you're re-typesetting with a *different* font than the original subset.
- Z-order: appended content lands on top of page content but *below* annotations, and can be clipped or transformed by an unbalanced graphics state left by the original stream (see §4).
- Destroys tagged-PDF/accessibility structure and any text-search index.

**(B) Content-stream surgery (true in-place editing)** — Acrobat's `PDEText` layer, MuPDF (`applyRedaction` genuinely deletes glyphs touched by a rect), PDFBox token-rewriting recipes, iText/PDFsharp hacks. You tokenize the page stream, find `Tj`/`TJ`/`'`/`"`, map codes→Unicode via the font's `/Encoding` + `/ToUnicode`, rewrite the operand, and re-encode with the same font.
Quality problems: the code→Unicode map is not invertible without `/ToUnicode`; a visual "word" is routinely split across many strings inside one `TJ` array with kerning numbers interleaved (`[(O)-16(ther i)-20(nformati)-11(on )]TJ`), or across several `Tj`s each preceded by its own `Td`; changing the string changes its advance width so everything after it on the line shifts; justified text breaks; and you can only type characters whose glyphs exist in the embedded subset.

**(C) Reconstruct-and-reflow** — Acrobat "Edit Text & Images", Foxit, Sejda, Smallpdf. Heuristically groups runs into paragraph blocks, then regenerates that block's content stream on edit, with real line-wrapping.
Quality problems: paragraph detection fails on multi-column layouts, tables, and figure captions (you edit one cell and the whole table re-wraps); the regenerated stream loses original operator ordering and marked content; fonts get substituted when not installed/embeddable — Acrobat falls back to **Minion Pro** for Roman script and throws *"All or part of the selection has no available system font. You cannot add or delete text using the currently selected font."* Even the industry reference tool degrades visibly here.

**(D) Rasterize-and-rebuild** — render page to image, stamp text on top. Never do this; it destroys all text, bloats the file, and prints badly.

Tool-by-tool, concretely:
- **PDF.js** does *not* edit page text and never has. Its editor layer creates **annotations only** (FreeText, ink, highlight, stamp, signature). Editing pre-existing annotations was itself a long-open gap (mozilla/pdf.js #15403, #14970). Any "PDF.js editor" doing text edits is pairing PDF.js (render + extract) with a separate writer — exactly your architecture.
- **pdf-lib** documents the limit in its own README: it can read/write form-field text but **"cannot extract plain text on a page outside of a form field"** and offers no API to remove or edit page content. Therefore every pdf-lib "text editor" on GitHub is category (A).
- **Stirling-PDF**: find-and-replace was requested in 2024 (#1855) and went unimplemented for a long time; v2.0 shipped an **alpha** Edit Text, gated to paid tiers. Treat "alpha, paid, still refining" as the market signal for how hard this is.
- **Sejda** is the closest to a good browser-side v1: line-scoped editing, re-embeds the original font when it can and substitutes a lookalike when it can't, and **explicitly refuses scanned documents** — including OCR'd scans, which it correctly notes are still images.

---

## 2. The hard cases (mechanism → failure)

1. **Subset embedded fonts.** A PDF made from Word embeds `ABCDEF+Garamond` containing *only the glyphs actually used*. The name says Garamond; the file has maybe 60 glyphs. Type `é`, `–`, `5`, or `ﬁ` and there is no glyph → blank box, `.notdef`, or a silently wrong glyph. Worse, if `/Widths` doesn't cover the new code, spacing goes wrong even when a glyph renders.
2. **Vector outlines / scanned images.** No text objects at all — just `re f`/`c`/`l` paths or a single `Do` on an `/Image`. Naive editors show zero editable regions and users assume the app is broken. **The nastier variant: OCR'd scans**, where a full invisible text layer exists at **text rendering mode 3 (`3 Tr`)** on top of the image. Your extractor finds text, the user edits it, and *nothing visible changes* — you edited an invisible layer. You must check `Tr`.
3. **`/Rotate` and non-zero `/MediaBox` origin, `/CropBox`.** Three separate coordinate traps. `/Rotate` is a *display* transform: pdf-lib's `page.getSize()` returns the **unrotated** dimensions and `drawText` places content in unrotated space (Hopding/pdf-lib #65, #545, #524, #1725). Separately, `/MediaBox [20 20 632 812]` means user-space origin is *not* (0,0) but pdf-lib's draw coordinates assume it is. And PDF.js's `getViewport()` derives from `page.view` = the **CropBox**, so whenever CropBox ≠ MediaBox your extraction coordinates and your writing coordinates are offset by the difference. Every one of these silently mis-places boxes by tens of points.
4. **Text inside Form XObjects.** `/Do` invokes a nested stream with its own `/Resources` and a `/Matrix`. Letterhead, headers/footers, and anything placed by a layout engine commonly lives there. A tokenizer that only walks the page `/Contents` finds nothing to edit — and one that *does* recurse must compose the XObject `/Matrix` with the CTM to get correct positions, and must handle the XObject being shared across pages (edit it once, it changes on every page).
5. **Annotation appearance streams.** Form-field values live in `/AP /N` streams, not page content. Editing the page stream does nothing; the viewer redraws from `/AP`. Conversely, setting a field value without regenerating `/AP` (or setting `/NeedAppearances true`) shows stale text in some viewers and correct text in others.
6. **Clipping paths, transparency groups, OCG.** `W n` sets a clip that persists in the graphics state; if the original stream ends inside an unbalanced `q` with a clip active, your appended content is clipped away — the classic "pdf-lib drawText draws nothing on this one file." `/OC` + `BDC/EMC` marked content means the run you're editing may belong to a layer that is hidden by default in some viewers (or is a watermark/print-only layer). Transparency groups + blend modes mean your opaque white rect composites differently than expected.
7. **Non-white / image backgrounds.** Cover-with-white is simply wrong over scans, colored tables, gradients, and photos. Sampling the background color from the rendered canvas helps for flat fills only — for anything textured there is no correct patch, because the pixels behind the glyphs are *the glyphs*. This case alone justifies real removal over covering.
8. **RTL / vertical / ligatures / combining marks.** The content stream stores text in **visual order**; Arabic/Hebrew extraction gives you reversed logical order unless you bidi-process. Arabic and Indic need shaping (contextual forms) that a naive `encodeText` won't do. Ligatures arrive as single codepoints (`ﬁ` U+FB01) that your replacement font may lack. Combining marks (`e` + U+0301) may have been baked into a single precomposed glyph in the original.
9. **Type3 fonts, encryption, linearization, xref streams.** Type3 glyphs are *arbitrary content streams* per character — there's no font program to embed a new glyph into; editing is effectively impossible. Encrypted PDFs: **pdf-lib does not support them at all**; `ignoreEncryption: true` does *not* decrypt — it suppresses the error and yields blank/garbage pages (#1326, #1390, #1296, #1601). Linearization and xref streams are fine to *read*, but pdf-lib rewrites the whole file, so linearization is lost (harmless) and **any digital signature is invalidated** (#816; PR #1741; forks `@cantoo/pdf-lib`, `pdf-lib-incremental-save`).
10. **Reflow / overflow.** "Smith" → "Vandersteenhoven" doesn't fit. Options are all lossy: overflow into neighbors, shrink font, condense with `Tz`, or re-wrap the paragraph — and re-wrapping requires knowing the paragraph's bounding box and justification, which the PDF does not record anywhere.

---

## 3. Mitigations, ranked by benefit/effort

**Tier 1 — do these; they're cheap and each removes a whole class of bugs**
- **Gate on capability before showing an editor.** Per page: any text? any glyph at `Tr != 3`? encrypted? signed? Show one honest banner instead of a broken editor.
- **Normalize coordinates once, in one module.** Build an explicit `pdfjsItem → userSpace → pdfLibDraw` transform that composes CropBox offset, MediaBox origin, and `/Rotate`. Write a fixture test with 8 PDFs (rot 0/90/180/270 × MediaBox origin 0 / non-zero) and assert a drawn marker lands on a known glyph. This is the single highest-ROI thing you can build.
- **Always wrap.** Prepend a content stream containing `q` and append one containing `Q` around the original `/Contents` array, then add *your* stream with its own `q … Q` and an explicit `cm`. Kills the clipping/unbalanced-state class entirely.
- **Embed a real font with `@pdf-lib/fontkit`; never rely on StandardFonts.** pdf-lib's built-ins are WinAnsi-only and throw on CJK, Cyrillic, Greek, ligature codepoints, and most symbols. Ship one variable/text font family.
- **Save with `updateFieldAppearances: false`** if the doc has an AcroForm you aren't intentionally editing, and consider `useObjectStreams: false` for maximum viewer compatibility.
- **Sample the background** under each edit rect from the PDF.js canvas; if variance is above a threshold, disable "cover" mode for that run and say why.

**Tier 2 — the thing that makes it a real product**
- **Write your own content-stream tokenizer + text-state machine** (~600–1500 LOC TS) over the decoded `/Contents` (handle the array form, and recurse one level into Form XObjects). For each show-text operator record: byte range in the stream, font resource name, `Tm`/CTM, `Tf` size, `Tc`/`Tw`/`Tz`/`TL`/`Ts`, `Tr`, and Unicode via `/ToUnicode`. This gives you **true deletion** — which solves hard cases 6, 7, and the "old text still extractable" defect in one move.
  - pdf-lib does not expose this, but it doesn't block you: `page.node.Contents()` → `PDFRawStream` → `decodePDFRawStream(...).decode()` → edit bytes → write back a new `PDFRawStream`/`PDFContentStream`. That's the escape hatch on your existing stack.
- **Two-path edit:** (a) *in-place re-encode* when every new character has a glyph in the existing embedded font (check with fontkit against the actual font program, **not** `/Widths`) — highest fidelity, preserves the original look exactly; (b) *delete + redraw* with your embedded font when it doesn't. Path (a) covers the most common real edit (fix a typo, change a number, swap a name) and looks perfect.
- **`Tw` gotcha when re-encoding:** word-spacing applies only to single-byte code 32. Change encoding or split strings and spacing silently drifts.

**Tier 3 — defer, but design so they can slot in**
- Paragraph grouping + reflow; OCR (Tesseract WASM) for scans; bidi/shaping via HarfBuzz WASM; incremental-update saving to preserve signatures; MuPDF WASM as a fallback engine for files pdf-lib refuses.

---

## 4. pdf-lib-specific gotchas (your stack)

- **Full re-serialize, never incremental.** It parses every object and rewrites the xref. Untouched objects generally round-trip, but the byte layout changes completely: linearization gone, **all digital signatures invalidated**, incremental-update history collapsed (#816).
- **Stricter parser than the renderer you ship next to it.** pdf-lib is *less* permissive with malformed files than PDF.js/PDFium (#902 — e.g. `Expected instance of e, but got instance of undefined`). Real consequence for you: **a file can render perfectly in your UI and then fail to save.** Parse with pdf-lib *at load time*, not at save time, and degrade to read-only immediately if it throws.
- **Encryption: unsupported, and `ignoreEncryption` is a trap** — it doesn't decrypt, it just lets you produce a broken file. Detect and refuse.
- **AcroForms:** `save()` by default runs `updateFieldAppearances`, regenerating `/AP` streams with Helvetica — this mangles non-Latin values and custom-styled fields (#488, #569, #185). Pass `false`, or supply the embedded font to `form.updateFieldAppearances(font)`.
- **Object streams:** `useObjectStreams: true` (default) is smaller; `false` is what people fall back to when output won't open in a given viewer. Make it a config flag you can flip per-file.
- **Rotation/MediaBox:** `getSize()` ignores `/Rotate`; draw coords assume origin (0,0). Common workaround is `page.setRotation(degrees(0))`, draw, restore — but building your own `cm` is cleaner.
- **No CropBox awareness at all** — and PDF.js *is* CropBox-based. This mismatch is where most "the box is 30pt off on some documents" bugs come from.
- **Fontkit subsetting** (`embedFont(bytes, { subset: true })`) can emit broken subsets for some CFF/OpenType files; if a glyph renders in the browser but not in Acrobat, retry unsubsetted before debugging anything else.
- **Two font models to reconcile.** PDF.js gives you Unicode + its own font objects; pdf-lib gives you embedding + widths. Nothing bridges them — you own that mapping layer.

---

## 5. UX patterns that work

- **Per-line editable boxes, not per-paragraph, for v1.** Sejda does this and it's the right call: lines are what the content stream actually gives you, grouping into paragraphs is a heuristic that fails on tables/columns, and a wrong grouping is worse than no grouping. Merge runs into a line by shared baseline (±0.5pt), same font/size, and gap < ~0.3em.
- **Click a line → an inline `contenteditable`/`input` overlaid exactly on the run**, styled with the extracted font size/color and a matched web font. Hide the canvas glyphs for that run only (paint the "after" state optimistically) so the user sees WYSIWYG, and only commit to the PDF on blur/save.
- **Show what's editable before the click.** A subtle hover outline on every editable run, and a *different* (or absent) affordance on runs you know you can't do well — Type3, outlines, `3 Tr`, XObject-shared content.
- **Overflow:** live width measurement against the original run's advance width. Show a right-edge marker the instant the new text exceeds it, and offer three explicit choices — *let it overflow*, *shrink to fit* (font size or `Tz` condense, capped ~90% before it looks wrong), *extend the box* (only safe when the next run on the line is far enough away). Never silently reflow.
- **Fonts you can't reuse:** be explicit rather than clever. Acrobat's model — substitute and warn — is the industry norm; Sejda's — try to re-embed, else pick a metric-alike — is better. Show a per-edit chip: *"Original font `ABCDEF+Garamond` has no glyph for 'é'. Using embedded Source Serif — appearance may differ."* A visible diff (toggle original/edited) buys enormous trust here.
- **Global honesty banner** on load: which of the unsupported conditions this document hits, before the user invests effort typing.

---

## PRIORITIZED v1 SCOPE

**MUST handle (a v1 without these isn't useful):**
1. Correct coordinates: `/Rotate` 0/90/180/270, non-zero `/MediaBox` origin, `/CropBox` ≠ `/MediaBox`.
2. Text in the page `/Contents` **and** one level of Form XObject (`/Do`) — with a warning when the XObject is shared across pages.
3. `/Contents` as an array; `/Resources` inherited from the parent `Pages` node.
4. Detect and refuse: encrypted files, image-only pages, invisible OCR layers (`3 Tr`), pdf-lib parse failures → read-only mode.
5. **True removal** of the edited run (content-stream edit), not a white rectangle — this is what makes non-white backgrounds, search, and copy/paste correct simultaneously.
6. Glyph-availability check against the actual embedded font program; automatic fallback to an embedded fallback font with a visible notice.
7. Single-line edit with no reflow + explicit overflow handling.
8. Save that opens cleanly in Acrobat, Chrome, Preview, and Firefox (test all four; add `useObjectStreams: false` fallback).
9. Warn before saving a signed PDF that the signature will be invalidated.

**Explicitly unsupported, with in-UI warning:**
- Scanned / image-only pages and OCR'd scans (offer *annotate on top* mode only).
- Text drawn as vector outlines.
- Encrypted / password-protected files.
- Type3 fonts.
- Vertical writing mode, RTL bidi, Arabic/Indic shaping.
- Paragraph and multi-line reflow; tables and multi-column re-wrap.
- Text inside annotation appearance streams other than plain form fields.
- Tagged-PDF structure and PDF/A conformance preservation.
- Signature preservation / incremental save.
- OCG-heavy and transparency-group content: allow, but flag as "may render differently."

**Sources:**
- [pdf-lib README (stated limits: no page-text editing, no encryption, `updateFieldAppearances`)](https://github.com/Hopding/pdf-lib)
- [pdf-lib #1326 – encrypted documents](https://github.com/Hopding/pdf-lib/issues/1326), [#1390 – blank pages from encrypted copies](https://github.com/Hopding/pdf-lib/issues/1390), [#1296](https://github.com/Hopding/pdf-lib/issues/1296)
- [pdf-lib #902 – stricter than PDF.js/PDFium on corrupt files](https://github.com/Hopding/pdf-lib/issues/902)
- [pdf-lib #816 – incremental updates](https://github.com/Hopding/pdf-lib/issues/816), [PR #1741](https://github.com/Hopding/pdf-lib/pull/1741), [@cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib)
- [pdf-lib #65](https://github.com/Hopding/pdf-lib/issues/65), [#545](https://github.com/Hopding/pdf-lib/issues/545), [#524](https://github.com/Hopding/pdf-lib/issues/524), [Discussion #1725](https://github.com/Hopding/pdf-lib/discussions/1725) – rotation/coordinate bugs
- [pdf-lib #488](https://github.com/Hopding/pdf-lib/issues/488), [#569](https://github.com/Hopding/pdf-lib/issues/569), [#185](https://github.com/Hopding/pdf-lib/issues/185) – AcroForm appearance problems
- [pdf.js #15403 – editing existing annotations](https://github.com/mozilla/pdf.js/issues/15403), [#14970](https://github.com/mozilla/pdf.js/issues/14970), [#7996 – glyph positions in getTextContent](https://github.com/mozilla/pdf.js/issues/7996), [#8096](https://github.com/mozilla/pdf.js/issues/8096), [#12031](https://github.com/mozilla/pdf.js/issues/12031)
- [Stirling-PDF #1855 – find & replace](https://github.com/Stirling-Tools/Stirling-PDF/issues/1855), [Discussion #1262](https://github.com/Stirling-Tools/Stirling-PDF/discussions/1262), [Stirling PDF 2.0 alpha text editing](https://www.opensourceforu.com/2025/12/stirling-pdf-2-0-brings-text-editing-and-enterprise-tools-to-open-source/), [docs](https://docs.stirlingpdf.com/Functionality/Content-Editing/)
- [Adobe: edit text in PDFs / font substitution](https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html), [Adobe KB: "No available system font"](https://helpx.adobe.com/acrobat/kb/error-no-available-system-font.html)
- [Sejda PDF editor](https://www.sejda.com/pdf-editor), [Sejda OCR – scans not editable](https://www.sejda.com/ocr-pdf)
- [MuPDF.js redactions (true glyph removal)](https://mupdfjs.readthedocs.io/en/latest/how-to-guide/annotations/redactions/index.html), [MuPDF.js API intro](https://artifex.com/blog/introducing-the-mupdf.js-api)
- [PDFBox token-based replace example](https://github.com/chadilukito/Apache-PdfBox-2-Examples/blob/master/ReplaceText.java), [Ulf Dittmer: PDFBox text substitution caveats](https://www.ulfdittmer.com/view?PdfboxReplace=)
- [Adobe PDEText model](https://opensource.adobe.com/dc-acrobat-sdk-docs/acrobatsdk/apireference/PDFEdit_Layer/PDEText.html), [PDF text operators reference](https://www.syncfusion.com/succinctly-free-ebooks/pdf/text-operators)
- [Font subsetting / missing glyph background](https://onlinepdfedits.com/blog/pdf-fonts-guide)