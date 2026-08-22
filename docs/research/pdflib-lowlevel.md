# pdf-lib 1.17.1 — Content Stream Surgery Reference

Base path (all paths below are relative to it):
`/Volumes/Crucial X9/Project/prince981620/pdfeditor/node_modules/pdf-lib/`

**Packaging (verified `package.json`)**: `main: cjs/index.js`, `module: es/index.js`, `types: cjs/index.d.ts`, `files: ["cjs/","dist/","es/","src/","ts3.4",...]`. **There is NO `exports` map** → deep imports like `pdf-lib/cjs/core/streams/decode` and `pdf-lib/es/core/structures/PDFPageLeaf` are fully allowed. Verified at runtime: `require('pdf-lib/cjs/core/streams/decode').decodePDFRawStream` → `function`.

**But you almost never need deep imports.** `cjs/index.d.ts` is:
```ts
export * from "./api/index";   // 1
export * from "./core/index";  // 2
export * from "./types/index"; // 3
export * from "./utils/index"; // 4
```
Runtime-verified as top-level named exports of `'pdf-lib'`: `decodePDFRawStream, PDFRawStream, PDFStream, PDFPageLeaf, PDFContentStream, PDFFlateStream, PDFOperator, PDFOperatorNames, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFHexString, PDFContext, PDFObjectCopier, PDFWriter, PDFStreamWriter, StandardFontEmbedder, CustomFontEmbedder, StandardFonts, ParseSpeeds, EncryptedPDFError, typedArrayFor, arrayAsString, mergeIntoTypedArray, toUint8Array, Cache, breakTextIntoLines, drawText, drawLinesOfText, pushGraphicsState, showText, setFontAndSize`.

Only things genuinely *not* exported (need deep import): `core/streams/Stream` (the `StreamType` interface + `Stream` class), `core/streams/DecodeStream`/`FlateStream`/`LZWStream`/…, `core/parser/ByteStream`, `core/parser/BaseParser`, `core/syntax/*` except `CharCodes`.

---

## 1. `PDFDocument.load(bytes, options)`

`cjs/api/PDFDocument.d.ts:68`
```ts
static load(pdf: string | Uint8Array | ArrayBuffer, options?: LoadOptions): Promise<PDFDocument>;
```
`cjs/api/PDFDocumentOptions.d.ts:20-26`
```ts
export interface LoadOptions {
    ignoreEncryption?: boolean;
    parseSpeed?: ParseSpeeds | number;
    throwOnInvalidObject?: boolean;
    updateMetadata?: boolean;
    capNumbers?: boolean;
}
```
`cjs/api/PDFDocumentOptions.d.ts:3-8`
```ts
export declare enum ParseSpeeds { Fastest = Infinity, Fast = 1500, Medium = 500, Slow = 100 }
```

**Defaults, read off `cjs/api/PDFDocument.js:121`:**
```js
ignoreEncryption = false, parseSpeed = ParseSpeeds.Slow /* 100 */,
throwOnInvalidObject = false, updateMetadata = true, capNumbers = false
```
Implementation `cjs/api/PDFDocument.js:126-130`:
```js
bytes = toUint8Array(pdf);
context = await PDFParser.forBytesWithOptions(bytes, parseSpeed, throwOnInvalidObject, capNumbers).parseDocument();
return new PDFDocument(context, ignoreEncryption, updateMetadata);
```

Semantics:
- **`parseSpeed`** is `objectsPerTick` — how many indirect objects the parser handles before `await waitForTick()`. `Infinity` = never yield (fastest, blocks the loop). Purely a scheduling knob; no effect on output.
- **`throwOnInvalidObject`** — `cjs/core/parser/PDFParser.js:164,181`: when an indirect object fails to parse, default behavior wraps its raw bytes in a `PDFInvalidObject` (`PDFParser.js:183`, bytes preserved verbatim); with `true` it throws `PDFInvalidObjectParsingError`.
- **`capNumbers`** — `cjs/core/parser/BaseParser.js:55-63`: if a parsed number `> Number.MAX_SAFE_INTEGER`, with `true` it `console.warn`s and substitutes `Number.MAX_SAFE_INTEGER`; with `false` (default) it only `console.warn`s and keeps the oversized value.
- **`updateMetadata`** — `PDFDocument.js:59-60` → `updateInfoDict()` at `PDFDocument.js:1335-1345`: unconditionally sets `/Producer = "pdf-lib (https://github.com/Hopding/pdf-lib)"` and `/ModDate = now`, and sets `/Creator` + `/CreationDate` only if absent. **Pass `updateMetadata: false` for byte-faithful surgery.**

**Encrypted PDFs** — `cjs/api/PDFDocument.js:48,57-58`:
```js
this.isEncrypted = !!context.lookup(context.trailerInfo.Encrypt);
if (!ignoreEncryption && this.isEncrypted) throw new EncryptedPDFError();
```
`EncryptedPDFError` is declared at `cjs/api/errors.d.ts:1`. **`ignoreEncryption: true` only suppresses the throw — pdf-lib has NO decryption support at all.** Streams stay as raw encrypted bytes, `decodePDFRawStream` will produce garbage (or throw `UnsupportedEncodingError`), and on save the `/Encrypt` ref is copied straight into the new trailer (`cjs/core/writers/PDFWriter.js:95`) while nothing is re-encrypted → the output file is broken. Public flag: `readonly isEncrypted: boolean` (`PDFDocument.d.ts:79`).

Other relevant public members: `readonly context: PDFContext` (`.d.ts:75`), `readonly catalog: PDFCatalog` (`.d.ts:77`), `getPages(): PDFPage[]` (`.d.ts:315`).

---

## 2. Reaching the low-level page dict — `PDFPageLeaf`

`cjs/api/PDFPage.d.ts:24,36-40`
```ts
static of: (leafNode: PDFPageLeaf, ref: PDFRef, doc: PDFDocument) => PDFPage;
readonly node: PDFPageLeaf;
readonly ref: PDFRef;
readonly doc: PDFDocument;
```
So: `const leaf = doc.getPages()[i].node`.

