# pdf.js 6.2.108 — TextItem → DOM geometry, and whether TextItem order tracks show operators

All paths relative to `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/`. Bundled files are the shipped dist; the bundle marks upstream origins with comments (`;// ./src/display/text_layer.js` at `build/pdf.mjs:14812`, `;// ./src/core/evaluator.js` for the worker code).

Key files:
- `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/build/pdf.mjs` — `class TextLayer` at **14819**, `#appendText` at **14994**, `#layout` at **15063**, `#getAscent` at **15146**, `setLayerDimensions` at **1509**, `Util.transform` at **546**, `PageViewport` at **808**, `normalizeUnicode` at **729**.
- `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/build/pdf.worker.mjs` — `getTextContent` at **35668**, `getCurrentTextTransform` **35778**, `ensureTextContentItem` **35789**, `runBidiTransform` **35856**, `compareWithLastPosition` **35882**, `buildTextContentItem` **36016**, `appendEOL` **36115**, `addFakeSpaces` **36133**, `flushTextContentItem` **36158**, show-op dispatch **36259–36318**.
- `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/web/pdf_viewer.css` — `.textLayer` block at **615–700**; `--scale-factor` at **6186**, `--total-scale-factor` at **6239**. (There is **no** standalone `text_layer.css` in the dist — it is concatenated into `web/pdf_viewer.css`, mirrored at `legacy/web/pdf_viewer.css`.)
- `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/types/src/display/api.d.ts:312` — `TextItem` typedef; `:353` — `TextMarkedContent`.

---

## 1. transform[] → CSS box: the exact algorithm

### 1a. The layer-level transform (constructor, `build/pdf.mjs:14859-14883`)

```js
this.#scale = viewport.scale * OutputScale.pixelRatio;          // 14864
this.#rotation = viewport.rotation;                              // 14865
const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
this.#transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];     // 14877
this.#pageWidth = pageWidth;
this.#pageHeight = pageHeight;
TextLayer.#ensureMinFontSizeComputed();
container.style.setProperty("--min-font-size", TextLayer.#minFontSize);  // 14881
setLayerDimensions(container, viewport);                          // 14882
```

Critical change vs. pdf.js ≤ v3: **`#transform` contains no scale and no rotation**. It is a pure y-flip into *unscaled PDF-unit space with a top-left origin*. `rawDims` (`build/pdf.mjs:881`) is `{pageWidth: viewBox[2]-viewBox[0], pageHeight: viewBox[3]-viewBox[1], pageX: viewBox[0], pageY: viewBox[1]}`. Scale is applied by CSS (`--total-scale-factor`), rotation by the container attribute `data-main-rotation` (`setLayerDimensions`, `build/pdf.mjs:1528-1530`). `#scale` is used **only for canvas text measurement**, never for positioning.

### 1b. Per-item math (`#appendText`, `build/pdf.mjs:14994-15062`)

