# pdfjs-dist 6.2.108 — verified API contract

Read from `/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdfjs-dist`. Every claim below was checked against the files on disk; the import specifiers and `RenderParameters` shape were additionally verified by compiling probe files with the project's own `tsc -p tsconfig.json` and by running a real `vite build` (Vite 8.2.2 / rolldown).

---

## 1. Import specifiers

### There is NO `"exports"` field

`node_modules/pdfjs-dist/package.json` — verbatim, complete:

```json
{
  "name": "pdfjs-dist",
  "version": "6.2.108",
  "main": "build/pdf.mjs",
  "types": "types/src/pdf.d.ts",
  "description": "Generic build of Mozilla's PDF.js library.",
  "keywords": ["Mozilla", "pdf", "pdf.js"],
  "homepage": "https://mozilla.github.io/pdf.js/",
  "bugs": "https://github.com/mozilla/pdf.js/issues",
  "license": "Apache-2.0",
  "optionalDependencies": { "@napi-rs/canvas": "^1.0.0" },
  "browser": { "canvas": false, "fs": false, "http": false, "https": false, "url": false },
  "repository": { "type": "git", "url": "git+https://github.com/mozilla/pdf.js.git" },
  "engines": { "node": ">=22.13.0 || >=24" },
  "scripts": {}
}
```