**Full `PDFPageLeaf` API** — `cjs/core/structures/PDFPageLeaf.d.ts:10-53` (`extends PDFDict`, so every `PDFDict` method is available too):
```ts
declare class PDFPageLeaf extends PDFDict {
    static readonly InheritableEntries: string[];          // ['Resources','MediaBox','CropBox','Rotate']
    static withContextAndParent: (context: PDFContext, parent: PDFRef) => PDFPageLeaf;
    static fromMapWithContext: (map: DictMap, context: PDFContext, autoNormalizeCTM?: boolean) => PDFPageLeaf;
    private normalized; private readonly autoNormalizeCTM; private constructor();
    clone(context?: PDFContext): PDFPageLeaf;
    Parent(): PDFPageTree | undefined;
    Contents(): PDFStream | PDFArray | undefined;
    Annots(): PDFArray | undefined;
    BleedBox(): PDFArray | undefined;
    TrimBox(): PDFArray | undefined;
    ArtBox(): PDFArray | undefined;
    Resources(): PDFDict | undefined;
    MediaBox(): PDFArray;
    CropBox(): PDFArray | undefined;
    Rotate(): PDFNumber | undefined;
    getInheritableAttribute(name: PDFName): PDFObject | undefined;
    setParent(parentRef: PDFRef): void;
    addContentStream(contentStreamRef: PDFRef): void;
    wrapContentStreams(startStream: PDFRef, endStream: PDFRef): boolean;
    addAnnot(annotRef: PDFRef): void;
    removeAnnot(annotRef: PDFRef): void;
    setFontDictionary(name: PDFName, fontDictRef: PDFRef): void;
    newFontDictionaryKey(tag: string): PDFName;
    newFontDictionary(tag: string, fontDictRef: PDFRef): PDFName;
    setXObject(name: PDFName, xObjectRef: PDFRef): void;
    newXObjectKey(tag: string): PDFName;
    newXObject(tag: string, xObjectRef: PDFRef): PDFName;
    setExtGState(name: PDFName, extGStateRef: PDFRef | PDFDict): void;
    newExtGStateKey(tag: string): PDFName;
    newExtGState(tag: string, extGStateRef: PDFRef | PDFDict): PDFName;
    ascend(visitor: (node: PDFPageTree | PDFPageLeaf) => any): void;
    normalize(): void;
    normalizedEntries(): {
        Annots: PDFArray; Resources: PDFDict; Contents: PDFArray | undefined;
        Font: PDFDict; XObject: PDFDict; ExtGState: PDFDict;
    };
}
```

Key implementation facts (`cjs/core/structures/PDFPageLeaf.js`):
- **`Contents()` :30-32** — `return this.lookup(PDFName.of('Contents'))`. Untyped `lookup`, so it resolves the ref but returns whatever is there. Declared type is a *lie by omission*: it can be `PDFRawStream`, `PDFContentStream`, `PDFArray`, or `undefined`.
- **`Resources()` :45-48** — walks the inheritance chain via `getInheritableAttribute` then `context.lookupMaybe(dictOrRef, PDFDict)`. **The returned dict may belong to the parent `Pages` node and be shared by every page.**
- **`ascend(visitor)` :136-141** — visits `this`, then recurses through `Parent()`. Post-order-ish: self first, then up the tree.
- **`getInheritableAttribute(name)` :61-68** — `ascend`s and returns the first `node.get(name)` found.
- **`normalize()` :142-170** — see §9, this is the big landmine.
- **`normalizedEntries()` :171-184** — calls `normalize()` first, then returns the six entries.

---

## 3. Decoding a page's content stream to raw bytes

**Verified to exist and be exported:**

| Symbol | Location | Reality |
|---|---|---|
| `decodePDFRawStream` | `cjs/core/streams/decode.d.ts:3` | **Exported top-level** from `'pdf-lib'` (re-exported at `cjs/core/index.d.ts:45`). |
| `PDFRawStream.getContents()` | `cjs/core/objects/PDFRawStream.d.ts:12` | Exists, but returns the **still-encoded** bytes (`PDFRawStream.js:22-24`: `return this.contents`). **NOT the decoded content stream.** |
| `PDFStream.getContentsString()` | `cjs/core/objects/PDFStream.d.ts:8` | Exists; on `PDFRawStream` it is `arrayAsString(this.contents)` (`PDFRawStream.js:19-21`) — i.e. the *compressed* bytes as a latin1 string. Useless for reading page content. |
| `PDFFlateStream.getUnencodedContents()` | `cjs/core/structures/PDFFlateStream.d.ts:11` | Throws `MethodNotImplementedError` on the base (`PDFFlateStream.js:29-31`); implemented on `PDFContentStream` (`PDFContentStream.js:37-45`). |

Exact signature, `cjs/core/streams/decode.d.ts:1-3`:
```ts
import PDFRawStream from "../objects/PDFRawStream";
import { StreamType } from "./Stream";
export declare const decodePDFRawStream: ({ dict, contents }: PDFRawStream) => StreamType;
```
`StreamType` (`cjs/core/streams/Stream.d.ts:1-13`) — the member you want is `decode(): Uint8Array`.

`decode.js:41-57` reads `dict./Filter` and `dict./DecodeParms`, supports `FlateDecode`, `LZWDecode` (honouring `/EarlyChange`), `ASCII85Decode`, `ASCIIHexDecode`, `RunLengthDecode`, chains a `PDFArray` of filters, throws `UnsupportedEncodingError` otherwise, and returns the raw `Stream` unchanged when there is no `/Filter`.

**The canonical decode pattern is pdf-lib's own**, `cjs/core/embedders/PDFPageEmbedder.js:69-86`:
```js
PDFPageEmbedder.prototype.decodeContents = function (contents /* PDFArray */) {
    var newline = Uint8Array.of(CharCodes.Newline);
    var decodedContents = [];
    for (var idx = 0, len = contents.size(); idx < len; idx++) {
        var stream = contents.lookup(idx, PDFStream);
        var content;
        if (stream instanceof PDFRawStream)          content = decodePDFRawStream(stream).decode();
        else if (stream instanceof PDFContentStream) content = stream.getUnencodedContents();
        else throw new UnrecognizedStreamTypeError(stream);
        decodedContents.push(content, newline);
    }
    return mergeIntoTypedArray.apply(void 0, decodedContents);
};
```