```js
const tx = Util.transform(this.#transform, geom.transform);              // 15004
let angle = Math.atan2(tx[1], tx[0]);                                    // 15005
const style = this.#styleCache[geom.fontName];
if (style.vertical) { angle += Math.PI / 2; }                            // 15007
let fontFamily = this.#fontInspectorEnabled && style.fontSubstitution || style.fontFamily;
fontFamily = TextLayer.fontFamilyMap.get(fontFamily) || fontFamily;
const fontHeight = Math.hypot(tx[2], tx[3]);                             // 15012
const fontAscent = fontHeight * TextLayer.#getAscent(fontFamily, style, this.#lang); // 15013
let left, top;
if (angle === 0) {
  left = tx[4];
  top  = tx[5] - fontAscent;
} else {
  left = tx[4] + fontAscent * Math.sin(angle);
  top  = tx[5] - fontAscent * Math.cos(angle);
}
const divStyle = textDiv.style;
divStyle.left = `${(100 * left / this.#pageWidth).toFixed(2)}%`;          // 15023
divStyle.top  = `${(100 * top  / this.#pageHeight).toFixed(2)}%`;        // 15024
divStyle.setProperty("--font-height", `${fontHeight.toFixed(2)}px`);     // 15025
divStyle.fontFamily = fontFamily;
textDivProperties.fontSize = fontHeight;
textDiv.textContent = geom.str;
textDiv.dir = geom.dir;
if (angle !== 0) { textDivProperties.angle = angle * (180 / Math.PI); }  // 15035
```

`Util.transform(m1, m2)` (`build/pdf.mjs:546`) is standard PDF matrix concat `m2 × m1`:
```js
[m1[0]*m2[0]+m1[2]*m2[1], m1[1]*m2[0]+m1[3]*m2[1],
 m1[0]*m2[2]+m1[2]*m2[3], m1[1]*m2[2]+m1[3]*m2[3],
 m1[0]*m2[4]+m1[2]*m2[5]+m1[4], m1[1]*m2[4]+m1[3]*m2[5]+m1[5]]
```

With `#transform = [1,0,0,-1,-pageX, pageY+pageHeight]` and `t = geom.transform`, this reduces to:
```
tx = [ t[0], -t[1], t[2], -t[3], t[4]-pageX, (pageY+pageHeight) - t[5] ]
```
so `tx[4], tx[5]` is the glyph-run **baseline origin** in top-left PDF units, `fontHeight = hypot(t[2], t[3])` is the em height, and the `left/top` adjustment lifts the baseline to the text box's top edge along the run's own rotated axis.

### 1c. `--scale-x` horizontal fitting (`#layout`, `build/pdf.mjs:15037-15090`)

```js
let shouldScaleText = false;
if (geom.str.length > 1) {
  shouldScaleText = true;                                             // 15039
} else if (geom.str !== " " && geom.transform[0] !== geom.transform[3]) {
  const absScaleX = Math.abs(geom.transform[0]), absScaleY = Math.abs(geom.transform[3]);
  if (absScaleX !== absScaleY && Math.max(absScaleX, absScaleY)/Math.min(absScaleX, absScaleY) > 1.5) {
    shouldScaleText = true;                                           // 15044
  }
}
if (shouldScaleText) {
  textDivProperties.canvasWidth = style.vertical ? geom.height : geom.width;  // 15048
}
...
#layout(params) {
  if (properties.canvasWidth !== 0 && properties.hasText) {
    TextLayer.#ensureCtxFont(ctx, fontSize * this.#scale, fontFamily);
    const { width } = ctx.measureText(div.textContent);
    if (width > 0) {
      style.setProperty("--scale-x", canvasWidth * this.#scale / width);      // 15085
    }
  }
  if (properties.angle !== 0) {
    style.setProperty("--rotate", `${properties.angle}deg`);                  // 15089
  }
}
```
`#scale` cancels in the `--scale-x` ratio; it only makes the measurement numerically stable and DPR-aware. `#getAscent` (`15146`) uses `ctx.measureText("").fontBoundingBoxAscent / (ascent+descent)`, falling back to `style.ascent`, `1 + style.descent`, else **0.8**.

### 1d. CSS side (`web/pdf_viewer.css:615-661`, `:6186`, `:6239`)

```css
.textLayer{
  position:absolute; inset:0; overflow:clip; line-height:1;
  letter-spacing:normal; word-spacing:normal; text-size-adjust:none;
  transform-origin:0 0;
  :is(span, br){ color:transparent; position:absolute; white-space:pre;
                 cursor:text; transform-origin:0% 0%; user-select:text; }
  --min-font-size:1;
  --text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv:calc(1 / var(--min-font-size));
  > :not(.markedContent), .markedContent span:not(.markedContent){
    z-index:1;
    --font-height:0;
    font-size:calc(var(--text-scale-factor) * var(--font-height));
    --scale-x:1; --rotate:0deg;
    transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .markedContent{ display:contents; }
}
.pdfViewer{ --scale-factor:1; }                                     /* 6186 */
.pdfViewer .page{ --user-unit:1;
  --total-scale-factor:calc(var(--scale-factor) * var(--user-unit)); /* 6239 */
  --scale-round-x:1px; --scale-round-y:1px; }
```
`setLayerDimensions` (`build/pdf.mjs:1518-1519`) sizes the layer:
```js
const widthStr  = `round(down, var(--total-scale-factor) * ${pageWidth}px, var(--scale-round-x))`,
      heightStr = `round(down, var(--total-scale-factor) * ${pageHeight}px, var(--scale-round-y))`;
```
`--min-font-size` guards against the browser's minimum-font-size setting: `#ensureMinFontSizeComputed` (`build/pdf.mjs:15132`) measures a `font-size:1px; line-height:1` "X" and stores its clientHeight; font-size is multiplied by it and undone with `scale(1/min)`. On a default browser it is 1 (no-op).

### 1e. Re-implementation recipe for a React overlay

Two equivalent options — use (B) unless you want pdf.js's zoom-without-relayout property.

**(A) pdf.js-identical, resolution independent (recommended for overlays that must survive zoom):**
```js
const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;   // unscaled PDF units
const t = item.transform;
const tx = [t[0], -t[1], t[2], -t[3], t[4] - pageX, (pageY + pageHeight) - t[5]];
let angle = Math.atan2(tx[1], tx[0]);
if (styles[item.fontName].vertical) angle += Math.PI / 2;
const fontHeight = Math.hypot(tx[2], tx[3]);                        // PDF units
const ascent = ascentRatio(fontFamily, style);                      // 0.8 fallback
const fa = fontHeight * ascent;
const left = angle === 0 ? tx[4] : tx[4] + fa * Math.sin(angle);
const top  = angle === 0 ? tx[5] - fa : tx[5] - fa * Math.cos(angle);
// box in PDF units, before rotation about its own top-left corner:
const boxW = (styles[item.fontName].vertical ? item.height : item.width);
const boxH = fontHeight;
// CSS:
style.left     = `${100*left/pageWidth}%`;
style.top      = `${100*top /pageHeight}%`;
style.height   = `calc(var(--total-scale-factor) * ${fontHeight}px)`;
style.width    = `calc(var(--total-scale-factor) * ${boxW}px)`;
style.transformOrigin = "0 0";
style.transform = `rotate(${angle * 180/Math.PI}deg)`;
```
Container: `position:absolute; inset:0; transform-origin:0 0;` sized to `viewport.width × viewport.height`, with `--total-scale-factor` (or your own `--scale-factor`) set to `viewport.scale`, and `data-main-rotation = viewport.rotation` handled by rotating the container (`web/pdf_viewer.css:6170-6183`). For a *page-rotated* PDF, pdf.js does **not** put rotation into per-item math — it rotates the whole layer.

**(B) direct CSS-pixel math (simpler; must recompute on zoom):**
```js
const tx = Util.transform(viewport.transform, item.transform);  // viewport.transform: pdf.mjs:877
const angle = Math.atan2(tx[1], tx[0]);
const fontHeight = Math.hypot(tx[2], tx[3]);                    // already in CSS px
const fa = fontHeight * ascentRatio;
const left = tx[4] + (angle ? fa*Math.sin(angle) : 0);
const top  = tx[5] - (angle ? fa*Math.cos(angle) : fa);
const width = item.width * viewport.scale;                      // see §2
```
`viewport.transform` (`build/pdf.mjs:877`) already carries scale × userUnit × rotation × viewBox offset, so (B) handles rotated pages per-item.

For an **editable box** you want the em box, not pdf.js's zero-height span: `top = baselineTop - ascent*fontHeight`, `height = fontHeight`, `width = item.width * scale`. Do **not** rely on `--scale-x`: that is a hack to make browser-measured glyph widths match PDF widths for *selection*; for editing you should set an explicit `width` and let the text overflow or scale it yourself.

---

## 2. Units of `item.width` / `item.height`; transform[0] vs transform[3]; text rise

### Where they come from

`ensureTextContentItem` (`build/pdf.worker.mjs:35811-35822`) seeds them from the text rendering matrix:
```js
const trm = textContentItem.transform = getCurrentTextTransform();
if (!font.vertical) {
  textContentItem.width = textContentItem.totalWidth = 0;
  textContentItem.height = textContentItem.totalHeight = Math.hypot(trm[2], trm[3]);
  textContentItem.vertical = false;
} else {
  textContentItem.width = textContentItem.totalWidth = Math.hypot(trm[0], trm[1]);
  textContentItem.height = textContentItem.totalHeight = 0;
  textContentItem.vertical = true;
}
```
Advances accumulate in **text space** and are converted at flush time:
```js
// buildTextContentItem, 36041 / 36084 / 36087
const scale = textState.fontMatrix[0] * textState.fontSize;   // glyph units → text space
let scaledDim = glyphWidth * scale;
...
scaledDim *= textState.textHScale;                            // 36084  ← Th applied HERE
textState.translateTextMatrix(scaledDim, 0);
textChunk.width += scaledDim;
// ensureTextContentItem, 35823-35824
const scaleLineX = Math.hypot(textState.textLineMatrix[0], textState.textLineMatrix[1]);
const scaleCtmX  = Math.hypot(textState.ctm[0], textState.ctm[1]);
textContentItem.textAdvanceScale = scaleCtmX * scaleLineX;
// flushTextContentItem, 36158-36166
textContentItem.totalWidth += textContentItem.width * textContentItem.textAdvanceScale;
// runBidiTransform, 35862-35869
width:  Math.abs(textChunk.totalWidth),
height: Math.abs(textChunk.totalHeight),
```

### Answer

- **Units:** the same space `item.transform` lives in — **PDF user space of the page content stream** (i.e. `textState.ctm`-space, which starts at IDENTITY for page content: `TextState.ctm = new Float32Array(IDENTITY_MATRIX)`, `build/pdf.worker.mjs:37578`). The typedef's "Width in device space" (`types/src/display/api.d.ts:325`) is misleading: **no viewport scale, no page rotation, no y-flip is applied**. For an unrotated page with no `cm`, these are points (1/72"). Multiply by `viewport.scale * userUnit` to get CSS px.
- **Horizontal text:** `width` = accumulated advance (glyph widths + charSpacing + wordSpacing + TJ kerning, all included, because they all move `textMatrix`), `height` = `hypot(trm[2], trm[3])` = **the em height, constant for the item** — *not* a glyph bbox and *not* an ascender+descender measurement.
- **Vertical text (`font.vertical`)**: roles swap — `width` = `hypot(trm[0], trm[1])`, `height` accumulates.
- **Zero-width diacritics** contribute 0 (`36080-36082`), and **`\p{Cf}` format marks are skipped entirely without advancing the matrix** (`36048-36050`) — so `item.width` can under-run the true painted advance for text containing e.g. U+00AD.

### transform[0] vs transform[3] and the horizontal-scale interaction

`getCurrentTextTransform` (`build/pdf.worker.mjs:35778-35787`):
```js
const tsm = [textState.fontSize * textState.textHScale, 0, 0, textState.fontSize, 0, textState.textRise];
...
return Util.transform(textState.ctm, Util.transform(textState.textMatrix, tsm));
```
So **`Tz` (horizontal scale) enters only the first column** (`transform[0]`, and `transform[1]` under rotation), never `transform[3]`. Therefore:

- `transform[0] !== transform[3]` ⟺ non-uniform scaling, which is `Tz ≠ 100`, or a non-uniform `cm`/`Tm`, or a non-square `FontMatrix` (Type3).
- `fontHeight = hypot(tx[2], tx[3])` deliberately uses **column 2 only**, so the DOM font size is Th-independent; the horizontal stretch is restored by `--scale-x` in `#layout` (`build/pdf.mjs:15085`). That is exactly why `shouldScaleText` fires for a single char when `Math.max/Math.min > 1.5` (`build/pdf.mjs:15040-15045`).
- `item.width` **does** include Th (line 36084). So `item.width / fontHeight` is a legitimate "stretched aspect" and `--scale-x` reconstructs it. If you reimplement, set the box width from `item.width` and the box height from `hypot(transform[2],transform[3])` — do not derive width from font size.

### Text rise (`Ts`)

- Rise is `tsm[5]`, so it shifts the *translation* of the TRM: `transform[4], transform[5]` are the **risen** baseline origin. Rise never affects `transform[0..3]`, so it never affects `fontHeight` or `angle`.
- pdf.js explicitly **prevents rise changes from splitting an item** (`build/pdf.worker.mjs:35982-35986`):
```js
const textRiseDelta = textState.textRise - textContentItem.prevTextRise;
const advanceYCorrected = textRiseDelta === 0
  ? advanceY
  : advanceY - currentTransform[3] / textState.fontSize * textRiseDelta;
if (Math.abs(advanceYCorrected) > textContentItem.height) { appendEOL(); return true; }
```
`prevTextRise` is snapshotted per glyph (`36093`). Consequence: superscripts/subscripts set via `Ts` are **merged into the surrounding run**, and the item's `transform[5]` is that of the *first* glyph — so a run containing a superscript has glyphs at y-offsets not derivable from `item.transform`. Only a size/font change (§3) will split them.

---

## 3. Splitting and merging — the flush logic

`textContentItem` (`build/pdf.worker.mjs:35711-35729`) is a single mutable accumulator. `flushTextContentItem` (`36158`) is what actually emits an item:
```js
function flushTextContentItem() {
  if (!textContentItem.initialized || !textContentItem.str) return;
  if (!textContentItem.vertical) textContentItem.totalWidth  += textContentItem.width  * textContentItem.textAdvanceScale;
  else                          textContentItem.totalHeight += textContentItem.height * textContentItem.textAdvanceScale;
  textContent.items.push(runBidiTransform(textContentItem));
  textContentItem.initialized = false;
  textContentItem.str.length = 0;
}
```

### A. A single Tj/TJ SPLITS into multiple items when (horizontal case, `compareWithLastPosition`, 35882-36014)

Thresholds (`35747-35753`): `TRACKING_SPACE_FACTOR = 0.102`, `NOT_A_SPACE_FACTOR = 0.03`, `NEGATIVE_SPACE_FACTOR = -0.2`, `SPACE_IN_FLOW_MIN_FACTOR = 0.102`, `SPACE_IN_FLOW_MAX_FACTOR = 0.6`, `VERTICAL_SHIFT_RATIO = 0.25`, all multiplied by `fontSize` at item start (`35828-35832`).

1. **Big backwards jump** — `advanceX < textOrientation * negativeSpaceMax` (i.e. more than `0.2·fontSize` backwards, 35973): flush; and if `|advanceY| > 0.5·height`, `appendEOL()` (which sets `hasEOL = true` then flushes, `36115-36131`).
2. **Vertical jump larger than the em box** — `|advanceYCorrected| > textContentItem.height` (35984): `appendEOL()` → item flushed with `hasEOL: true`. This is the line-break detector, and it fires **inside a single TJ** if the array kerning moves the pen far enough, or from `Td/TD/T*/Tm` between shows.
3. **A gap in the "fake space" band** — `addFakeSpaces` (36133) when the gap is **outside** `[spaceInFlowMin, spaceInFlowMax] = [0.102·fs, 0.6·fs]`: it flushes and pushes a standalone `" "` item:
```js
function addFakeSpaces(width, transf, textOrientation) {
  if (textOrientation * spaceInFlowMin <= width && width <= textOrientation * spaceInFlowMax) {
    if (textContentItem.initialized) { resetLastChars(); textContentItem.str.push(" "); }
    return false;                       // in-flow gap → " " goes INSIDE the current item
  }
  ... flushTextContentItem(); resetLastChars();
  pushWhitespace({ width: Math.abs(width), height: Math.abs(height), transform: transf ?? getCurrentTextTransform(), fontName });
  return true;                          // out-of-flow gap → SPLIT + separate " " item
}
```
4. **Whitespace-run boundary** — `advanceX <= trackingSpaceMin` and `shouldAddWhitepsace()` (35991-35999): flush, then `pushWhitespace({width})`.
5. **Small vertical drift** — `Math.abs(advanceY) > textContentItem.height * VERTICAL_SHIFT_RATIO` (36011): plain flush, no EOL.
6. **Font or size change** (`buildTextContentItem` entry, 36017-36020):
```js
if (currentTextState !== textState && (currentTextState.fontSize !== textState.fontSize ||
    currentTextState.fontName !== textState.fontName &&
    (currentTextState.font.name !== textState.font.name ||
     currentTextState.font.vertical !== textState.font.vertical))) {
  flushTextContentItem();
  currentTextState = textState.clone();
}
```
This runs **per TJ element**, so it can split mid-TJ if a `gs` with `/Font` intervenes.
7. **Glyphs clipped by the viewBox are DROPPED, not split** (35883-35891):
```js
if (posX + glyphWidth < viewBox[0] || posX > viewBox[2] || posY < viewBox[1] || posY > viewBox[3]) return false;
```
and the caller (36071-36078) skips the glyph entirely after advancing the matrix. **Off-page glyphs never appear in any TextItem.**
8. **`\p{Cf}` format marks** (soft hyphen, ZWJ, ZWNJ, LRM/RLM…) are skipped (`36048-36050`); **whitespace glyphs are skipped and re-synthesized** (`36060-36069`); **`\p{Mn}` marks** get `scaledDim = 0` (`36080`).

Also, unconditionally flushing (regardless of `includeMarkedContent`): `paintXObject` (36320-36321), `setGState` carrying a `/Font` (36414), and **every** `BMC` / `BDC` / `EMC` (36439-36463) — `flushTextContentItem()` is called *before* the `if (includeMarkedContent)` guard in all three.

### B. Multiple show operators MERGE into one item when…

…none of the above fires. Nothing in the operator loop flushes on its own for the text-positioning ops:
- `Td`, `TD`, `T*`, `TL`, `Tc`, `Tw`, `Tz`, `Ts` (36225-36258) never flush.
- **`BT` does not flush** (36236-36240: it only resets `textMatrix`/`textLineMatrix`), so runs from two different `BT…ET` blocks can land in the same item.
- `Tm` calls only `updateAdvanceScale()` (36244-36249, 35837-35855), which folds the pending advance into `totalWidth` and changes the scale — it does *not* flush.
- Chunk batching (`enqueueChunk`, 36171) and the `sink.desiredSize` yield (36466-36473) never split an item; they only slice the delivered array.

So: **consecutive `Tj`/`TJ`/`'`/`"` on the same line, same font, same size, whose gaps stay within the thresholds, are concatenated into one TextItem.** The item's `transform` is the TRM captured at the *first* glyph of the accumulation (`35812`), and `width` is the total run advance.

### C. Text-space vs. output order

`runBidiTransform` (35856-35870):
```js
let text = textChunk.str.join("");
if (!disableNormalization) { text = normalizeUnicode(text); }
const bidiResult = bidi(text, -1, textChunk.vertical);
return { str: bidiResult.str, dir: bidiResult.dir, width: Math.abs(textChunk.totalWidth), ... };
```
For RTL runs, `str` is **logically reordered** relative to the visual glyph order in the content stream. Character index within `str` therefore does not map to glyph order at all for `dir === "rtl"`.

---

## 4. Yes — pdf.js synthesizes spaces, and you cannot turn it off from the public API

Three independent synthesis paths, all on by default:

1. **`pushWhitespace`** (35761-35776) emits an entire fake `" "` TextItem with `transform` borrowed from `prevTransform`:
```js
function pushWhitespace({ width = 0, height = 0, transform = textContentItem.prevTransform, fontName = textContentItem.fontName }) {
  textContent.items.push({ str: " ", dir: "ltr", width, height, transform, fontName, hasEOL: false });
}
```
Callers: 35996, 35960/36002 (empty-item case), and `addFakeSpaces` (36152).
2. **`addFakeSpaces`** pushes `" "` *into* the current item's `str` for in-flow gaps of `0.102·fs … 0.6·fs` (36134-36139) — that is TJ-kerning-derived space synthesis, and it is the classic "phantom space" source.
3. **Real whitespace glyphs are deleted and re-materialized**, collapsed to at most one space, via the 2-slot ring buffer (35733-35745, 36060-36069, 36099-36102):
```js
function saveLastChar(char) {
  const nextPos = (twoLastCharsPos + 1) % 2;
  const ret = twoLastChars[twoLastCharsPos] !== " " && twoLastChars[nextPos] === " ";
  twoLastChars[twoLastCharsPos] = char; twoLastCharsPos = nextPos;
  return !keepWhiteSpace && ret;
}
...
if (!keepWhiteSpace && category.isWhitespace) { charSpacing += scaledDim; translate…; saveLastChar(" "); continue; }
...
if (saveLastChar(glyphUnicode)) { textChunk.str.push(" "); }
```
**Consequence: with default options, *every* space in `item.str` is synthetic** — the ones from the PDF were dropped and a single `" "` re-inserted lazily before the next non-space glyph. `"a    b"` in the PDF becomes `"a b"`.

**Disabling:** the only kill switch is `keepWhiteSpace`, and it is **not exposed**. `PDFPageProxy.streamTextContent` (`build/pdf.mjs:15797-15807`) forwards exactly two flags:
```js
includeMarkedContent: includeMarkedContent === true,
disableNormalization: disableNormalization === true
```
The worker's `getTextContent` accepts `keepWhiteSpace` (35681) but the only caller that sets it is annotation appearance extraction inside the worker (`build/pdf.worker.mjs:53547`, `keepWhiteSpace: true`). There is no `getTextContent` parameter, no `GlobalWorkerOptions`, and no `AppOptions` route to it from the main thread. Options if you need it: (a) fork/patch the worker, (b) run your own content-stream interpreter (recommended, see conclusion), or (c) heuristically discard items with `str === " "` — but note that (c) cannot recover the in-`str` spaces from path 2 or 3.

---

## 5. `disableNormalization: true` — what it actually preserves

`normalizeUnicode` (`build/pdf.mjs:729-736`, identical at `build/pdf.worker.mjs:720`):
```js
NormalizeRegex = /([\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71\ufe77\ufe79\ufe7b\ufe7d]+)|(\ufb05+)/gu;
NormalizationMap = new Map([["ﬅ", "ſt"]]);
return str.replaceAll(NormalizeRegex, (_, p1, p2) => p1 ? p1.normalize("NFKC") : NormalizationMap.get(p2));
```
Applied at `runBidiTransform` (35858) only when `!disableNormalization`.

**Setting it to `true` preserves:**
- **Latin ligatures U+FB00–FB04, FB06** as single code points: `ﬁ` stays `"\ufb01"` instead of expanding to `"fi"` (verified: `norm("ofﬁce ﬂy")` → `"office fly"`).
- `ﬅ` (U+FB05), which is otherwise mapped to the two-char `"ſt"` via the explicit map.
- **Hebrew and Arabic presentation forms** (FB20–FDFB, FE71–FE7D) — huge for Arabic: NFKC decomposes contextual/ligature forms into base letters, changing char counts wholesale.
- **NBSP U+00A0**, thin/en/em spaces **U+2000–200A**, narrow NBSP **U+202F** as themselves rather than `U+0020`.
- Compatibility singletons: micro sign `µ` U+00B5 (→ `μ`), Greek question mark U+037E (→ `;`), Lao U+0EB3, ohm sign U+2126 (→ `Ω`).

**It does NOT preserve, and this trips people up:**
- **Soft hyphen U+00AD is gone either way.** It is `\p{Cf}`, so `buildTextContentItem` drops the glyph before normalization is ever reached (`build/pdf.worker.mjs:36048`, `SpecialCharRegExp = /^(\s)|(\p{Mn})|(\p{Cf})$/u` at `17387`; confirmed `/^\p{Cf}$/u.test("\u00ad") === true`). Same for ZWJ/ZWNJ/LRM/RLM. Worse, the drop happens *before* the matrix advance, so the item's accumulated `width` also loses that glyph's advance.
- **Whitespace normalization** — collapsing runs to one space and re-synthesizing spaces is `keepWhiteSpace`'s job (§4), completely independent of `disableNormalization`.
- **Bidi reordering** — always applied (35860).

**Why it matters for round-tripping:** with normalization on, `item.str.length` diverges from the glyph count (one `ﬁ` glyph ↔ two characters), so any character-offset → glyph-index → content-stream-byte mapping silently desynchronizes at the first ligature. If you edit by character offset and re-encode, you will write `f`+`i` where a `fi` glyph was, changing metrics and possibly hitting an unmapped code in a subsetted font. **Always set `disableNormalization: true` for an editor.** Even then, `str` is *not* a faithful decode: format marks are deleted, whitespace is rebuilt, spaces are invented, off-page glyphs are dropped, and RTL is reordered.

---

## 6. `includeMarkedContent: true`

Shape (`types/src/display/api.d.ts:353-366`), produced at `build/pdf.worker.mjs:36439-36463`:
```js
case OPS.beginMarkedContent:            // 36439
  flushTextContentItem();
  if (includeMarkedContent) { markedContentData.level++;
    textContent.items.push({ type: "beginMarkedContent", tag: args[0] instanceof Name ? args[0].name : null }); }
  break;
case OPS.beginMarkedContentProps:       // 36449
  flushTextContentItem();
  if (includeMarkedContent) { markedContentData.level++;
    const mcid = args[1] instanceof Dict ? args[1].get("MCID") : null;
    textContent.items.push({ type: "beginMarkedContentProps",
      id: Number.isInteger(mcid) ? `${self.idFactory.getPageObjId()}_mc${mcid}` : null,
      tag: args[0] instanceof Name ? args[0].name : null }); }
  break;
case OPS.endMarkedContent:              // 36459
  flushTextContentItem();
  if (includeMarkedContent) { if (markedContentData.level === 0) break;
    markedContentData.level--; textContent.items.push({ type: "endMarkedContent" }); }
```
So: `{type, tag}` for BMC, `{type, id, tag}` for BDC (`id` = `"pXX_mcNN"`, null when there is no integer `/MCID`), `{type}` for EMC. They are interleaved in the same `items` array; consumers must test `item.str === undefined` (`build/pdf.mjs:15008` in `#processItems`, and `build/pdf.worker.mjs:53530`).

`TextLayer.#processItems` (`build/pdf.mjs:14970-14992`) turns them into nesting `<span class="markedContent">` with `id` set, `ariaHidden` for `tag === "Artifact"`, and `display:contents` in CSS.

**Do they help correlate to structure?** Partially, and it is the single most useful lever pdf.js gives you:
- The `id` (`pageObjId_mcNN`) joins directly to `getStructTree()` node ids, so you can bind runs to `/P`, `/Span`, `/TD`, `/Figure` etc.
- **They flush unconditionally** — even with `includeMarkedContent: false` — so BDC/EMC are hard item boundaries. Turning the flag on therefore does **not** change how text items are cut; it only makes those boundaries visible. That is exactly why it is safe to enable.
- But: they only exist if the PDF is tagged; nesting can be deep and `tag`-only (no MCID); marked content can span multiple show ops and multiple items; and one show op can straddle nothing (BDC cannot occur mid-Tj). They give you **containment**, not a 1:1 operator mapping.

---

## 7. Shipped `textLayer.css` and the minimum rules for a pixel-accurate overlay

The dist has no standalone `text_layer.css`; the rules are at `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist/web/pdf_viewer.css:615-700` (mirrored in `legacy/web/pdf_viewer.css`; more `.textLayer` blocks at `:3392` and `:3561` are editor-cursor and toolbar theming only). Full block quoted in §1d.

Minimum set you must replicate:

```css
.myTextLayer {
  position: absolute; inset: 0;
  transform-origin: 0 0;
  overflow: clip;
  line-height: 1;              /* REQUIRED: line box == font-size */
  letter-spacing: normal;      /* REQUIRED: reset inherited tracking */
  word-spacing: normal;        /* REQUIRED */
  text-size-adjust: none; -webkit-text-size-adjust: none;  /* REQUIRED on mobile */
  forced-color-adjust: none;
  text-align: initial;
  --total-scale-factor: var(--scale-factor, 1);
}
.myTextLayer span {
  position: absolute;
  white-space: pre;            /* REQUIRED: preserve the synthesized spaces */
  transform-origin: 0% 0%;     /* REQUIRED: rotate/scale about the box corner */
  font-size: calc(var(--total-scale-factor) * var(--font-height));
  transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1));
}
```
Gotchas that actually break pixel alignment:
- `line-height: 1` and `transform-origin: 0 0` are load-bearing; any inherited `line-height: 1.5` from your app's CSS shifts every box.
- The layer must be sized with the *same rounding* as the canvas or you accumulate sub-pixel drift: `setLayerDimensions` uses `round(down, var(--total-scale-factor) * Wpx, var(--scale-round-x))` (`build/pdf.mjs:1518`) and the viewer sets `--scale-round-x/y` from the actual canvas/CSS ratio (`web/pdf_viewer.mjs:7087-7091`).
- `--scale-factor` must equal `viewport.scale` on the ancestor that also hosts the canvas. The viewer sets it at `web/pdf_viewer.mjs:6403` (`this.scale * PixelsPerInch.PDF_TO_CSS_UNITS`) and `:8722`; also `--user-unit` at `:6475` for PDFs with `/UserUnit ≠ 1`.
- `color: transparent` on spans is only for the invisible selection layer; for an editor you will want visible text, in which case `--scale-x` becomes visually significant and you should render your own font stack rather than trusting `style.fontFamily` (which is a *fallback* family name like `"sans-serif"` / `"serif"`, from `font.fallbackName`, `build/pdf.worker.mjs:35800`).

---

## Conclusion: is Nth TextItem ⇔ Nth show operator safe?

**No. It is not safe, not even approximately, and it fails in both directions on ordinary PDFs.**

The mapping is many-to-many:

| Direction | Cause | Evidence |
|---|---|---|
| 1 op → N items | vertical jump > em box → `appendEOL` | worker `35984`, `36115` |
| 1 op → N items | backward jump > `0.2·fontSize` | `35973` |
| 1 op → N items | TJ gap outside `[0.102, 0.6]·fs` → flush + fake-space item | `36133-36156` |
| 1 op → N items | drift `|advanceY| > 0.25 · height` | `36011` |
| 1 op → N items | font/size change between TJ elements | `36017-36020` |
| N ops → 1 item | `BT`/`Td`/`TD`/`T*`/`Tm` never flush | `36225-36258` |
| 1 op → 0 items | all glyphs outside `viewBox` | `35883-35891`, `36071` |
| 0 ops → 1 item | synthesized `" "` items | `35761`, `36152` |
| 0 ops → 1 item | empty `hasEOL` item when `appendEOL` fires uninitialized | `36121-36130` |
| order scrambled | bidi reordering of RTL runs | `35860` |
| extra boundaries | BDC/EMC/`Do`/`gs`-with-Font flush unconditionally | `36320`, `36414`, `36439-36463` |

Additionally, `Do` recursion into Form XObjects splices a nested `getTextContent` (`36320-36399`) whose items are enqueued via a sink wrapper into the same stream, and glyph-level deletions (`\p{Cf}`) mean even *within* one item the character index is not the glyph index.

### Recommended correlation key

Do not derive geometry from pdf.js at all for the editing model. Run your own content-stream interpreter (`getOperatorList` gives you `OPS.showText`/`showSpacedText` with resolved args, or parse the raw stream yourself for byte-accurate round-tripping) and build a **glyph-level record**, then use pdf.js only for rendering and for the accessibility/struct-tree overlay. Concretely:

1. **Primary key: per-glyph device-space anchor.** For each glyph, record `(pageIndex, mcid|null, TRM at glyph, advance, charCode, unicode, streamRef, byteOffset, indexWithinTJ)`. Compute the device-space quad exactly as pdf.js does: `Util.transform(ctm, Util.transform(Tm, [fs*Th, 0, 0, fs, 0, Ts]))`, then advance by `glyphWidth * FontMatrix[0] * fs * Th + Tc (+ Tw if code == 0x20)`.
2. **Correlation to a pdf.js TextItem** (only if you need it — e.g. to reuse pdf.js selection): match on a **rounded device-space bbox + normalized string**, not on index. Build the item's box from `item.transform` and `item.width` / `hypot(transform[2],transform[3])`, quantize to ~0.1 pt, and intersect against your glyph run's union box. Use `item.str` compared after applying the *same* mangling pdf.js applies (strip `\p{Cf}`, collapse whitespace runs to one space, optionally NFKC) so the strings are comparable — with `disableNormalization: true` set, so you control the NFKC step yourself.
3. **Disambiguate with `includeMarkedContent: true`.** Since BDC/EMC are unconditional flush points, the `mcid` your interpreter reads and the `id: "pXX_mcNN"` pdf.js emits partition both sequences identically. Match *within* an MCID bucket rather than across the page — this collapses the search space enormously and is robust to all the split/merge rules above.
4. **Never key on `item.str` character offsets.** Key edits on your own glyph records; the TextItem is a *view*, and its `str` is a lossy, reordered, space-invented reconstruction.
5. **Ordering fallback (weak):** within one MCID bucket, on a page with no RTL, monotone `transform[5]` (line) then `transform[4]` (column) ordering of your runs and pdf.js's items usually agree — usable as a tie-breaker after bbox matching, never as the primary key.