Consequence: **no subpath is gated.** Any file in the package is importable by path. `main`/`types` are legacy fields, which `moduleResolution: "bundler"` (this project's setting) honors.

### What actually works

| Purpose | Specifier | Notes |
|---|---|---|
| Main entry (values **and** the types) | `'pdfjs-dist'` | → `build/pdf.mjs` + `types/src/pdf.d.ts` |
| Worker file for `new URL(...)` / `?url` | `'pdfjs-dist/build/pdf.worker.mjs'` | real file, 2.2 MB, verified on disk |
| Minified worker | `'pdfjs-dist/build/pdf.worker.min.mjs'` | 1.3 MB |
| Detailed types not re-exported by the barrel | `'pdfjs-dist/types/src/display/api'` | `.d.ts` resolves without extension |
| Viewer CSS (if you use `TextLayer`) | `'pdfjs-dist/web/pdf_viewer.css'` | |

**`build/` contains no `.d.mts`.** Verified:

```
build/pdf.min.mjs  build/pdf.mjs  build/pdf.mjs.map
build/pdf.sandbox.min.mjs  build/pdf.sandbox.mjs  build/pdf.sandbox.mjs.map
build/pdf.worker.min.mjs  build/pdf.worker.mjs  build/pdf.worker.mjs.map
```

(Only `legacy/build/pdf.d.mts` exists — the modern build has none.) So `import * as A from 'pdfjs-dist/build/pdf.mjs'` produces, verified:

```
error TS7016: Could not find a declaration file for module 'pdfjs-dist/build/pdf.mjs'.
```

**Always import values from the bare specifier `'pdfjs-dist'`.**

### Which types come from where

`types/src/pdf.d.ts:1-6` re-exports only six type aliases:

```ts
export type OnProgressParameters = import("./display/api").OnProgressParameters;
export type PDFDocumentLoadingTask = import("./display/api").PDFDocumentLoadingTask;
export type PDFDocumentProxy = import("./display/api").PDFDocumentProxy;
export type PDFPageProxy = import("./display/api").PDFPageProxy;
export type RenderTask = import("./display/api").RenderTask;
export type PageViewport = import("./display/page_viewport").PageViewport;
```

Verified error when pulling the rest from the barrel:

```
error TS2305: Module '"pdfjs-dist"' has no exported member 'TextItem'.
error TS2305: Module '"pdfjs-dist"' has no exported member 'TextContent'.
error TS2305: Module '"pdfjs-dist"' has no exported member 'RenderParameters'.
error TS2305: Module '"pdfjs-dist"' has no exported member 'DocumentInitParameters'.
error TS2305: Module '"pdfjs-dist"' has no exported member 'TextStyle'.
```

Working pattern (compiles clean under this repo's `strict` + `verbatimModuleSyntax` tsconfig):

```ts
import { getDocument, GlobalWorkerOptions, AnnotationMode, OPS, Util, PixelsPerInch, version, build } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type {
  DocumentInitParameters, RenderParameters, TextContent, TextItem, TextMarkedContent, TextStyle,
  PDFOperatorList, GetViewportParameters, getTextContentParameters,
} from 'pdfjs-dist/types/src/display/api';
```

Runtime value exports available from `'pdfjs-dist'` (`types/src/pdf.d.ts:69`): `AbortException, AnnotationEditorLayer, AnnotationEditorParamsType, AnnotationEditorType, AnnotationEditorUIManager, AnnotationLayer, AnnotationMode, AnnotationType, applyOpacity, build, ColorPicker, createValidAbsoluteUrl, CSSConstants, DOMSVGFactory, DrawLayer, FeatureTest, fetchData, findContrastColor, getDocument, getFilenameFromUrl, getPdfFilenameFromUrl, getRGB, getRGBA, getUuid, GlobalWorkerOptions, ImageKind, InvalidPDFException, isDataScheme, isPdfFile, isValidExplicitDest, makeArr, makeMap, makeObj, makeSet, MathClamp, noContextMenu, normalizeUnicode, OPS, OutputScale, PasswordException, PasswordResponses, PDFDataRangeTransport, PDFDateString, PDFWorker, PermissionFlag, PixelsPerInch, RenderingCancelledException, renderRichText, ResponseException, setLayerDimensions, shadow, SignatureExtractor, stopEvent, SupportedImageMimeTypes, TextLayer, TextLayerImages, TouchManager, updateUrlHash, Util, VerbosityLevel, version, XfaLayer`.

Note `PDFDocumentProxy`/`PDFPageProxy`/`RenderTask`/`PageViewport`/`PDFWorker` are classes but are **not** in that value list except `PDFWorker` — use them as types only.

---

## 2. Worker configuration under Vite 8

`types/src/display/worker_options.d.ts` (complete, 25 lines):

```ts
export class GlobalWorkerOptions {
    static #port: null;
    static #src: string;
    static set workerPort(val: Worker | null);   // Overrides the `workerSrc` option.
    static get workerPort(): Worker | null;
    static set workerSrc(val: string);
    static get workerSrc(): string;
}
```

### What `workerSrc` does internally — `build/pdf.mjs:16074-16089`

```js
  #initialize() {
    if (PDFWorker.#isWorkerDisabled || PDFWorker.#mainThreadWorkerMessageHandler) {
      this.#setupFakeWorker();
      return;
    }
    let { workerSrc } = PDFWorker;
    try {
      if (!PDFWorker._isSameOrigin(window.location, workerSrc)) {
        workerSrc = PDFWorker._createCDNWrapper(new URL(workerSrc, window.location).href);
      }
      const worker = new Worker(workerSrc, {
        type: "module"
      });
```

So `workerSrc` always spawns a **module** worker; cross-origin URLs get wrapped in a blob (`build/pdf.mjs:16030-16035`).

`workerPort` bypasses all of that — `build/pdf.mjs:16070-16073`:

```js
  #initializeFromPort(port) {
    this.#port = port;
    this.#messageHandler = new MessageHandler("main", "worker", port);
```

`getDocument` reads it at `build/pdf.mjs:16059-16063`:

```js
  if (!worker) {
    worker = PDFWorker.create({ verbosity, port: GlobalWorkerOptions.workerPort });
    task._worker = worker;
  }
```

### Recommended: `workerPort` + `new Worker(new URL(...))` — VERIFIED BUILDING

```ts
import { GlobalWorkerOptions } from 'pdfjs-dist';

const pdfWorker = new Worker(
  new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url),
  { type: 'module' }
);
GlobalWorkerOptions.workerPort = pdfWorker;
```

Real `vite build` output (Vite 8.2.2, `worker: { format: 'es' }` already set in `vite.config.ts`):

```
✓ 6 modules transformed.
dist/assets/pdf.worker-QCqaf3bc.js  1,187.06 kB
dist/assets/index-LT7_T7jT.js         428.20 kB │ gzip: 127.89 kB
```

The worker is bundled and minified into a normal chunk. This is the route to use.

### Alternative: `workerSrc` + `?url` — also works, but worse

```ts
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
```

Verified build:

```
dist/assets/pdf.worker-CLesOks4.mjs  2,222.99 kB
```

2.22 MB — Vite copies the file verbatim as an asset, **unminified and unbundled**. Roughly 2× the `new Worker(new URL(...))` route. Prefer `workerPort`.

Caveat on `workerPort`: `PDFWorker.#workerPorts` is a `WeakMap` and the constructor throws `"Cannot use more than one PDFWorker per port"` (`build/pdf.mjs:16049-16051`) if two `PDFWorker`s share one port. Since `getDocument` creates a `PDFWorker` per call, either (a) create one long-lived `PDFWorker` yourself and pass it as `src.worker`, or (b) create a fresh `Worker` per document. Option (a):

```ts
import { PDFWorker, getDocument } from 'pdfjs-dist';
const worker = new PDFWorker({ port: new Worker(new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url), { type: 'module' }) });
const doc = await getDocument({ data, worker }).promise;
```

---

## 3. `getDocument()` and `DocumentInitParameters`

`types/src/display/api.d.ts:721`:

```ts
export function getDocument(src?: DocumentInitParameters): PDFDocumentLoadingTask;
```

Returns a `PDFDocumentLoadingTask`; `await task.promise` → `PDFDocumentProxy`. `task.onPassword` / `task.onProgress` are assignable callbacks (`api.d.ts:809, 816`).

### `isEvalSupported` IS GONE

`grep -rl isEvalSupported node_modules/pdfjs-dist` → **zero files.** It is not in `DocumentInitParameters`, not in `build/pdf.mjs`, not in `build/pdf.worker.mjs`, not in the `.d.ts`. Do not pass it. (The QuickJS sandbox at `wasm/quickjs-eval.wasm` replaced the eval path.)

### The fields that matter, with real defaults (`build/pdf.mjs:15203-15246`)

```js
const cMapUrl = getFactoryUrlProp(src.cMapUrl);                                 // :15218
const cMapPacked = src.cMapPacked !== false;                                    // :15219  → default true
const iccUrl = getFactoryUrlProp(src.iccUrl);                                   // :15220
const standardFontDataUrl = getFactoryUrlProp(src.standardFontDataUrl);         // :15221
const wasmUrl = getFactoryUrlProp(src.wasmUrl);                                 // :15222
const disableFontFace = typeof src.disableFontFace === "boolean" ? src.disableFontFace : isNodeJS;  // :15228 → false in browser
const fontExtraProperties = src.fontExtraProperties === true;                   // :15229 → default false
const useWasm = src.useWasm !== false;                                          // :15241 → default true
const useSystemFonts = typeof src.useSystemFonts === "boolean" ? src.useSystemFonts : !isNodeJS && !disableFontFace;  // :15244 → true in browser
const useWorkerFetch = typeof src.useWorkerFetch === "boolean" ? src.useWorkerFetch
  : !!(BinaryDataFactory === DOMBinaryDataFactory && cMapUrl && cMapPacked && standardFontDataUrl
       && wasmUrl && isValidFetchUrl(cMapUrl, document.baseURI)
       && isValidFetchUrl(standardFontDataUrl, document.baseURI)
       && isValidFetchUrl(wasmUrl, document.baseURI));                          // :15245
```

**Trailing slash is mandatory or it throws** (`build/pdf.mjs`, `getFactoryUrlProp`):

```js
function getFactoryUrlProp(val) {
  if (typeof val !== "string") { return null; }
  if (val.endsWith("/")) { return val; }
  throw new Error(`Invalid factory url: "${val}" must include trailing slash.`);
}
```

**`useWorkerFetch` now requires `wasmUrl` too.** If you set only `cMapUrl` + `standardFontDataUrl`, `useWorkerFetch` silently falls back to `false` and assets are fetched on the main thread via `DOMBinaryDataFactory` and posted to the worker. Set all three to get the fast path.

Doc comments, `api.d.ts`:

- `data` (`:24`) — `string | number[] | ArrayBuffer | TypedArray`. `:20-22`: "If TypedArrays are used they will generally be transferred to the worker-thread… **it will take ownership of the TypedArrays**." The transfer list is literal (`build/pdf.mjs`): `sendWithPromise("GetDocRequest", docParams, data ? [data.buffer] : null)`. **Pass a copy if you also need the bytes for pdf-lib.**
- `useSystemFonts` (`:87`) — "When `true`, fonts that aren't embedded in the PDF document will fallback to a system font. Default `true` in web environments… unless `disableFontFace === true` in which case this defaults to `false`."
- `cMapUrl` (`:69`) / `cMapPacked` (`:74`, default `true` → use `.bcmap`).
- `standardFontDataUrl` (`:92`).
- `wasmUrl` (`:97`), `iccUrl` (`:79`).
- `stopAtErrors` (`:117`) — rejects `getOperatorList`/`getTextContent`/`RenderTask` on parse failure instead of recovering. Default `false`.
- `fontExtraProperties` (`:159`) — default `false`. **Required if you want `commonObjs` font `.data` to survive** (see §8).

### Assets that ship in the package (all present on disk)

| Directory | Count | Contents |
|---|---|---|
| `cmaps/` | **169** | `.bcmap` binary CMaps (`78-EUC-H.bcmap`, `90ms-RKSJ-H.bcmap`, `Adobe-CNS1-0.bcmap`, `Adobe-Japan1-UCS2.bcmap`, …) |
| `standard_fonts/` | **16** | `FoxitDingbats.pfb`, `FoxitFixed{,Bold,BoldItalic,Italic}.pfb`, `FoxitSerif{,Bold,BoldItalic,Italic}.pfb`, `FoxitSymbol.pfb`, `LiberationSans-{Regular,Bold,Italic,BoldItalic}.ttf`, `LICENSE_FOXIT`, `LICENSE_LIBERATION` |
| `wasm/` | **13** | `jbig2.wasm`, `jbig2_nowasm_fallback.js`, `openjpeg.wasm`, `openjpeg_nowasm_fallback.js`, `qcms_bg.wasm`, `quickjs-eval.wasm`, `quickjs-eval.js`, + 6 LICENSE files |
| `iccs/` | 2 | `CGATS001Compat-v2-micro.icc`, `LICENSE` |
| `image_decoders/`, `legacy/`, `web/`, `types/` | — | also present |

**Vite will not resolve a directory URL.** Verified build warning:

```
new URL('pdfjs-dist/cmaps/', import.meta.url) doesn't exist at build time,
it will remain unchanged to be resolved at runtime.
```

(A *file* URL does work: `new URL('pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap', import.meta.url)` emitted `assets/Adobe-Japan1-UCS2-BL-4M2vS.bcmap`.) So copy the three directories into `public/` at install/build time and use absolute paths:

```ts
const doc = await getDocument({
  data: new Uint8Array(bytes),          // pdf.js takes ownership — pass a copy
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  useSystemFonts: true,
  fontExtraProperties: true,            // only if you need font bytes / substitution info
}).promise;
```

---

## 4. `PDFPageProxy` method signatures

All from `types/src/display/api.d.ts`, class starts at `:1404`.

```ts
// :1449
getViewport({ scale, rotation, offsetX, offsetY, dontFlip, }?: GetViewportParameters): PageViewport;

// :1483 — note the destructured param is NOT optional
render({ canvasContext, canvas, viewport, intent, annotationMode, transform, background,
         optionalContentConfigPromise, annotationCanvasMap, pageColors, printAnnotationStorage,
         isEditing, recordImages, recordOperations, operationsFilter, }: RenderParameters): RenderTask;

// :1490
getOperatorList({ intent, annotationMode, printAnnotationStorage, isEditing, }?: GetOperatorListParameters): Promise<PDFOperatorList>;

// :1498
streamTextContent({ includeMarkedContent, disableNormalization, }?: getTextContentParameters): ReadableStream;

// :1507
getTextContent(params?: getTextContentParameters): Promise<TextContent>;

// :1513
getStructTree(): Promise<StructTreeNode>;

// :1526
cleanup(resetStats?: boolean): boolean;   // "Indicates if clean-up was successfully run."

// :1455
getAnnotations({ intent }?: GetAnnotationsParameters): Promise<Array<any>>;
```

Public fields/getters: `commonObjs: PDFObjects` (`:1412`), `objs: PDFObjects` (`:1413`), `pageNumber` (`:1426`), `rotate` (`:1430`), `ref` (`:1434`), `userUnit` (`:1438`), `view: Array<number>` (`:1443`, "[x1, y1, x2, y2]" in user space), `destroyed`, `recordedBBoxes`, `imageCoordinates`, `clone(id)`.

### `GetViewportParameters` (`api.d.ts:246-271`)

`scale` **required**; `rotation` (defaults to page rotation), `offsetX`=0, `offsetY`=0, `dontFlip`=false.

`PageViewport` (`types/src/display/page_viewport.d.ts:92-137`) exposes `viewBox, userUnit, scale, rotation, offsetX, offsetY, transform: number[], width, height`, `get rawDims()`, `clone()`, `convertToViewportPoint(x,y)`, `convertToPdfPoint(x,y)`.

`viewport.transform` is built at `build/pdf.mjs`:

```js
this.transform = [rotateA * scale, rotateB * scale, rotateC * scale, rotateD * scale,
                  offsetCanvasX - rotateA*scale*centerX - rotateC*scale*centerY,
                  offsetCanvasY - rotateB*scale*centerX - rotateD*scale*centerY];
```

with `scale *= userUnit` and, at rotation 0, `rotateA=1, rotateB=0, rotateC=0, rotateD=-1` — i.e. the y-flip lives here.

### ⚠️ `render()` — v6 requires `canvas`

`RenderParameters` (`api.d.ts:393-487`). The two relevant members:

```ts
    /**
     * - A DOM Canvas object. The default
     * value is the canvas associated with the `canvasContext` parameter if no
     * value is provided explicitly.
     */
    canvas: HTMLCanvasElement | null;              // :399  ← REQUIRED (no `?`)
    /**
     * - Rendering viewport obtained by calling the `PDFPageProxy.getViewport` method.
     */
    viewport: PageViewport;                        // :404  ← REQUIRED
    /**
     * - 2D context of a DOM Canvas object for backwards compatibility; it is
     * recommended to use the `canvas` parameter instead.
     * If the context must absolutely be used to render the page, the canvas must be null.
     */
    canvasContext?: CanvasRenderingContext2D | undefined;   // :412  ← now OPTIONAL
```

Verified negative test:

```
error TS2741: Property 'canvas' is missing in type
  '{ canvasContext: CanvasRenderingContext2D; viewport: any; }' but required in type 'RenderParameters'.
```

Runtime, `build/pdf.mjs:15635-15637`:

```js
  render({
    canvasContext,
    canvas = canvasContext.canvas,
```

`canvas` defaults from the context, so a JS caller passing only `canvasContext` still works; passing **neither** throws `TypeError: Cannot read properties of undefined (reading 'canvas')`.

And critically, `build/pdf.mjs:16884-16885` + `:16919`:

```js
    this._canvas = params.canvas;
    this._canvasContext = params.canvas ? null : params.canvasContext;
    ...
    const canvasContext = this._canvasContext || this._canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: !this._enableHWA
    });
```

**If `canvas` is non-null, your `canvasContext` is discarded** and pdf.js re-acquires the context itself with `{alpha:false, willReadFrequently:!enableHWA}`. To force your own context you must pass `canvas: null` explicitly — verified to typecheck:

```ts
const rp: RenderParameters = { canvas: null, canvasContext: ctx, viewport };
```

Canonical v6 call:

```ts
const viewport = page.getViewport({ scale });
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
const task = page.render({ canvas, viewport });   // canvas, NOT canvasContext
await task.promise;
```

Guard: `initializeGraphics` throws `"Cannot use the same canvas during multiple render() operations."` if a canvas is already in flight (`build/pdf.mjs:16903-16906`) — always `task.cancel()` before re-rendering into the same element.

Other `RenderParameters` members: `intent?: string` ('display' default), `annotationMode?: number` (`AnnotationMode.ENABLE` default), `transform?: any[]` (applied *before* the viewport transform), `background?: string | CanvasGradient | CanvasPattern` ('rgb(255,255,255)' default), `pageColors?`, `optionalContentConfigPromise?`, `annotationCanvasMap?: Map<string, HTMLCanvasElement>`, `printAnnotationStorage?`, `isEditing?: boolean`, and three v6 additions: `recordImages?: boolean` (`:476`), `recordOperations?: boolean` (`:481`, records per-op dependency bboxes into `page.recordedBBoxes`), `operationsFilter?: (index: number) => boolean` (`:486-488`).

`RenderTask` (`api.d.ts:1613-1651`): `promise: Promise<void>`, `cancel(extraDelay?: number)`, `onContinue`, `onError`, `separateAnnots: boolean`, `imageCoordinates`.

### `getOperatorList`

`GetOperatorListParameters` (`api.d.ts:492-518`): `intent?`, `annotationMode?`, `printAnnotationStorage?`, `isEditing?`.
Returns `PDFOperatorList` (`api.d.ts:551-561`):

```ts
export type PDFOperatorList = {
    fnArray: Array<number>;   // opcodes
    argsArray: Array<any>;    // per-op arguments
};
```

`OPS` values you'll need (`build/pdf.mjs`, `const OPS = {...}`): `dependency:1, save:10, restore:11, transform:12, beginText:31, endText:32, setCharSpacing:33, setWordSpacing:34, setHScale:35, setLeading:36, setFont:37, setTextRenderingMode:38, setTextRise:39, moveText:40, setLeadingMoveText:41, setTextMatrix:42, nextLine:43, showText:44, showSpacedText:45, nextLineShowText:46, nextLineSetSpacingShowText:47, paintXObject:66, beginMarkedContent:69, beginMarkedContentProps:70, endMarkedContent:71, paintImageXObject:85, constructPath:91, rawFillPath:94`.

**`getOperatorList()` (or `render()`) is what populates `commonObjs` with fonts.** See §8.

---

## 5. `TextContent` / `TextItem` / `TextMarkedContent` — exact shapes

`types/src/display/api.d.ts:290-357`, stripped of JSDoc:

```ts
export type TextContent = {
    items: Array<TextItem | TextMarkedContent>;   // :296
    styles: { [x: string]: TextStyle; };          // :301-303  keyed by TextItem.fontName
    lang: string | null;                          // :307      document /Lang
};

export type TextItem = {
    str: string;              // :316  Text content.
    dir: string;              // :320  Text direction: 'ttb', 'ltr' or 'rtl'.
    transform: Array<any>;    // :324  Transformation matrix.   (6 numbers)
    width: number;            // :328  Width in device space.
    height: number;           // :332  Height in device space.
    fontName: string;         // :336  Font name used by PDF.js for converted font.
    hasEOL: boolean;          // :341  Indicating if the text content is followed by a line-break.
};

export type TextMarkedContent = {
    type: string;   // :351  'beginMarkedContent' | 'beginMarkedContentProps' | 'endMarkedContent'
    id: string;     // :356  marked content identifier; only for 'beginMarkedContentProps'
};
```

Discriminate at runtime with `'str' in item`.

Exactly where these come from — `build/pdf.worker.mjs:35856-35871`:

```js
    function runBidiTransform(textChunk) {
      let text = textChunk.str.join("");
      if (!disableNormalization) {
        text = normalizeUnicode(text);
      }
      const bidiResult = bidi(text, -1, textChunk.vertical);
      return {
        str: bidiResult.str,
        dir: bidiResult.dir,
        width: Math.abs(textChunk.totalWidth),
        height: Math.abs(textChunk.totalHeight),
        transform: textChunk.transform,
        fontName: textChunk.fontName,
        hasEOL: textChunk.hasEOL
      };
    }
```

Two runtime facts the `.d.ts` omits:

1. **`TextMarkedContent` also carries `tag`,** and `id` can be `null` (`build/pdf.worker.mjs:36439-36470`):

```js
          case OPS.beginMarkedContent:
            ...
              textContent.items.push({ type: "beginMarkedContent",
                                       tag: args[0] instanceof Name ? args[0].name : null });
          case OPS.beginMarkedContentProps:
            ...
              const mcid = args[1] instanceof Dict ? args[1].get("MCID") : null;
              textContent.items.push({ type: "beginMarkedContentProps",
                  id: Number.isInteger(mcid) ? `${self.idFactory.getPageObjId()}_mc${mcid}` : null,
                  tag: args[0] instanceof Name ? args[0].name : null });
          case OPS.endMarkedContent:
            ...
              textContent.items.push({ type: "endMarkedContent" });
```

2. **Synthetic whitespace items** are injected with `dir: "ltr"` and a *reused* `transform` from the previous item (`build/pdf.worker.mjs:35771-35777`):

```js
    function pushWhitespace({ width = 0, height = 0,
                              transform = textContentItem.prevTransform,
                              fontName = textContentItem.fontName }) {
      textContent.items.push({ str: " ", dir: "ltr", width, height, transform, fontName, hasEOL: false });
```

So `str === " "` items are not real glyph runs and their transform is not independently derived — filter them before doing geometry.

### The `transform` array: what each entry is, and in what space

It's a standard PDF/canvas affine `[a, b, c, d, e, f]`, meaning `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.

| Index | Role |
|---|---|
| `[0]` = **a** | x-scale (+ x-shear from rotation) |
| `[1]` = **b** | y-shear (rotation) |
| `[2]` = **c** | x-shear (rotation) |
| `[3]` = **d** | y-scale — effective font size when unrotated |
| `[4]` = **e** | **translate x** — glyph-run origin, PDF user-space units |
| `[5]` = **f** | **translate y** — glyph-run origin, PDF user-space units, measured from the **bottom-left**, y-up |

Built at `build/pdf.worker.mjs:35778-35788`:

```js
    function getCurrentTextTransform() {
      const font = textState.font;
      const tsm = [textState.fontSize * textState.textHScale, 0, 0, textState.fontSize, 0, textState.textRise];
      ...
      return Util.transform(textState.ctm, Util.transform(textState.textMatrix, tsm));
    }
```

That is `Tm_full = CTM × Tm × [fontSize·Th, 0, 0, fontSize, 0, Trise]`. **The viewport is NOT in this product.** So:

- **Coordinate space = PDF user space** (unrotated, unscaled by `viewport.scale`, y-axis pointing **up**, origin at the page's `viewBox` origin). It is *not* device/CSS pixels, despite the JSDoc saying "device space" for `width`/`height` — those too are user-space magnitudes (`build/pdf.worker.mjs:35814-35821`: `height = Math.hypot(trm[2], trm[3])` for horizontal text, `width = Math.hypot(trm[0], trm[1])` for vertical).
- `[5]` sits on the **text baseline**, not the top of the box.

To get viewport/canvas pixels, left-multiply by `viewport.transform` — that is exactly what pdf.js's own text layer does, `build/pdf.mjs:15004`:

```js
    const tx = Util.transform(this.#transform, geom.transform);
    let angle = Math.atan2(tx[1], tx[0]);
    ...
    const fontHeight = Math.hypot(tx[2], tx[3]);
```

with (`build/pdf.mjs:14877`) `this.#transform = [1, 0, 0, -1, -pageX, pageY + pageHeight]` from `viewport.rawDims` — an unscaled flip, since the text layer scales via CSS. For a canvas overlay you want `viewport.transform` instead:

```ts
import { Util } from 'pdfjs-dist';
const tx = Util.transform(viewport.transform, item.transform as number[]);
const x = tx[4];                       // px from left
const yBaseline = tx[5];               // px from top (viewport.transform did the flip)
const fontHeightPx = Math.hypot(tx[2], tx[3]);
const angleRad = Math.atan2(tx[1], tx[0]);
const widthPx = item.width * viewport.scale;   // item.width is user-space
```

`Util.transform` (`build/pdf.mjs:546-548`) — row-vector convention, `m1 ∘ m2`:

```js
  static transform(m1, m2) {
    return [m1[0]*m2[0] + m1[2]*m2[1], m1[1]*m2[0] + m1[3]*m2[1],
            m1[0]*m2[2] + m1[2]*m2[3], m1[1]*m2[2] + m1[3]*m2[3],
            m1[0]*m2[4] + m1[2]*m2[5] + m1[4], m1[1]*m2[4] + m1[3]*m2[5] + m1[5]];
  }
```

To go the other way (canvas click → PDF point) use `viewport.convertToPdfPoint(x, y)`.

---

## 6. `getTextContent` options

`types/src/display/api.d.ts:275-286`:

```ts
export type getTextContentParameters = {
    /** - When true include marked content items in the items array of TextContent. Default `false`. */
    includeMarkedContent?: boolean | undefined;
    /** - When true the text is *not* normalized in the worker-thread. Default `false`. */
    disableNormalization?: boolean | undefined;
};
```

Only these two. (`keepWhiteSpace` exists in the worker's internal `getTextContent` at `build/pdf.worker.mjs:35681` but is **not** plumbed through the public API — `streamTextContent` forwards exactly two flags, `build/pdf.mjs`:)

```js
  streamTextContent({ includeMarkedContent = false, disableNormalization = false } = {}) {
    const TEXT_CONTENT_CHUNK_SIZE = 100;
    return this._transport.messageHandler.sendWithStream("GetTextContent", {
      pageId: ..., pageIndex: this._pageIndex,
      includeMarkedContent: includeMarkedContent === true,
      disableNormalization: disableNormalization === true
    }, { highWaterMark: TEXT_CONTENT_CHUNK_SIZE, size(textContent) { return textContent.items.length; } });
  }
```

### What `disableNormalization` actually changes

Default (`false`) runs `normalizeUnicode()` on each chunk's joined string before bidi — `build/pdf.mjs`:

```js
let NormalizeRegex = null;
let NormalizationMap = null;
function normalizeUnicode(str) {
  if (!NormalizeRegex) {
    NormalizeRegex = /([\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71\ufe77\ufe79\ufe7b\ufe7d]+)|(\ufb05+)/gu;
    NormalizationMap = new Map([["ﬅ", "ſt"]]);
  }
  return str.replaceAll(NormalizeRegex, (_, p1, p2) => p1 ? p1.normalize("NFKC") : NormalizationMap.get(p2));
}
```

So it NFKC-folds a targeted set: NBSP → space, micro sign → μ, Greek question mark → `;`, all the `U+2000–200A` spaces + narrow NBSP → plain space, Ohm sign → Ω, **Latin ligatures `ﬀ ﬁ ﬂ ﬃ ﬄ` → `ff fi fl ffi ffl`**, `ﬅ` → `ſt` (special-cased so NFKC doesn't turn it into `st`), and the large Arabic presentation-form / ligature blocks → their decomposed forms.

**`disableNormalization: true` gives you the raw code points, and character counts that match the PDF's glyph stream.**

For an editor this matters enormously: with normalization on, a single `ﬁ` glyph becomes 2 JS characters, so `str.length` no longer corresponds 1:1 to glyphs and any offset you compute against the original content stream drifts. **Use `disableNormalization: true` for edit/offset-mapping work; use the default (`false`) for search and copy/paste.** Note `bidi()` still runs either way, so `str` may still be visually reordered vs. the byte order in the PDF.

`includeMarkedContent: true` interleaves the `TextMarkedContent` sentinels (with `tag`) so you can recover `/MCID` → text mapping and tie items to `getStructTree()` nodes.

`getTextContent` accumulates the stream itself (`build/pdf.mjs`):

```js
  async getTextContent(params = {}) {
    if (this._transport._htmlForXfa) { return this.getXfa().then(xfa => XfaText.textContent(xfa)); }
    const readableStream = this.streamTextContent(params);
    const textContent = { items: [], styles: Object.create(null), lang: null };
    for await (const value of readableStream) {
      textContent.lang ??= value.lang;
      Object.assign(textContent.styles, value.styles);
      textContent.items.push(...value.items);
    }
    return textContent;
  }
```

Use `streamTextContent()` directly (chunks of ~100 items) for large pages if you want incremental processing.

---

## 7. `TextContent.styles` — shape and the real font name

`types/src/display/api.d.ts:361-378`:

```ts
export type TextStyle = {
    ascent: number;      // :365  Font ascent.
    descent: number;     // :369  Font descent.
    vertical: boolean;   // :373  Whether or not the text is in vertical mode.
    fontFamily: string;  // :377  The possible font family.
};
```

Indexed by `TextItem.fontName` — `styles: { [x: string]: TextStyle }`. `fontSubstitution` is **not** in the type; it is an untyped runtime addition. Construction, `build/pdf.worker.mjs:35798-35810`:

```js
      if (!seenStyles.has(loadedName)) {
        seenStyles.add(loadedName);
        textContent.styles[loadedName] = {
          fontFamily: font.fallbackName,
          ascent: font.ascent,
          descent: font.descent,
          vertical: font.vertical
        };
        if (self.options.fontExtraProperties && font.systemFontInfo) {
          const style = textContent.styles[loadedName];
          style.fontSubstitution = font.systemFontInfo.css;
          style.fontSubstitutionLoadedName = font.systemFontInfo.loadedName;
        }
      }
```

Two things follow, and both are traps:

**(a) `fontFamily` is NOT the real font family.** It is `font.fallbackName`, computed in the worker's `Font` constructor at `build/pdf.worker.mjs:26999-27007`:

```js
    const matches = name.match(/^InvalidPDFjsFont_(.*)_\d+$/);
    this.isInvalidPDFjsFont = !!matches;
    if (this.isInvalidPDFjsFont) {
      this.fallbackName = matches[1];
    } else if (this.isMonospace) {
      this.fallbackName = "monospace";
    } else if (this.isSerifFont) {
      this.fallbackName = "serif";
    } else {
      this.fallbackName = "sans-serif";
    }
```

**In practice `style.fontFamily` is almost always the literal string `"serif"`, `"sans-serif"`, or `"monospace"`.** Never treat it as a font name.

**(b) `fontName` is a synthetic id, not a name.** `TextItem.fontName` is `translated.loadedName`, generated at `build/pdf.worker.mjs:34906`:

```js
    font.loadedName = `${this.idFactory.getDocId()}_${fontID}`;
```

with (`build/pdf.worker.mjs:59609-59614`) `getDocId()` → `` `g_${pdfManager.docId}` `` and `createFontId()` → `` `f${++idCounters.font}` ``. So values look like **`g_d0_f1`**, **`g_d0_f2`**. The `g_` prefix is exactly the `commonObjs` sentinel (`build/pdf.mjs:10777`: `data.startsWith("g_") ? this.commonObjs.get(data) : this.objs.get(data)`).

### How to get the real embedded font name

Three routes, in order of directness:

1. **`page.commonObjs.get(item.fontName).name`** — the actual `/BaseFont` string, e.g. `"ABCDEF+Helvetica-Bold"`. Requires `render()`/`getOperatorList()` first (§8). This is the authoritative answer.
2. **`styles[fontName].fontSubstitution` / `.fontSubstitutionLoadedName`** — present only when `fontExtraProperties: true` **and** the font is non-embedded and got a system substitution. `fontSubstitution` is a ready-to-use CSS `font-family` value (`font.systemFontInfo.css`, with `,${fallbackName}` appended by `build/pdf.worker.mjs:27009-27012`). Nothing for embedded fonts.
3. `getOperatorList()` → scan `OPS.setFont` (37) args, whose `argsArray[i][0]` is the `loadedName`, correlating back to the resource-dictionary key.

pdf.js's own text layer only uses (2) and only under the font inspector (`build/pdf.mjs:15010`, `:15032`):

```js
    let fontFamily = this.#fontInspectorEnabled && style.fontSubstitution || style.fontFamily;
    ...
      textDiv.dataset.fontName = style.fontSubstitutionLoadedName || geom.fontName;
```

Also note `ascent`/`descent` are normalized fractions of em (used as `fontHeight * ascent` at `build/pdf.mjs:15013`), not absolute units.

---

## 8. `page.commonObjs.get(fontName)` — yes, with caveats

`types/src/display/pdf_objects.d.ts:6-39`:

```ts
export class PDFObjects {
    get(objId: string, callback?: Function): any;   // :19
    has(objId: string): boolean;                    // :24
    delete(objId: string): boolean;                 // :29
    resolve(objId: string, data?: any): void;       // :36
    clear(): void;
    [Symbol.iterator](): Generator<any[], void, unknown>;
}
```

Implementation, `build/pdf.mjs`:

```js
class PDFObjects {
  #objs = new Map();
  get(objId, callback = null) {
    if (callback) {
      const obj = this.#objs.getOrInsertComputed(objId, dataObj);
      obj.promise.then(() => callback(obj.data));
      return null;
    }
    const obj = this.#objs.get(objId);
    if (!obj || obj.data === INITIAL_DATA) {
      throw new Error(`Requesting object that isn't resolved yet ${objId}.`);
    }
    return obj.data;
  }
```

**Synchronous `get(id)` throws if unresolved.** Use `commonObjs.has(id)` first, or the callback form (which resolves whenever the worker delivers).

### Caveat 1 — `getTextContent` alone never populates it

The `commonobj`/`Font` message is only sent from `TranslatedFont.send()` (`build/pdf.worker.mjs:37406`), and the **only** call site is `PartialEvaluator.handleSetFont` on the operator-list path (`build/pdf.worker.mjs:34699`):

```js
  async handleSetFont(resources, fontArgs, fontRef, operatorList, task, state, ...) {
    const fontName = fontArgs?.[0] instanceof Name ? fontArgs[0].name : null;
    const translated = await this.loadFont(fontName, fontRef, resources, task, fallbackFontDict, cssFontInfo, seenRefs);
    if (translated.font.isType3Font) { operatorList.addDependencies(translated.type3Dependencies); }
    state.font = translated.font;
    translated.send(this.handler);
    return translated.loadedName;
  }
```

The text-content path uses a *different, local* `handleSetFont` (`build/pdf.worker.mjs:35872-35878`) that only sets `textState.loadedName`/`font` and **never calls `send`**. So:

> **You must call `page.render(...)` or `page.getOperatorList(...)` and await it before `commonObjs.get(item.fontName)` will resolve.**

Cheapest primer: `await page.getOperatorList()`.

### Caveat 2 — resolution is async even after that

`build/pdf.mjs:16490-16499` (transport's `"commonobj"` handler):

```js
        case "Font":
          if ("error" in exportedData) { ... this.commonObjs.resolve(id, exportedError); break; }
          const fontData = new FontInfo(exportedData);
          const inspectFont = ...;
          const font = new FontFaceObject(fontData, inspectFont, exportedData.charProcOperatorList, exportedData.extra);
          this.fontLoader.bind(font).catch(() => messageHandler.sendWithPromise("FontFallback", { id }))
            .finally(() => {
              if (!font.fontExtraProperties) { font.clearData(); }
              this.commonObjs.resolve(id, font);
            });
          break;
```

Resolution waits on `fontLoader.bind()` (the FontFace API). Prefer:

```ts
const font = await new Promise<any>(res => page.commonObjs.get(item.fontName, res));
```

### Caveat 3 — `.data` is destroyed unless `fontExtraProperties: true`

That `.finally()` calls `font.clearData()` when `fontExtraProperties` is false, and `FontInfo.clearData()` truncates the buffer:

```js
  clearData() {
    const { offset, length } = this.#getDataOffsets();
    if (length === 0) { return; }
    this.#view.setUint32(offset, 0);
    this.#buffer = new Uint8Array(this.#buffer, 0, offset + 4).slice().buffer;
    this.#view = new DataView(this.#buffer);
  }
```

**If you want the actual font bytes (e.g. to feed `@pdf-lib/fontkit`), you must pass `fontExtraProperties: true` to `getDocument`.**

### What it returns: a `FontFaceObject`

`build/pdf.mjs` (`class FontFaceObject`), a thin façade over a binary-encoded `FontInfo`. Complete accessor surface:

| Member | Type | Meaning |
|---|---|---|
| `name` | `string` | **The real embedded/base font name** — the PDF `/BaseFont`, e.g. `ABCDEF+Helvetica-Bold` |
| `loadedName` | `string` | the `g_d0_fN` id (round-trips to `TextItem.fontName`) |
| `fallbackName` | `string` | `"serif"` / `"sans-serif"` / `"monospace"` — what `TextStyle.fontFamily` holds |
| `data` | `Uint8Array \| undefined` | the converted OpenType/CFF/TrueType bytes; `undefined` unless `fontExtraProperties: true` |
| `mimetype` | `string` | e.g. `font/opentype` |
| `ascent`, `descent`, `defaultWidth` | `number` | Float64 |
| `bbox` | `[number×4] \| undefined` | Int16 font bbox |
| `fontMatrix` | `[number×6] \| undefined` | Float64 |
| `defaultVMetrics` | `[number×3] \| undefined` | |
| `black`, `bold`, `italic`, `vertical`, `isType3Font`, `missingFile`, `remeasure`, `isInvalidPDFjsFont`, `disableFontFace`, `fontExtraProperties` | `boolean \| undefined` | tri-state bit-packed (`undefined` means "not set") |
| `cssFontInfo` | `CssFontInfo \| null` | `.fontFamily`, `.fontWeight`, `.italicAngle` |
| `systemFontInfo` | `SystemFontInfo \| null` | `.css`, `.loadedName`, `.baseFontName`, `.src`, `.guessFallback`, `.style → {style, weight}` |
| `compiledGlyphs` | `object` | glyph-path cache |
| `charProcOperatorList` | present for Type3 |
| `createNativeFontFace()` | `FontFace \| null` | |
| `createFontFaceRule()` | `string \| null` | `@font-face { … src: url(data:…;base64,…) }` |
| `getPathGenerator(objs, character)` | `Path2D` | glyph outlines; needs `page.objs` |
| `clearData()` | | drops the byte payload |

Field layout is declared at `build/pdf.mjs` (`class FONT_INFO`), which is the authoritative list of what survives the worker boundary:

```js
class FONT_INFO {
  static bools = ["black", "bold", "disableFontFace", "fontExtraProperties", "isInvalidPDFjsFont",
                  "isType3Font", "italic", "missingFile", "remeasure", "vertical"];
  static numbers = ["ascent", "defaultWidth", "descent"];
  static strings = ["fallbackName", "loadedName", "mimetype", "name"];
  ...
}
```

Note there is **no `psName`, `type`, `subtype`, `isSerifFont`, `isSymbolicFont`, `isMonospace`, `widths`, `differences`, or `composite`** on the main-thread object in v6 — those stay in the worker. `name` is your only handle on the true font identity.

Error case: on font-load failure the worker resolves the id with a **string** (the error message), not a `FontFaceObject` (`build/pdf.mjs:16491-16495`). Guard with `typeof font === 'string'`.

Practical recipe:

```ts
const doc = await getDocument({ data, fontExtraProperties: true, /* …urls… */ }).promise;
const page = await doc.getPage(n);
await page.getOperatorList();                       // primes commonObjs
const tc = await page.getTextContent({ disableNormalization: true });
const item = tc.items[0] as TextItem;
const font = await new Promise<any>(res => page.commonObjs.get(item.fontName, res));
if (typeof font !== 'string') {
  console.log(font.name, font.mimetype, font.data?.byteLength, font.ascent, font.descent);
}
```

---

## Gotchas worth writing down

1. **`isEvalSupported` no longer exists** — passing it is a silent no-op, and any code carried over from v3/v4 that relied on it needs deleting.
2. **`canvas` is a required `RenderParameters` field**; `canvasContext` is optional and *ignored* unless `canvas: null`.
3. **Import values only from bare `'pdfjs-dist'`** — `build/pdf.mjs` has no `.d.mts`.
4. **Detail types live at `'pdfjs-dist/types/src/display/api'`** — the barrel re-exports only 6 type aliases.
5. `data: Uint8Array` is **transferred** (neutered). Copy before handing off if pdf-lib needs the same bytes.
6. `cMapUrl`/`standardFontDataUrl`/`wasmUrl` **must end in `/`** or `getDocument` throws synchronously.
7. **`useWorkerFetch` needs all three URLs incl. `wasmUrl`**, else it silently degrades to main-thread fetching.
8. Vite cannot resolve directory `new URL()` — copy `cmaps/`, `standard_fonts/`, `wasm/` into `public/`.
9. `TextStyle.fontFamily` is a generic fallback keyword, and `TextItem.fontName` is `g_d0_fN`. Neither is a font name.
10. `TextItem.transform` is **PDF user space, y-up, baseline origin, viewport-independent**. `Util.transform(viewport.transform, item.transform)` to reach canvas px.
11. `commonObjs` is empty until `render()`/`getOperatorList()`; sync `get()` throws when unresolved; font `.data` needs `fontExtraProperties: true`.
12. `page.render()` on a canvas already in flight throws — `cancel()` the prior `RenderTask` first.
13. `disableNormalization: true` for anything offset-sensitive; ligature folding otherwise breaks `str.length` ↔ glyph correspondence.
14. `PDFWorker` throws if two instances share one port — hoist a single `PDFWorker` and pass it as `src.worker`.

Package version constants (`build/pdf.mjs`): `const version = "6.2.108"; const build = "0365cbde0";`