Handle both `Contents()` shapes yourself (do **not** call `normalizedEntries()` just to force the array form — see §9):
```ts
import { PDFArray, PDFStream, PDFRawStream, PDFContentStream, decodePDFRawStream, mergeIntoTypedArray } from 'pdf-lib';

const decodeOne = (s: PDFStream): Uint8Array =>
  s instanceof PDFRawStream     ? decodePDFRawStream(s).decode()
: s instanceof PDFContentStream ? s.getUnencodedContents()
: (() => { throw new Error('unrecognized stream'); })();

function readPageContent(leaf: PDFPageLeaf): Uint8Array {
  const c = leaf.Contents();
  if (!c) return new Uint8Array(0);
  if (c instanceof PDFArray) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < c.size(); i++) { parts.push(decodeOne(c.lookup(i, PDFStream)), Uint8Array.of(0x0a)); }
    return mergeIntoTypedArray(...parts);   // exported top-level
  }
  return decodeOne(c as PDFStream);
}
```
Empirically verified round-tripping a real file: `Contents` came back as `PDFArray size=1` on a pdf-lib-produced doc and as `PDFRawStream` after replacement — both handled.

Deep-import form if you want it (works, no exports map): `import { decodePDFRawStream } from 'pdf-lib/cjs/core/streams/decode'` / `'pdf-lib/es/core/streams/decode'`.

---

## 4. Creating a new content stream and replacing `/Contents`

`cjs/core/PDFContext.d.ts:41-42,75-78`
```ts
nextRef(): PDFRef;
register(object: PDFObject): PDFRef;
assign(ref: PDFRef, object: PDFObject): void;
stream(contents: string | Uint8Array, dict?: LiteralObject): PDFRawStream;
flateStream(contents: string | Uint8Array, dict?: LiteralObject): PDFRawStream;
contentStream(operators: PDFOperator[], dict?: LiteralObject): PDFContentStream;
formXObject(operators: PDFOperator[], dict?: LiteralObject): PDFContentStream;
```
Implementations, `cjs/core/PDFContext.js:145-156`:
```js
stream(contents, dict = {})      { return PDFRawStream.of(this.obj(dict), typedArrayFor(contents)); }
flateStream(contents, dict = {}) { return this.stream(pako.deflate(typedArrayFor(contents)), {...dict, Filter: 'FlateDecode'}); }
contentStream(operators, dict={}){ return PDFContentStream.of(this.obj(dict), operators); }
register(object)                 { var ref = this.nextRef(); this.assign(ref, object); return ref; }
```

**Do you have to set a `/Filter`?** No.
- `flateStream()` sets `Filter: 'FlateDecode'` **for you** — do not add it yourself.
- `stream()` sets **nothing**; the bytes are written literally, which is a perfectly valid uncompressed content stream. Verified end-to-end: `context.stream('q 1 0 0 RG 5 w 10 10 m 290 290 l S Q')` → save → reload → decoded back byte-identical.
- **You never set `/Length`.** `PDFStream.copyBytesInto` calls `updateDict()` (`cjs/core/objects/PDFStream.js:44-47`), and `updateDict` (`PDFStream.js:28-31`) sets `/Length` to `getContentsSize()` at serialization time. Verified: after surgery + reload, `/Length 89 /Filter /FlateDecode` was present and correct.

The replacement itself:
```ts
import { PDFName } from 'pdf-lib';
const stream = doc.context.flateStream(newBytes);          // Uint8Array or latin1 string
const ref    = doc.context.register(stream);               // PDFRef
page.node.set(PDFName.of('Contents'), ref);                // PDFDict.set(key: PDFName, value: PDFObject)
```
`PDFName.Contents` is a pre-interned constant (`cjs/core/objects/PDFName.d.ts:10`) — `PDFName.of('Contents') === PDFName.Contents` because names are pooled (`PDFName.js:18` `var pool = new Map()`).

**Verified working end-to-end** (create → save → load → decode → string-replace `<48656C6C6F>`→`<576F726C64>` → `flateStream` → `register` → `set(Contents)` → `save()` → reload → decode): the reloaded page's content stream contained the edited bytes, with the original `/Helvetica-7098480789` font resource untouched.

Notes:
- `context.stream(string)` uses `typedArrayFor` (`cjs/utils/arrays.js`), which is `charCodeAt` per char — **latin1 only, chars > 0xFF are silently truncated.** For binary-safe content pass a `Uint8Array` (or a `Buffer` read as `'latin1'`).
- Prefer setting a `PDFRef` (indirect) rather than the stream object directly — `/Contents` must be an indirect reference per spec, and `PDFRawStream` cannot be written inline anyway.
- Orphaning: the old content stream object stays in `context.indirectObjects` and will still be written unless you `doc.context.delete(oldRef)`. `PDFContext.delete(ref): boolean` (`PDFContext.d.ts:43`).

---

## 5. `pushOperators` / `drawText` internals, and font registration in Resources

`cjs/api/PDFPage.d.ts:658,696,480`
```ts
pushOperators(...operator: PDFOperator[]): void;
drawText(text: string, options?: PDFPageDrawTextOptions): void;
setFont(font: PDFFont): void;
```

`cjs/api/PDFPage.js:786-793`:
```js
PDFPage.prototype.pushOperators = function () {
    assertEachIs(operator, 'operator', [[PDFOperator, 'PDFOperator']]);
    var contentStream = this.getContentStream();
    contentStream.push.apply(contentStream, operator);
};
```

`cjs/api/PDFPage.js:1359-1375` (private):
```js
PDFPage.prototype.getContentStream = function (useExisting = true) {
    if (useExisting && this.contentStream) return this.contentStream;
    this.contentStream    = this.createContentStream();
    this.contentStreamRef = this.doc.context.register(this.contentStream);
    this.node.addContentStream(this.contentStreamRef);      // <-- triggers normalize()
    return this.contentStream;
};
PDFPage.prototype.createContentStream = function (...operators) {
    var dict = this.doc.context.obj({});
    return PDFContentStream.of(dict, operators);            // encode=true -> Filter: FlateDecode
};
```
So pdf-lib **never** rewrites the existing stream; it *appends a new `PDFContentStream`* to the `/Contents` array via `PDFPageLeaf.addContentStream` (`PDFPageLeaf.js:72-76`).

**Operators emitted by `drawText`** — `PDFPage.js:832-869` calls `drawLinesOfText`, `cjs/api/operations.js`:
```js
exports.drawLinesOfText = function (lines, options) {
    var operators = [
        pushGraphicsState(),                                        // q
        options.graphicsState && setGraphicsState(options.graphicsState),  // /GS0 gs
        beginText(),                                                // BT
        setFillingColor(options.color),                             // r g b rg  (or g / k)
        setFontAndSize(options.font, options.size),                 // /F1 12 Tf
        setLineHeight(options.lineHeight),                          // 12 TL
        rotateAndSkewTextRadiansAndTranslate(...),                  // a b c d e f Tm
    ].filter(Boolean);
    for (var idx = 0; idx < lines.length; idx++)
        operators.push(showText(lines[idx]), nextLine());           // <hex> Tj  /  T*
    operators.push(endText(), popGraphicsState());                  // ET / Q
    return operators;
};
```
Verified by decoding a real generated page — exactly:
```
q
BT
0 0 0 rg
/Helvetica-7098480789 24 Tf
24 TL
1 0 0 1 20 100 Tm
<48656C6C6F> Tj
T*
ET
Q
```
Signatures: `cjs/api/operations.d.ts:16,20`
```ts
export declare const drawText: (line: PDFHexString, options: DrawTextOptions) => PDFOperator[];
export declare const drawLinesOfText: (lines: PDFHexString[], options: DrawLinesOfTextOptions) => PDFOperator[];
interface DrawTextOptions { color: Color; font: string | PDFName; size: number | PDFNumber;
  rotate: Rotation; xSkew: Rotation; ySkew: Rotation; x: number|PDFNumber; y: number|PDFNumber;
  graphicsState?: string | PDFName; }
interface DrawLinesOfTextOptions extends DrawTextOptions { lineHeight: number | PDFNumber; }
```
`PDFOperator.of(name: PDFOperatorNames, args?: PDFOperatorArg[])` — `cjs/core/operators/PDFOperator.d.ts:10`, with `PDFOperatorArg = string | PDFName | PDFArray | PDFNumber | PDFString | PDFHexString` (`:8`). Full operator-name enum at `cjs/core/operators/PDFOperatorNames.d.ts:1-75` (`Tf="Tf"`, `Tj="Tj"`, `TJ="TJ"`, `Tm="Tm"`, `BT/ET`, `q/Q`, `cm`, `gs`, `Do`, `re`, `rg`, …).

**There is no `getFontDictOrRef`.** The real font-registration path is:

`cjs/api/PDFPage.js:574-579`
```js
PDFPage.prototype.setFont = function (font) {
    this.font    = font;
    this.fontKey = this.node.newFontDictionary(this.font.name, this.font.ref);
};
```
`cjs/core/structures/PDFPageLeaf.js:97-109` — **the exact methods for adding a font to Resources**:
```js
setFontDictionary(name /*PDFName*/, fontDictRef /*PDFRef*/) { this.normalizedEntries().Font.set(name, fontDictRef); }
newFontDictionaryKey(tag /*string*/)  { return this.normalizedEntries().Font.uniqueKey(tag); }
newFontDictionary(tag, fontDictRef)   { const key = this.newFontDictionaryKey(tag); this.setFontDictionary(key, fontDictRef); return key; }
```
`uniqueKey` (`cjs/core/objects/PDFDict.js`) = `PDFName.of(context.addRandomSuffix(tag, 10))` — hence names like `/Helvetica-7098480789` (`PDFContext.js:193-195`: `prefix + "-" + Math.floor(rng.nextInt() * 10**suffixLength)`).

⚠️ **All three call `normalizedEntries()` → `normalize()`.** For surgery, register the font in Resources manually to avoid that (see §9):
```ts
import { PDFName, PDFDict } from 'pdf-lib';
let res = page.node.Resources();
if (!res) { res = doc.context.obj({}); page.node.set(PDFName.Resources, res); }
let fonts = res.lookupMaybe(PDFName.Font, PDFDict);
if (!fonts) { fonts = doc.context.obj({}); res.set(PDFName.Font, fonts); }
fonts.set(PDFName.of('F1'), font.ref);
```
(Caveat: if `Resources` was inherited from the parent `Pages` node, this mutates the shared dict — clone it onto the page first if that matters.)

Also worth knowing: `maybeEmbedGraphicsState` (`PDFPage.js` private) builds `{Type:'ExtGState', ca, CA, BM}` and calls `node.newExtGState('GS', …)`, and `translateContent`/`scaleContent` (`PDFPage.js:445-455,494-504`) call `node.normalize()` then `node.wrapContentStreams(startRef, endRef)`.

---

## 6. Font embedding

`cjs/api/PDFDocument.d.ts:111,569`
```ts
registerFontkit(fontkit: Fontkit): void;
embedFont(font: StandardFonts | string | Uint8Array | ArrayBuffer, options?: EmbedFontOptions): Promise<PDFFont>;
embedStandardFont(font: StandardFonts, customName?: string): PDFFont;   // synchronous
```
`cjs/api/PDFDocumentOptions.d.ts:30-34`
```ts
export interface EmbedFontOptions { subset?: boolean; customName?: string; features?: TypeFeatures; }
```
`registerFontkit` is just `this.fontkit = fontkit` (`PDFDocument.js:172-174`); `assertFontkit()` (`PDFDocument.js:1377-1381`) throws `FontkitNotRegisteredError` (`cjs/api/errors.d.ts:4`) if a custom font is embedded without it. `@pdf-lib/fontkit` is a **devDependency here — it is NOT installed as a dependency of pdf-lib.** You must add it to your own project to use custom fonts.

`embedFont` dispatch, `cjs/api/PDFDocument.js:861-885`:
```js
if (isStandardFont(font))            embedder = StandardFontEmbedder.for(font, customName);
else if (canBeConvertedToUint8Array(font)) {
    bytes = toUint8Array(font); fontkit = this.assertFontkit();
    embedder = subset ? await CustomFontSubsetEmbedder.for(fontkit, bytes, customName, features)
                      : await CustomFontEmbedder.for(fontkit, bytes, customName, features);
} else throw new TypeError('`font` must be one of `StandardFonts | string | Uint8Array | ArrayBuffer`');
ref = this.context.nextRef();                 // ref reserved NOW, object assigned later at flush()
pdfFont = PDFFont.of(ref, this, embedder);
this.fonts.push(pdfFont);
return pdfFont;
```

`StandardFonts` enum — `cjs/api/StandardFonts.d.ts:1-16`, exact string values:
`Courier="Courier"`, `CourierBold="Courier-Bold"`, `CourierOblique="Courier-Oblique"`, `CourierBoldOblique="Courier-BoldOblique"`, `Helvetica="Helvetica"`, `HelveticaBold="Helvetica-Bold"`, `HelveticaOblique="Helvetica-Oblique"`, `HelveticaBoldOblique="Helvetica-BoldOblique"`, `TimesRoman="Times-Roman"`, `TimesRomanBold="Times-Bold"`, `TimesRomanItalic="Times-Italic"`, `TimesRomanBoldItalic="Times-BoldItalic"`, `Symbol="Symbol"`, `ZapfDingbats="ZapfDingbats"`.

**`PDFFont` API** — `cjs/api/PDFFont.d.ts:21-93`
```ts
static of: (ref: PDFRef, doc: PDFDocument, embedder: FontEmbedder) => PDFFont;
readonly ref: PDFRef;          // :23
readonly doc: PDFDocument;     // :25
readonly name: string;         // :27  == embedder.fontName
private modified;              // :28
private readonly embedder;     // :29  -> FontEmbedder = CustomFontEmbedder | StandardFontEmbedder (:4)
encodeText(text: string): PDFHexString;                                     // :41
widthOfTextAtSize(text: string, size: number): number;                      // :53
heightAtSize(size: number, options?: { descender?: boolean }): number;      // :67
sizeAtHeight(height: number): number;                                       // :78
getCharacterSet(): number[];                                                // :83
embed(): Promise<void>;                                                     // :93
```
`embedder` is `private` in TS but **present at runtime** — `(font as any).embedder` gives you `StandardFontEmbedder`/`CustomFontEmbedder`, which is how you reach `.encoding`, `.font`, `.glyphId()`, `.embedIntoContext()`.

Delegations (`cjs/api/PDFFont.js`): `heightAtSize` → `embedder.heightOfFontAtSize(size, {descender: options?.descender ?? true})` (`:68-75`); `sizeAtHeight` → `embedder.sizeOfFontAtHeight(height)` (`:84-87`); `embed()` (`:109-124`) only re-embeds `if (this.modified)`, then clears the flag. **`encodeText` sets `this.modified = true`** (`PDFFont.js:36`).

### `encodeText` — what it returns and how it differs

Always returns a **`PDFHexString`** (i.e. serializes as `<AABBCC>`), never a literal string.

**Standard fonts** — `cjs/core/embedders/StandardFontEmbedder.js:27-34` + `:83-90`:
```js
encodeText(text) {
    var glyphs = this.encodeTextAsGlyphs(text);            // Array<{code,name}>
    var hexCodes = glyphs.map(g => toHexString(g.code));   // 1 byte -> 2 hex digits
    return PDFHexString.of(hexCodes.join(''));
}
encodeTextAsGlyphs(text) {
    return Array.from(text).map(ch => this.encoding.encodeUnicodeCodePoint(toCodePoint(ch)));
}
```
Encoding chosen at `StandardFontEmbedder.js:15-18`: `ZapfDingbats` for ZapfDingbats, `Symbol` for Symbol, else **`WinAnsi`**. So it is **single-byte, WinAnsi** — anything outside WinAnsi throws/degrades inside `@pdf-lib/standard-fonts`. The emitted font dict (`StandardFontEmbedder.js:64-77`) is `{Type:'Font', Subtype:'Type1', BaseFont: customName||fontName, Encoding: 'WinAnsiEncoding' (only for WinAnsi)}` — no `/Widths`, no descriptor.

**Custom fonts (non-subset)** — `cjs/core/embedders/CustomFontEmbedder.js:51-58`:
```js
encodeText(text) {
    var glyphs = this.font.layout(text, this.fontFeatures).glyphs;   // fontkit shaping
    var hexCodes = glyphs.map(g => toHexStringOfMinLength(g.id, 4)); // 2-byte glyph IDs
    return PDFHexString.of(hexCodes.join(''));
}
```
**Two bytes per glyph — raw fontkit glyph IDs.** The font is embedded as a Type0/CID composite with `Identity-H` and a ToUnicode CMap (`embedFontDict`/`embedCIDFontDict`/`embedUnicodeCmap`, `CustomFontEmbedder.d.ts:33-39`).

**Custom subset fonts** — `cjs/core/embedders/CustomFontSubsetEmbedder.js:35-47`:
```js
encodeText(text) {
    var glyphs = this.font.layout(text, this.fontFeatures).glyphs;
    for (...) { var subsetGlyphId = this.subset.includeGlyph(glyph);   // MUTATES the subset
                this.glyphs[subsetGlyphId-1] = glyph;
                this.glyphIdMap.set(glyph.id, subsetGlyphId);
                hexCodes[idx] = toHexStringOfMinLength(subsetGlyphId, 4); }
    this.glyphCache.invalidate();
    return PDFHexString.of(hexCodes.join(''));
}
```
2-byte **subset-local** IDs. **Ordering constraint for surgery**: with `subset: true`, every `encodeText` you intend to appear in the file must run **before** `save()`, because `save() → flush() → font.embed() → serializeFont()` freezes the subset. Text encoded after that point references glyphs not in the embedded font.

Both `PDFHexString.asString()` (returns the raw hex, no delimiters) and `.copyBytesInto` are available if you want to splice the hex into a hand-built content stream: `` `<${font.encodeText(s).asString()}> Tj` ``.

**Reusing a font already embedded in the loaded PDF**: there is **no** API for this — no `embedExistingFont`, no way to build a `PDFFont` from an existing font dict. You must (a) find the name in `page.node.Resources().lookup(PDFName.Font, PDFDict)`, (b) reuse that name verbatim in your `Tf` operator, and (c) do the text→bytes encoding yourself from the font dict's `/Encoding`, `/Widths`/`/W`, and `/ToUnicode` — pdf-lib gives you `PDFDict`/`PDFArray`/`decodePDFRawStream` to read them but no encoder. Verified: after surgery the original `/Helvetica-7098480789` entry survived untouched, so keeping existing font names is the reliable path.

---

## 7. PDF object model

All classes extend `PDFObject` — `cjs/core/objects/PDFObject.d.ts:2-7`:
```ts
declare class PDFObject {
    clone(_context?: PDFContext): PDFObject;
    toString(): string;
    sizeInBytes(): number;
    copyBytesInto(_buffer: Uint8Array, _offset: number): number;
}
```

**`PDFDict`** — `cjs/core/objects/PDFDict.d.ts:12-59`
```ts
export declare type DictMap = Map<PDFName, PDFObject>;
static withContext: (context: PDFContext) => PDFDict;
static fromMapWithContext: (map: DictMap, context: PDFContext) => PDFDict;
readonly context: PDFContext;
keys(): PDFName[];
values(): PDFObject[];
entries(): [PDFName, PDFObject][];
set(key: PDFName, value: PDFObject): void;
get(key: PDFName, preservePDFNull?: boolean): PDFObject | undefined;   // does NOT resolve refs
has(key: PDFName): boolean;
lookup(key: PDFName): PDFObject | undefined;                            // resolves refs
lookup(key: PDFName, type: typeof PDFDict): PDFDict;                    // + 9 more typed overloads
lookup(ref: PDFName, type1: typeof PDFDict, type2: typeof PDFStream): PDFDict | PDFStream;
lookupMaybe(key: PDFName, type: typeof PDFDict): PDFDict | undefined;   // + same overload family
delete(key: PDFName): boolean;
asMap(): Map<PDFName, PDFObject>;
uniqueKey(tag?: string): PDFName;
clone(context?: PDFContext): PDFDict;
```
Typed overloads exist for `PDFArray | PDFBool | PDFDict | PDFHexString | PDFName | PDFNull | PDFNumber | PDFStream | PDFRef | PDFString` (`.d.ts:25-51`). `lookup` with a type **throws `UnexpectedObjectTypeError`** on mismatch; `lookupMaybe` returns `undefined` for missing but **still throws** on a present-but-wrong-type value (`PDFContext.js:63-74`).

**`PDFArray`** — `cjs/core/objects/PDFArray.d.ts:14-61`
```ts
static withContext: (context: PDFContext) => PDFArray;
size(): number;
push(object: PDFObject): void;
insert(index: number, object: PDFObject): void;
indexOf(object: PDFObject): number | undefined;
remove(index: number): void;
set(idx: number, object: PDFObject): void;
get(index: number): PDFObject;                        // unresolved
lookup(index: number): PDFObject | undefined;         // resolved; + typed overloads incl. PDFRawStream (:46)
lookupMaybe(index: number, type: typeof PDFRawStream): PDFRawStream | undefined;   // :33
asRectangle(): { x: number; y: number; width: number; height: number };
asArray(): PDFObject[];
scalePDFNumbers(x: number, y: number): void;
```

**`PDFName`** — `cjs/core/objects/PDFName.d.ts:2-39`
```ts
static of: (name: string) => PDFName;    // INTERNED via a module-level pool (PDFName.js:18)
static readonly Length | FlateDecode | Resources | Font | XObject | ExtGState | Contents | Type |
       Parent | MediaBox | Page | Annots | TrimBox | ArtBox | BleedBox | CropBox | Rotate |
       Title | Author | Subject | Creator | Keywords | Producer | CreationDate | ModDate : PDFName;
asBytes(): Uint8Array;
decodeText(): string;
asString(): string;          // includes the leading '/'
value(): string;             // @deprecated -> asString
```
Interning means `PDFName.of('Font') === PDFName.Font` is `true`, and `===` is the correct comparison (pdf-lib relies on this at e.g. `decode.js:17`, `PDFParser.js:141`).

**`PDFNumber`** — `cjs/core/objects/PDFNumber.d.ts:3-9`: `static of: (value: number) => PDFNumber; asNumber(): number; value(): number /* deprecated */`.

**`PDFString`** — `cjs/core/objects/PDFString.d.ts:3-10`
```ts
static of: (value: string) => PDFString;
static fromDate: (date: Date) => PDFString;
asBytes(): Uint8Array;    // un-escapes \n \r \t \b \f \( \) \\ and \ooo octal (PDFString.js)
decodeText(): string;     // UTF-16 if BOM present, else PDFDocEncoding
decodeDate(): Date;       // throws InvalidPDFDateStringError
asString(): string;       // the raw escaped literal
```

**`PDFHexString`** — `cjs/core/objects/PDFHexString.d.ts:3-10`
```ts
static of: (value: string) => PDFHexString;      // value = bare hex digits, no <>
static fromText: (value: string) => PDFHexString;
constructor(value: string);                       // public, unusually
asBytes(): Uint8Array;    // pads a trailing '0' if odd length (PDF 7.3.4.3)
decodeText(): string;     // UTF-16 if BOM, else PDFDocEncoding
decodeDate(): Date;
asString(): string;       // bare hex digits, no delimiters
```

**`PDFRef`** — `cjs/core/objects/PDFRef.d.ts:3-7`
```ts
static of: (objectNumber: number, generationNumber?: number) => PDFRef;   // INTERNED (PDFRef.js:8 pool)
readonly objectNumber: number;
readonly generationNumber: number;
readonly tag: string;      // "N G R"
```
Verified: `PDFRef.of(5) === PDFRef.of(5, 0)` → `true`. This matters because `PDFContext.indirectObjects` is a `Map<PDFRef, PDFObject>` keyed on object identity.

**`PDFStream` / `PDFRawStream` / `PDFFlateStream` / `PDFContentStream`**
```ts
// cjs/core/objects/PDFStream.d.ts:4-14
declare class PDFStream extends PDFObject {
    readonly dict: PDFDict;
    constructor(dict: PDFDict);
    getContentsString(): string;
    getContents(): Uint8Array;
    getContentsSize(): number;
    updateDict(): void;              // sets /Length = getContentsSize()
}
// cjs/core/objects/PDFRawStream.d.ts:4-12
declare class PDFRawStream extends PDFStream {
    static of: (dict: PDFDict, contents: Uint8Array) => PDFRawStream;
    readonly contents: Uint8Array;   // ENCODED bytes as they appeared in the file
    asUint8Array(): Uint8Array;      // .slice() copy of contents
}
// cjs/core/structures/PDFFlateStream.d.ts:4-11
declare class PDFFlateStream extends PDFStream {
    constructor(dict: PDFDict, encode: boolean);   // encode -> sets dict /Filter /FlateDecode
    computeContents: () => Uint8Array;
    getUnencodedContents(): Uint8Array;
}
// cjs/core/structures/PDFContentStream.d.ts:5-13
declare class PDFContentStream extends PDFFlateStream {
    static of: (dict: PDFDict, operators: PDFOperator[], encode?: boolean) => PDFContentStream;  // encode defaults true
    push(...operators: PDFOperator[]): void;
    getUnencodedContents(): Uint8Array;      // operators joined with '\n'
    getUnencodedContentsSize(): number;
}
```

**`PDFContext.lookup` — the type-checked lookup** (`cjs/core/PDFContext.d.ts:44-66`):
```ts
lookup(ref: LookupKey): PDFObject | undefined;
lookup(ref: LookupKey, type: typeof PDFDict): PDFDict;
lookup(ref: LookupKey, type: typeof PDFStream): PDFStream;
lookup(ref: LookupKey, type: typeof PDFArray): PDFArray;
// ... PDFBool | PDFHexString | PDFName | PDFNull | PDFNumber | PDFRef | PDFString, plus
lookup(ref: LookupKey, type1: typeof PDFString, type2: typeof PDFHexString): PDFString | PDFHexString;
lookupMaybe(ref: LookupKey, type: typeof PDFDict): PDFDict | undefined;   // same overload family
// where: declare type LookupKey = PDFRef | PDFObject | undefined;   (:17)
```
`lookup` passes non-`PDFRef` values straight through (`PDFContext.js:81`), so it's safe to call on an already-resolved object. Difference between the two (`PDFContext.js:52-96`): `lookupMaybe` returns `undefined` for a missing entry or `PDFNull` (unless `PDFNull` is one of the requested types); `lookup` with no type returns `undefined`, with a type throws on mismatch.

Also on `PDFContext` (`.d.ts:26-42,67-81`): `static create`, `largestObjectNumber: number`, `header: PDFHeader`, `trailerInfo: {Root?, Encrypt?, Info?, ID?}`, `rng: SimpleRNG`, `getObjectRef(pdfObject): PDFRef | undefined` (O(n) linear scan), `enumerateIndirectObjects(): [PDFRef, PDFObject][]` (sorted by object number), `obj(literal)` with overloads for `null|string|number|boolean|LiteralObject|LiteralArray`, `addRandomSuffix(prefix, suffixLength?)`.

---

## 8. `PDFDocument.save()`

`cjs/api/PDFDocument.d.ts:754,770`
```ts
save(options?: SaveOptions): Promise<Uint8Array>;
saveAsBase64(options?: Base64SaveOptions): Promise<string>;
```
`cjs/api/PDFDocumentOptions.d.ts:11-19`
```ts
export interface SaveOptions {
    useObjectStreams?: boolean;
    addDefaultPage?: boolean;
    objectsPerTick?: number;
    updateFieldAppearances?: boolean;
}
export interface Base64SaveOptions extends SaveOptions { dataUri?: boolean; }
```
Implementation, `cjs/api/PDFDocument.js:1241-1265` — **defaults at `:1171`(rel) / `PDFDocument.js:1245`**:
```js
useObjectStreams = true, addDefaultPage = true, objectsPerTick = 50, updateFieldAppearances = true;
if (addDefaultPage && this.getPageCount() === 0) this.addPage();
if (updateFieldAppearances) { form = this.formCache.getValue(); if (form) form.updateFieldAppearances(); }
await this.flush();
Writer = useObjectStreams ? PDFStreamWriter : PDFWriter;
return Writer.forContext(this.context, objectsPerTick).serializeToBuffer();
```
`save()` **already resolves to a `Uint8Array`** — `const bytes: Uint8Array = await doc.save()`. No extra step. (`saveAsBase64({dataUri})` wraps it via `encodeToBase64`, `PDFDocument.js:1287-1295`.)

`flush()` (`PDFDocument.js:1201-1216`) awaits `embedAll` over `this.fonts, this.images, this.embeddedPages, this.embeddedFiles, this.javaScripts` — this is where reserved font refs finally get objects assigned.

Recommended for surgery: `await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false })` — uncompressed xref table, no surprise blank page, no AcroForm appearance regeneration. Verified working.

---

## 9. Gotchas — where pdf-lib rewrites/normalizes existing objects

**A. `PDFPageLeaf.normalize()` — the big one.** `cjs/core/structures/PDFPageLeaf.js:142-170`:
```js
normalize() {
    if (this.normalized) return;
    var contentsRef = this.get(PDFName.Contents);
    if (this.context.lookup(contentsRef) instanceof PDFStream)
        this.set(PDFName.Contents, context.obj([contentsRef]));         // (1) single stream -> array
    if (this.autoNormalizeCTM)
        this.wrapContentStreams(this.context.getPushGraphicsStateContentStream(),   // (2) inject q ... Q
                                this.context.getPopGraphicsStateContentStream());
    // TODO: Clone `Resources` if it is inherited
    var Resources = context.lookupMaybe(this.getInheritableAttribute(PDFName.Resources), PDFDict) || context.obj({});
    this.set(PDFName.Resources, Resources);                              // (3) inherited Resources copied DOWN
    var Font      = Resources.lookupMaybe(PDFName.Font, PDFDict)      || context.obj({});  Resources.set(PDFName.Font, Font);
    var XObject   = Resources.lookupMaybe(PDFName.XObject, PDFDict)   || context.obj({});  Resources.set(PDFName.XObject, XObject);
    var ExtGState = Resources.lookupMaybe(PDFName.ExtGState, PDFDict) || context.obj({});  Resources.set(PDFName.ExtGState, ExtGState);
    var Annots = this.Annots() || context.obj([]);  this.set(PDFName.Annots, Annots);      // (4) empty /Annots forced
    this.normalized = true;
}
```
**Empirically confirmed** — after one `normalizedEntries()` call on a page whose `/Contents` was a 1-element array, `Contents` became **size 3** and the merged content decoded to:
```
q          <- injected
q BT ... ET Q       <- original
Q          <- injected
```
`autoNormalizeCTM` is `true` for every page parsed from a file (`PDFPageLeaf.fromMapWithContext` default, `.d.ts:13` / `.js:199-202`); only `withContextAndParent` (new pages) passes `false`.

Everything that triggers it: `PDFPageLeaf.normalize / normalizedEntries / addContentStream / addAnnot / removeAnnot / setFontDictionary / newFontDictionaryKey / newFontDictionary / setXObject / newXObjectKey / newXObject / setExtGState / newExtGStateKey / newExtGState`, and at the API layer `PDFPage.pushOperators / drawText / drawImage / drawPage / drawSvgPath / drawLine / drawRectangle / drawEllipse / drawCircle / setFont / translateContent / scaleContent / scale / resetPosition`, plus `PDFPageEmbedder.embedIntoContext`.

Consequences for a page you meant to leave alone: extra `q`/`Q` streams appended to `/Contents`; a `/Resources` (and `/Font`, `/XObject`, `/ExtGState`) dict materialized on the page; an empty `/Annots []`; and — because the inherited `Resources` object is **shared, not cloned** (note the three `// TODO: Clone ... if it is inherited` comments) — mutating it silently affects every other page inheriting from that `Pages` node.

Mitigations: (i) never touch `PDFPage` draw APIs on pages you're operating on by hand; (ii) read `Contents()` and handle both shapes yourself rather than calling `normalizedEntries()`; (iii) register fonts/XObjects into `Resources` by hand as shown in §5. Note `normalize()` is idempotent per `PDFPageLeaf` instance (the `normalized` flag) and `wrapContentStreams` reuses the *same* cached `q`/`Q` refs across all pages (`PDFContext.js:167-192`).

**B. `save()` is always a full rewrite, never an incremental update.** `PDFWriter.computeBufferSize` (`cjs/core/writers/PDFWriter.js:109`) iterates `context.enumerateIndirectObjects()` and re-serializes every object through `copyBytesInto`. There is no incremental-update writer in this version. Digital signatures on the input are therefore always invalidated.

**C. PDF version is forced to 1.7.** `PDFWriter.js:106` and `PDFStreamWriter.js:30`: `PDFHeader.forVersion(1, 7)` — the parsed `context.header` is discarded at write time.

**D. Object streams are exploded and re-packed.** `PDFParser.js:141-142` runs `PDFObjectStreamParser.parseIntoContext()` on every `/Type /ObjStm`, which `context.assign`s each contained object individually (`PDFObjectStreamParser.js:38-41`) and drops the ObjStm container. With `useObjectStreams: true` (default), `PDFStreamWriter.computeBufferSize` (`:57-90`) re-groups them into brand-new object streams, 50 per stream. Objects excluded from compression (`PDFStreamWriter.js:43-46`): the `/Encrypt` ref, any `PDFStream`, any `PDFInvalidObject`, and anything with `generationNumber !== 0`.

**E. Free xref entries are not honoured.** `cjs/core/parser/PDFParser.js` ~line 245: `// this.context.delete(ref);` is **commented out**. Objects the xref table marks free are still parsed, retained, and re-written.

**F. Object `0 0 R` is silently dropped** with `console.warn('Removing parsed object: 0 0 R')` — `PDFParser.js:64-67`.

**G. `updateMetadata: true` (load default)** rewrites `/Producer` and `/ModDate` in the Info dict, and creates an Info dict if absent (`PDFDocument.js:1347-1355` `getInfoDict`). Pass `updateMetadata: false`.

**H. `updateFieldAppearances: true` (save default)** regenerates **all** AcroForm widget appearance streams. It is guarded by `this.formCache.getValue()` returning non-`undefined` (`Cache.d.ts:6`), i.e. it only fires **if you have ever called `doc.getForm()`**. Separately, `getForm()` itself will `console.warn('Removing XFA form data...')` and `form.deleteXFA()` on any XFA document. For surgery on form-bearing PDFs: never call `getForm()`, and pass `updateFieldAppearances: false` for belt and braces.

**I. `addDefaultPage: true` (save default)** inserts a blank page into a zero-page document.

**J. `capNumbers: false` (load default)** lets numbers above `Number.MAX_SAFE_INTEGER` through with only a `console.warn` (`BaseParser.js:55-63`), which can serialize as an invalid number.

**K. `PDFName` bytes are regenerated, not preserved.** `PDFName.js:26-31` re-encodes every character outside `!`..`~` (minus irregulars) as `#XX`. Semantically equivalent, byte-different from the input.

**L. `context.stream(string)` is latin1-only.** `typedArrayFor` (`cjs/utils/arrays.js`) does `charCodeAt` per character into a `Uint8Array`; code points > 0xFF are truncated. Pass `Uint8Array` for anything binary. Symmetrically, `arrayAsString` / `PDFRawStream.getContentsString()` produce a latin1 string — safe to round-trip through if you never introduce non-latin1 characters.

**M. `PDFRawStream.getContents()` does not decode.** It returns the stored encoded bytes verbatim (`PDFRawStream.js:22-24`). Reading `/Contents` with it and writing the result back unchanged would work by accident; using it as "the content stream source" gives you deflate garbage. Always `decodePDFRawStream(stream).decode()`.

**N. Replaced objects are not garbage-collected.** After `page.node.set(PDFName.Contents, newRef)`, the old stream is still in `context.indirectObjects` and is still written to the output. Call `doc.context.delete(oldRef)` if size matters — but only after confirming nothing else references it (`getObjectRef` is a linear scan; there is no refcounting).

**O. `PDFInvalidObject` round-trips raw bytes** (`PDFParser.js:183` `PDFInvalidObject.of(this.bytes.slice(start, end))`), so malformed objects survive save intact rather than being repaired — good for fidelity, bad if you expected `throwOnInvalidObject` behavior.

---

## Working skeleton (all APIs verified against the installed build)

```ts
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, PDFRawStream,
  PDFContentStream, decodePDFRawStream, mergeIntoTypedArray,
} from 'pdf-lib';

const doc  = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
const page = doc.getPages()[0];
const leaf = page.node;                       // PDFPageLeaf

// --- read (no normalize) ---
const decodeOne = (s: PDFStream) =>
  s instanceof PDFRawStream     ? decodePDFRawStream(s).decode()
: s instanceof PDFContentStream ? s.getUnencodedContents()
: (() => { throw new Error('unrecognized stream type'); })();

const c = leaf.Contents();
const src = !c ? new Uint8Array(0)
  : c instanceof PDFArray
    ? mergeIntoTypedArray(...Array.from({ length: c.size() }, (_, i) =>
        [decodeOne(c.lookup(i, PDFStream)), Uint8Array.of(0x0a)]).flat())
    : decodeOne(c as PDFStream);

// --- inspect fonts already in the file (no normalize) ---
const fonts = leaf.Resources()?.lookupMaybe(PDFName.Font, PDFDict);
fonts?.keys().forEach(k => console.log(k.asString(), fonts.get(k)?.toString()));

// --- rewrite ---
const edited = /* your Uint8Array */;
const ref = doc.context.register(doc.context.flateStream(edited));  // /Filter and /Length handled for you
leaf.set(PDFName.Contents, ref);

const out: Uint8Array = await doc.save({
  useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false,
});
```