# PDF Font Dictionaries — Implementation Reference

**Scope:** ISO 32000-1 §9.5–9.10 (+ Annex D, Adobe CMap/CID spec, Adobe Glyph List spec). Two goals: (A) exact glyph advance widths; (B) reverse-mapping Unicode → original byte codes for re-encoding edited text with the **original embedded font**.

---

## 0. Orientation: the two font families

Every `/Font` resource is exactly one of:

| Category | `/Subtype` | Code size | Width source |
|---|---|---|---|
| **Simple** | `/Type1`, `/MMType1`, `/TrueType`, `/Type3` | always **1 byte**, 0–255 | `/Widths` + `/FirstChar` + `/FontDescriptor /MissingWidth` |
| **Composite** | `/Type0` | 1–4 bytes, determined by the CMap's codespace ranges | descendant CIDFont `/W` + `/DW`, keyed by **CID** |

A simple font can address at most 256 glyphs. A `/Type0` font maps **code → CID → glyph**.

### 0.1 The displacement formula (§9.4.4)

After showing a glyph, the text matrix translates by:

```
tx = ((w0 - Tj/1000) * Tfs + Tc + Tw) * Th
ty = 0                                       (horizontal writing, WMode 0)
```
Vertical (WMode 1):
```
tx = 0
ty =  (w1 - Tj/1000) * Tfs + Tc + Tw
```

* `w0` = **glyph horizontal displacement in *text space* units** (i.e. already divided by 1000 for non-Type3 fonts).
* `Tfs` = font size, `Tc` = char spacing, `Tw` = word spacing, `Th` = horizontal scale `Tz/100`.
* `Tj` = the number from a `TJ` array (thousandths of a text-space unit, **subtracted**).
* **`Tw` applies if and only if the byte code is single-byte `32` (0x20).** For a Type0 font with 2-byte codes, `Tw` never applies — even for the code that means space. This is a classic regression when converting a simple font run to Identity-H.

So the whole width problem reduces to: **given a byte string and a font dict, decode to a sequence of (code, glyphWidth1000) pairs.**

---

## 1. Simple fonts: widths

### 1.1 The `/Widths` array (§9.6.2.1, Table 111)

```
/FirstChar 32
/LastChar  126
/Widths [ 278 278 355 ... ]      % LastChar - FirstChar + 1 entries
```

Lookup:

```
function simpleWidth(font, code):           # code in 0..255, returns glyph-space/1000
    W  = font.Widths                        # resolved array (may be an indirect ref!)
    fc = font.FirstChar ?? 0
    lc = font.LastChar  ?? 255
    if W != null and fc <= code <= lc and (code - fc) < len(W):
        w = W[code - fc]
        if w is a number: return w          # entries may be indirect refs -> resolve
    # fall through
    if font.FontDescriptor != null:
        return font.FontDescriptor.MissingWidth ?? 0
    return standard14Width(font, code)      # see 1.3; else 0
```

**Units.** For `/Type1`, `/MMType1`, `/TrueType`: entries are in **glyph space = 1/1000 text space**. So `w0 = Widths[i] / 1000`.

**`/MissingWidth`** lives in the `/FontDescriptor`, is in the same 1/1000 units, **default 0**. It is used for any code outside `[FirstChar, LastChar]` and for codes whose glyph is `.notdef`.

**Do not** take widths from the embedded font program when `/Widths` is present. `/Widths` overrides the font program — a conforming reader must honour it, and PDFs in the wild rely on this (e.g. a subset font whose `hmtx` disagrees).

### 1.2 Type3 fonts — different units (§9.6.5)

`/Type3` is the exception. Required keys: `/FontMatrix`, `/CharProcs`, `/Encoding` (must be a dictionary with `/Differences`), `/FirstChar`, `/LastChar`, `/Widths`, `/FontBBox`.

`/Widths` entries are in **glyph space defined by `/FontMatrix`**, *not* 1/1000. Convert:

```
# FontMatrix = [a b c d e f]
w0 = a * Widths[code - FirstChar] + c * 0        # transform the vector (w, 0)
# (the y component b*w is normally 0 and is ignored for horizontal writing)
```

For the common `/FontMatrix [0.001 0 0 0.001 0 0]` this reduces to `w/1000`, identical to Type1. For `/FontMatrix [1 0 0 1 0 0]`, a `/Widths` entry of `0.5` already *is* text space.

Notes:
* Type3 `/Widths` entries **must not be indirect references** if the font is used in a Type3 glyph description (spec constraint on nesting); in practice resolve defensively.
* The `d0`/`d1` operators inside a CharProc declare the glyph's width too, but `/Widths` is authoritative for the reader's text-space advance.
* Type3 has no `/FontDescriptor` in PDF ≤1.4 (optional, and required only for Tagged PDF), so `/MissingWidth` is usually unavailable → treat missing codes as width 0.

### 1.3 No `/Widths`: the standard 14 (§9.6.2.2)

`/Widths`, `/FirstChar`, `/LastChar`, `/FontDescriptor` may all be absent **only** when `/BaseFont` names one of the 14 standard fonts (or a well-known alias). PDF 2.0 deprecates this and requires `/Widths`, but you must still read legacy files.

The 14 names exactly as they appear in `/BaseFont`:

```
Times-Roman        Helvetica              Courier               Symbol
Times-Bold         Helvetica-Bold         Courier-Bold          ZapfDingbats
Times-Italic       Helvetica-Oblique      Courier-Oblique
Times-BoldItalic   Helvetica-BoldOblique  Courier-BoldOblique
```

**Metric source:** Adobe's Core 14 AFM files (`Times-Roman.afm`, etc., from the "Adobe Core 35 / Core 14 AFM Set", also shipped by Ghostscript, PDF.js `standard_fonts`, PDFBox `org/apache/pdfbox/resources/afm/`). Each AFM has `C <code> ; WX <width> ; N <glyphname> ;` lines. **Key the AFM lookup by *glyph name*, not by the AFM's `C` code**, because the PDF's `/Encoding` may differ from the AFM's built-in StandardEncoding:

```
function standard14Width(font, code):
    afm  = AFM[canonicalStd14Name(font.BaseFont)]
    name = encodingMap(font)[code]        # §2
    if name == null: return afm.MissingWidth ?? 0
    return afm.widthByGlyphName[name] ?? 0
```

Aliases you must canonicalise (non-normative but universal practice):

| Seen in `/BaseFont` | Map to |
|---|---|
| `Arial`, `ArialMT`, `Arial-Regular`, `Helv` | `Helvetica` |
| `Arial-Bold`, `Arial-BoldMT`, `ArialBold` | `Helvetica-Bold` |
| `Arial-Italic`, `Arial-ItalicMT` | `Helvetica-Oblique` |
| `Arial-BoldItalicMT` | `Helvetica-BoldOblique` |
| `TimesNewRoman`, `TimesNewRomanPSMT`, `Times` | `Times-Roman` |
| `TimesNewRomanPS-BoldMT` etc. | `Times-Bold` / `-Italic` / `-BoldItalic` |
| `CourierNew`, `CourierNewPSMT`, `Courier New` | `Courier` (+ bold/italic variants) |
| `ZapfD` | `ZapfDingbats` |

Strip any subset prefix `^[A-Z]{6}\+` first. Strip a trailing `,Bold` / `,Italic` / `,BoldItalic` (MS-style) and fold into the style. **All four Courier faces have width 600 for every glyph** — a useful sanity check.

Default encodings for the special two: `Symbol` and `ZapfDingbats` have **built-in** encodings (Annex D.5, D.6); do **not** apply StandardEncoding to them.

---

## 2. `/Encoding` for simple fonts (§9.6.6) — code → glyph name

This is the backbone for both width lookup of standard-14 fonts and for reverse-mapping without `/ToUnicode`.

### 2.1 The three forms

1. **Absent** → use the font program's built-in encoding.
2. **A name**: `/WinAnsiEncoding`, `/MacRomanEncoding`, `/MacExpertEncoding` (Annex D). (`/StandardEncoding` is not a legal value of `/Encoding` in a font dict per Table 114, but readers accept it; also accepted in the wild: `/PDFDocEncoding` — reject/ignore.)
3. **A dictionary**:
```
<< /Type /Encoding
   /BaseEncoding /WinAnsiEncoding          % optional
   /Differences [ 24 /breve /caron /circumflex
                  39 /quotesingle
                  96 /grave
                  128 /bullet /dagger ]    % optional
>>
```

### 2.2 Exact build algorithm

```
function encodingMap(font) -> array[256] of glyphName|null:

    isTrueType = font.Subtype == "TrueType"
    fd    = font.FontDescriptor
    flags = fd ? (fd.Flags ?? 0) : 0
    symbolic    = (flags & 0x04) != 0        # bit 3 (1-based) = Symbolic
    nonsymbolic = (flags & 0x20) != 0        # bit 6 (1-based) = Nonsymbolic
    if symbolic and nonsymbolic: symbolic = false   # contradictory -> trust Nonsymbolic

    enc = font.Encoding                      # resolve indirect

    # --- 1. choose the base table -------------------------------------
    base = null
    if enc is a Name:
        base = predefined(enc)                       # WinAnsi | MacRoman | MacExpert
    else if enc is a Dictionary and enc.BaseEncoding is a Name:
        base = predefined(enc.BaseEncoding)
    else:
        # No explicit base encoding.
        builtin = builtinEncodingOfFontProgram(font) # Type1/CFF /Encoding array;
                                                     # TrueType: none (cmap is not a name table)
        if builtin != null:
            base = builtin
        else if symbolic and isTrueType:
            base = null            # DO NOT synthesize names; use the raw-code path (§2.4)
        else:
            base = StandardEncoding

        # Standard-14 special cases override the above:
        if canonicalStd14Name(font.BaseFont) == "Symbol":       base = SymbolEncoding
        if canonicalStd14Name(font.BaseFont) == "ZapfDingbats": base = ZapfDingbatsEncoding

    map = base ? copy(base) : array[256] filled with null

    # --- 2. apply /Differences ----------------------------------------
    if enc is a Dictionary and enc.Differences is an Array:
        cur = 0
        for item in enc.Differences:
            if item is a Number:  cur = int(item)            # may be real -> truncate
            else if item is a Name:
                if 0 <= cur <= 255: map[cur] = item
                cur += 1
            # anything else: ignore (malformed)
    return map
```

**Precedence, restated:** `/Differences` > `/BaseEncoding` (or `/Encoding` name) > font program's built-in encoding > StandardEncoding (nonsymbolic) / raw codes (symbolic TrueType).

### 2.3 Base-encoding gotchas (Annex D.2)

* **StandardEncoding vs WinAnsiEncoding at 39 and 96**: Standard `39 = quoteright (’)`, `96 = quoteleft (‘)`; WinAnsi `39 = quotesingle (')`, `96 = grave (`)`. Getting this wrong silently corrupts apostrophes.
* **WinAnsiEncoding**: `128 = Euro`, `130 quotesinglbase`, `131 florin`, `132 quotedblbase`, `133 ellipsis`, `134 dagger`, `135 daggerdbl`, `136 circumflex`, `137 perthousand`, `138 Scaron`, `139 guilsinglleft`, `140 OE`, `142 Zcaron`, `145 quoteleft`, `146 quoteright`, `147 quotedblleft`, `148 quotedblright`, `149 bullet`, `150 endash`, `151 emdash`, `152 tilde`, `153 trademark`, `154 scaron`, `155 guilsinglright`, `156 oe`, `158 zcaron`, `159 Ydieresis`. Also **`160` → `space`** (nbsp is rendered as space) and **`173` → `hyphen`** (soft hyphen). Spec note: unused codes > 40 shall be shown as `bullet`.
* **MacRomanEncoding in PDF ≠ Mac OS Roman.** PDF's version omits `notequal`, `infinity`, `lessequal`, `greaterequal`, `partialdiff`, `summation`, `product`, `pi`, `integral`, `Omega`, `radical`, `approxequal`, `Delta`, `lozenge`, `apple`; and `0xDB` is `currency`, not `Euro`. If you need the true Mac OS Roman set (some TrueType `(1,0)` cmaps), keep a separate table.
* **MacExpertEncoding** contains only "expert set" glyph names (`onesuperior`, `oneoldstyle`, `ffi`, small caps `Asmall`…). Rarely relevant, but include it for completeness.
* Standard/WinAnsi/MacRoman **all** leave 0–31 unmapped (null).

### 2.4 Symbolic TrueType fonts (§9.6.6.4) — glyph selection, and why it breaks names

`/FontDescriptor /Flags` bit 3 (`0x04`, "Symbolic") means: *the font's built-in encoding is authoritative and the glyphs are not standard-Latin.* The spec's glyph-selection procedure for `/TrueType`:

**Symbolic (and `/Encoding` absent or has no useful names):**
1. If the embedded font has a **`(3,0)` cmap** (Microsoft Symbol): look up the **raw byte code** `c`. If that fails, look up **`0xF000 | c`** — Symbol-encoded fonts (Wingdings, Symbol, most icon fonts, many LaTeX subsets) place their glyphs in the Private Use range **U+F000–U+F0FF**. Also try `0xF100|c` and `0xF200|c` defensively; some producers use those.
2. Else if the font has a **`(1,0)` cmap** (Mac Roman): look up the raw code `c` directly.
3. Else: treat the code as a glyph index (last-ditch; Acrobat does this for `(0,x)`-only fonts).

**Nonsymbolic:**
1. Build `code → glyphName` via §2.2.
2. Map `glyphName → Unicode` via the **AGL** (§6.3).
3. Look up that Unicode in the **`(3,1)` cmap** (Microsoft Unicode BMP), or `(3,10)`/`(0,x)` for supplementary.
4. If that fails: take the code for `glyphName` in **MacRomanEncoding** and look *that* code up in the `(1,0)` cmap.
5. If that fails: look up `glyphName` directly in the **`post`** table.
6. If that fails: `.notdef` (width `/MissingWidth`).

**Consequence for reverse mapping:** for a symbolic TrueType font there is *no reliable glyph-name layer*. Codes are opaque. Without `/ToUnicode` you cannot reverse-map at all — see §6.5.

**Consequence for widths:** none. Widths still come from `/Widths[code - FirstChar]` regardless of symbolic-ness. The cmap dance affects only which glyph is *drawn*.

---

## 3. Composite fonts: `/Type0` (§9.7)

```
<< /Type /Font
   /Subtype /Type0
   /BaseFont /ABCDEF+NotoSans          % should match descendant's BaseFont
   /Encoding /Identity-H               % name OR stream
   /DescendantFonts [ 12 0 R ]         % array of EXACTLY one CIDFont
   /ToUnicode 13 0 R                   % optional stream
>>
```

```
12 0 obj
<< /Type /Font
   /Subtype /CIDFontType2              % or /CIDFontType0
   /BaseFont /ABCDEF+NotoSans
   /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
   /FontDescriptor 14 0 R
   /DW 1000
   /W [ ... ]
   /CIDToGIDMap /Identity              % CIDFontType2 only
   /DW2 [ 880 -1000 ]  /W2 [ ... ]     % vertical only
>>
```

* `/CIDFontType0` → the descendant program is **CFF/OpenType-CFF** (`/FontFile3`, `/Subtype /CIDFontType0C` or `/OpenType`).
* `/CIDFontType2` → **TrueType glyf** (`/FontFile2`, or `/FontFile3 /OpenType`).

### 3.1 `/Encoding`: predefined CMap name vs embedded CMap stream (§9.7.5)

**Name form.** The CMap is one of Adobe's predefined CMaps. Most important:

| Name | Meaning |
|---|---|
| `/Identity-H` | 2-byte big-endian code, **CID = code**, WMode 0. Codespace `<0000>–<FFFF>`. |
| `/Identity-V` | same, WMode 1 (vertical). |
| `/UniGB-UCS2-H`, `/UniCNS-UCS2-H`, `/UniJIS-UCS2-H`, `/UniKS-UCS2-H` | 2-byte UCS-2 → CID for the CJK collections |
| `/UniJIS-UTF16-H`, `/UniGB-UTF16-H`, … | UTF-16 (surrogate-aware, mixed 2/4-byte) |
| `/90ms-RKSJ-H`, `/90pv-RKSJ-H` | Shift-JIS: **mixed 1- and 2-byte codes** |
| `/ETen-B5-H`, `/B5pc-H` | Big5, mixed 1/2-byte |
| `/GBK-EUC-H`, `/GB-EUC-H`, `/UniGB-UTF8-H` | mixed 1/2/3-byte |
| `/KSCms-UHC-H` | mixed 1/2-byte |

`-H` = horizontal (WMode 0), `-V` = vertical (WMode 1). A `-V` CMap almost always `usecmap`s its `-H` sibling and only overrides a handful of codes.

If you encounter a non-Identity predefined CMap you must either ship the Adobe CMap resource files (`Adobe-Japan1-*`, `Adobe-GB1-*`, `Adobe-CNS1-*`, `Adobe-Korea1-*`, `Adobe-KR-*`) or refuse to edit that font. **`/Identity-H` covers >95% of modern producers.**

**Stream form.** The value is a stream whose dictionary is:

```
<< /Type /CMap
   /CMapName /MyCustomCMap
   /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >>
   /WMode 0                      % optional, default 0
   /UseCMap /90ms-RKSJ-H         % optional: name or stream ref
>>
```
Its content is PostScript-flavoured CMap syntax using `begincodespacerange`, `begincidrange`/`begincidchar`, `beginnotdefrange`, and possibly `usecmap`. Parse it with the same tokenizer as `/ToUnicode` (§5), but the operators produce **CIDs (integers)**, not Unicode strings:

```
2 begincodespacerange
<00>   <80>
<8140> <9FFC>
endcodespacerange

3 begincidrange
<20> <7e> 1
<8140> <817e> 633
<8180> <81ac> 708
endcidrange

1 begincidchar
<8140> 633
endcidchar

1 beginnotdefrange
<00> <1f> 231          % codes in range with no CID -> this notdef CID
endnotdefrange
```

`usecmap` semantics: load the referenced CMap first (codespace ranges **and** mappings), then let this CMap's own entries override.

### 3.2 Decoding a byte string with codespace ranges (§9.7.6.2)

Codespace ranges define **how many bytes each code consumes**. Each range is a pair of hex strings of equal byte length `n`; a code of length `n` matches iff **each byte** `b[i]` satisfies `lo[i] <= b[i] <= hi[i]` (byte-wise, **not** a numeric interval on the whole value — this matters for Shift-JIS-style ranges).

```
function nextCode(bytes, pos, ranges) -> (codeValue, nBytes):
    # ranges grouped by byte length 1..4
    candidate = null
    for n in 1..4:
        if pos + n > len(bytes): break
        chunk = bytes[pos : pos+n]
        for r in ranges where r.len == n:
            if all(r.lo[i] <= chunk[i] <= r.hi[i] for i in 0..n-1):
                return (int_be(chunk), n)
        # remember partial matches for the error path
        if candidate == null:
            for r in ranges where r.len == n:
                if r.lo[0] <= chunk[0] <= r.hi[0]:
                    candidate = n           # first byte matches an n-byte range
    # ---- no full match: spec error-recovery ----
    if candidate != null:
        return (int_be(bytes[pos:pos+candidate]), candidate)   # -> notdef
    n = min length among all ranges (or 1 if none defined)
    return (int_be(bytes[pos:pos+n]), n)                        # -> notdef
```

Important corollaries:
* **If no codespace ranges are declared at all** (some broken `/ToUnicode` streams), the conventional fallback is 1 byte for simple fonts and 2 bytes for Type0. For `/Identity-H` always assume `<0000>–<FFFF>`.
* Codespace ranges from the **`/Encoding` CMap** govern text-showing operators. Codespace ranges in the **`/ToUnicode`** CMap govern only the interpretation of that CMap's own entries — but in practice they are (and must be) consistent, and you use them when decoding a string for text extraction.
* A CMap may mix lengths: `<00>–<80>` (1 byte) plus `<8140>–<9FFC>` (2 bytes). Then `0x41` is one code and `0x81 0x40` is another.

### 3.3 `/DW` and the `/W` array (§9.7.4.3) — exact parsing

* `/DW` — default width for any CID not covered by `/W`. **Default 1000** if `/DW` is absent.
* `/W` — array mixing two forms, in any order, any number of times:

```
FORM 1:  cFirst  [ w1 w2 w3 ... ]      # widths for cFirst, cFirst+1, cFirst+2, ...
FORM 2:  cFirst  cLast  w              # single width w for every CID in [cFirst, cLast]
```

All widths are in **glyph space = 1/1000 text space** (CIDFonts never have a nondefault FontMatrix in this sense). Widths are keyed by **CID**, not by character code.

**Parsing pseudocode:**

```
function parseW(Warray) -> map<CID, int>:
    W = resolve(Warray)                       # may be indirect; elements may be indirect
    out = {}                                  # or an interval list for memory
    i = 0
    while i < len(W):
        first = resolve(W[i]); i += 1
        if i >= len(W): break                 # malformed, stop
        nxt = resolve(W[i])
        if nxt is an Array:                   # FORM 1
            i += 1
            for k, w in enumerate(nxt):
                out[int(first) + k] = number(resolve(w))
        else:                                 # FORM 2
            last = int(nxt); i += 1
            if i >= len(W): break
            w = number(resolve(W[i])); i += 1
            if last < first: swap(first, last)          # defensive
            if last - first > 65535: last = first+65535 # sanity clamp
            addRange(out, first, last, w)
    return out

function cidWidth(cidFont, cid):
    w = Wmap.get(cid)
    return w != null ? w : (cidFont.DW ?? 1000)
```

Notes / traps:
* Numbers may be reals (`/W [ 1 [ 277.83 ] ]`) — keep them as floats; do not truncate.
* Ranges can be huge (`0 65535 1000`); store as intervals rather than expanding, or expand lazily.
* Later entries override earlier ones when ranges overlap. Apply in array order.
* A CID appearing in `/W` is *not* proof the glyph exists in a subset font — only that a width was recorded. (Conversely, many subsetters emit `/W` only for the CIDs they kept, which makes `/W` membership a decent — not proof-grade — subset-presence heuristic. See §6.6.)

**Worked example.**

```
/DW 1000
/W [ 0 [ 507 ]
     3 [ 226 326 401 498 ]
     17 25 507
     26 [ 337 337 ]
     120 121 600
     1000 [ 1000 500 ] ]
```

Parses to:

| CID | width | from |
|---|---|---|
| 0 | 507 | form 1 |
| 3 | 226 | form 1 |
| 4 | 326 | form 1 |
| 5 | 401 | form 1 |
| 6 | 498 | form 1 |
| 17–25 | 507 | form 2 |
| 26 | 337 | form 1 |
| 27 | 337 | form 1 |
| 120 | 600 | form 2 |
| 121 | 600 | form 2 |
| 1000 | 1000 | form 1 |
| 1001 | 500 | form 1 |
| anything else (e.g. 7, 200, 5000) | **1000** | `/DW` |

Text-space advance for CID 4 at `Tfs = 12`: `w0 = 326/1000 = 0.326`; `tx = 0.326 * 12 = 3.912` units (plus `Tc`, scaled by `Th`).

### 3.4 Full width path for a Type0 font

```
function type0Widths(font, bytes) -> list of (code, cid, w1000):
    cmap = loadEncodingCMap(font.Encoding)          # predefined or embedded stream
    df   = resolve(font.DescendantFonts[0])
    Wm   = parseW(df.W); DW = df.DW ?? 1000
    out = []; pos = 0
    while pos < len(bytes):
        (code, n) = nextCode(bytes, pos, cmap.codespaceRanges)
        pos += n
        cid = cmap.toCID(code)                      # Identity-H: cid = code
        out.append((code, cid, Wm.get(cid) ?? DW))
    return out
```

---

## 4. `/CIDSystemInfo` and `/CIDToGIDMap` (§9.7.3, §9.7.4.2)

### 4.1 `/CIDSystemInfo`

```
<< /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >>
```
Required in the CIDFont; also present in embedded CMap stream dicts. Purposes:
* **Compatibility check** — the `/Encoding` CMap's `/CIDSystemInfo` must match the descendant's (same Registry+Ordering, CMap's Supplement ≤ font's) or the mapping is undefined.
* **Non-embedded CIDFonts** — the reader substitutes a system font for that character collection and uses the collection's CID ordering.
* `(Adobe) (Identity) 0` means "CIDs are meaningless indices"; combined with `/Identity-H` it says **code = CID = GID** (subject to `/CIDToGIDMap`).

Registry/Ordering are **PDF strings**, so they may be hex or contain escapes — decode before comparing.

### 4.2 `/CIDToGIDMap` — **CIDFontType2 only**

* `/Identity` (or absent → default `/Identity`): `GID = CID`.
* A **stream**: a byte array of length `2 × (highestCID + 1)`. `GID = (stream[2*cid] << 8) | stream[2*cid + 1]`, big-endian. If `2*cid + 1 >= len(stream)`, `GID = 0` (`.notdef`).

Relevance to editing: if you re-encode text and need to verify a glyph really exists in the embedded subset, you resolve `CID → GID` here and then check the `glyf`/`loca` table for a nonzero-length (or legitimately empty, e.g. space) entry.

For **CIDFontType0** `/CIDToGIDMap` is meaningless and shall be absent. Glyph selection goes through the CFF **charset**, which maps GID → CID; the reader inverts it. If the embedded CFF is *not* CID-keyed (a plain CFF wrapped as a CIDFont — common for OpenType/CFF subsets), the convention is `GID = CID` (identity), and the charset is ignored.

---

## 5. `/ToUnicode` CMap streams (§9.10.3)

A stream (usually `/Filter /FlateDecode`) whose dictionary may carry `/Type /CMap` etc. but whose content is what matters. Canonical skeleton:

```
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
...bfchar / bfrange blocks...
endcmap
CMapName currentdict /CMap defineresource pop
end
end
```

`/CMapType 2` marks a ToUnicode CMap. Destinations are **UTF-16BE** byte strings.

### 5.1 `codespacerange`

```
<count> begincodespacerange
  <lo1> <hi1>
  <lo2> <hi2>
  ...
endcodespacerange
```
Same semantics as §3.2: the byte length of `lo`/`hi` (which must be equal, 1–4 bytes) is the code length; matching is byte-wise. Multiple blocks may appear; union them. **≤ 100 pairs per block** (spec limit; readers should not enforce it).

For a **simple font** the ToUnicode CMap must use 1-byte ranges (`<00> <FF>`); for `/Identity-H` it must use `<0000> <FFFF>`. Producers frequently get this wrong (1-byte ranges on a Type0 font). **Heuristic:** if the font is Type0 but the ToUnicode declares 1-byte codespaces while every `bfchar`/`bfrange` source is 2 bytes, trust the source-string lengths over the declared codespace.

### 5.2 `bfchar`

```
<count> beginbfchar
  <src> <dst>
  ...
endbfchar
```
* `<src>`: hex string, 1–4 bytes, length must match a codespace range.
* `<dst>`: **hex string** = UTF-16BE, any even byte length ≥ 2 → may encode **multiple** Unicode scalars (ligature decomposition) and **surrogate pairs**.
* `<dst>` may legally be a **name** in general CMaps; in `/ToUnicode` it should not be, but if you see one, resolve via AGL (§6.3) and continue.
* Max 100 entries per block; multiple blocks allowed.

### 5.3 `bfrange` — both destination forms

```
<count> beginbfrange
  <lo> <hi> <dstBase>          % FORM A: incremental
  <lo> <hi> [ <d0> <d1> ... ]  % FORM B: explicit array
endbfrange
```

**FORM A (incremental).** `lo` and `hi` are same-length hex codes; `hi >= lo`. The destination for `lo` is `dstBase`; for `lo+k` it is `dstBase` **with its last byte incremented by k**.

Spec wording: *"the last byte of the string shall be incremented"*, and it further constrains `lo` and `hi` to differ **only in the last byte**, so `k ≤ 255`.

Practical rule (what real readers do, and what you should implement):
* If `dstBase` is 2 bytes (one BMP code unit): `dst(lo+k) = dstBase_value + k` as a 16-bit value. (Incrementing "the last byte" and incrementing the 16-bit value agree as long as `lastByte + k ≤ 0xFF`; when it would overflow, **carry into the previous byte** — this is what Acrobat/pdf.js/PDFBox do, and producers rely on it. Pure last-byte-only wraparound produces garbage.)
* If `dstBase` is longer (multi-char or surrogate pair): increment **the last UTF-16 code unit** (last 2 bytes), leaving the prefix intact.
* If `hi - lo > 0xFF`, clamp/defensively split; some producers emit oversized ranges. Prefer to honour the full range with the carry rule.
* If `dstBase` is a **name**: treat as FORM A over a single code (`lo == hi`) and resolve the name via AGL.

**FORM B (array).** The array must contain exactly `hi - lo + 1` hex strings; `dst(lo+k) = array[k]`. Each element is independently a UTF-16BE string of any even length. If the array is short, map only the entries present; if long, ignore the extras.

### 5.4 Surrogate pairs

Destinations are UTF-16BE, so any scalar above U+FFFF appears as a **surrogate pair**: high `0xD800–0xDBFF`, low `0xDC00–0xDFFF`.

```
codepoint = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
```
e.g. `<D83DDE00>` → U+1F600 GRINNING FACE. A lone/unpaired surrogate is malformed — emit U+FFFD or drop it, and mark the code as unreliable for reverse mapping.

### 5.5 Complete parsing algorithm

```
function parseToUnicode(streamBytes) -> (codespaces, map<codeInt+len, string>):
    toks = tokenizePostScriptish(streamBytes)
        # tokens: HexString(bytes), LiteralString(bytes), Name, Number, '[' , ']',
        #         '<<', '>>', Operator(bareword). Comments '%'..EOL skipped.
    codespaces = []
    map = {}                      # key = (byteLen, codeInt)
    i = 0
    while i < len(toks):
        t = toks[i]
        if t is Operator "begincodespacerange":
            i += 1
            while i+1 < len(toks) and toks[i] is HexString and toks[i+1] is HexString:
                lo = toks[i].bytes; hi = toks[i+1].bytes; i += 2
                if len(lo) == len(hi) and 1 <= len(lo) <= 4:
                    codespaces.append({len: len(lo), lo: lo, hi: hi})
            # skip to 'endcodespacerange'
        elif t is Operator "beginbfchar":
            i += 1
            while i+1 < len(toks) and toks[i] is HexString:
                src = toks[i]; dst = toks[i+1]; i += 2
                if dst is HexString:      u = utf16beToString(dst.bytes)
                elif dst is Name:         u = aglToUnicode(dst.name)
                else: break               # 'endbfchar' or garbage
                map[(len(src.bytes), int_be(src.bytes))] = u
        elif t is Operator "beginbfrange":
            i += 1
            while i+2 < len(toks) and toks[i] is HexString and toks[i+1] is HexString:
                lo = toks[i].bytes; hi = toks[i+1].bytes; d = toks[i+2]; i += 3
                n    = len(lo)
                loV  = int_be(lo); hiV = int_be(hi)
                if hiV < loV: swap(loV, hiV)
                if d is Array:                                   # FORM B
                    for k in 0 .. min(hiV-loV, len(d.items)-1):
                        e = d.items[k]
                        if e is HexString: map[(n, loV+k)] = utf16beToString(e.bytes)
                        elif e is Name:    map[(n, loV+k)] = aglToUnicode(e.name)
                elif d is HexString:                             # FORM A
                    base = d.bytes
                    if len(base) >= 2:
                        prefixUnits = base[0 : len(base)-2]
                        lastUnit    = (base[-2] << 8) | base[-1]
                        for k in 0 .. (hiV - loV):
                            u16 = prefixUnits + be16(lastUnit + k)   # 16-bit carry
                            map[(n, loV+k)] = utf16beToString(u16)
                    else:   # 1-byte destination (malformed but seen)
                        for k in 0 .. (hiV - loV):
                            map[(n, loV+k)] = chr(base[0] + k)
                elif d is Name:
                    map[(n, loV)] = aglToUnicode(d.name)
                else: break
        else:
            i += 1
    if codespaces is empty:
        codespaces = [ {len: defaultCodeLen(font), lo: 0x00.., hi: 0xFF..} ]
    return (codespaces, map)
```

`utf16beToString(bytes)`: read big-endian 16-bit units, combine surrogate pairs, produce a Unicode string. Odd byte length → drop trailing byte and flag.

**Decoding a shown string to text:**

```
function extractText(font, bytes):
    (cs, tu) = font.toUnicode
    out = ""
    pos = 0
    while pos < len(bytes):
        (code, n) = nextCode(bytes, pos, cs); pos += n
        s = tu[(n, code)]
        if s == null: s = fallbackViaEncodingOrCMap(font, code)   # §6.4/6.5
        out += (s ?? U+FFFD)
    return out
```

### 5.6 Worked `/ToUnicode` example

Stream content:

```
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<01B4> <FB01>
<0F1E> <D83DDE00>
endbfchar
2 beginbfrange
<0024> <002D> <0041>
<0100> <0102> [ <0066006600690065> <00E9> <D835DC9C> ]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
```

Parse result (code length = 2 for every entry):

| Code | Unicode | Notes |
|---|---|---|
| `0x0003` | `U+0020` `" "` | bfchar |
| `0x01B4` | `U+FB01` `"ﬁ"` | bfchar, **ligature** |
| `0x0F1E` | `U+1F600` `"😀"` | bfchar, surrogate pair `D83D DE00` |
| `0x0024` | `U+0041` `"A"` | bfrange FORM A |
| `0x0025` | `U+0042` `"B"` | +1 |
| `0x0026` | `U+0043` `"C"` | +2 |
| `0x0027` | `U+0044` | |
| `0x0028` | `U+0045` | |
| `0x0029` | `U+0046` | |
| `0x002A` | `U+0047` | |
| `0x002B` | `U+0048` | |
| `0x002C` | `U+0049` | |
| `0x002D` | `U+004A` `"J"` | +9, end of range |
| `0x0100` | `"ffie"` (U+0066 U+0066 U+0069 U+0065) | bfrange FORM B, **4-char destination** |
| `0x0101` | `U+00E9` `"é"` | FORM B |
| `0x0102` | `U+1D49C` `"𝒜"` | FORM B, surrogate pair |

So the byte string `<0024 0025 01B4 0003 0F1E>` extracts as `"ABﬁ 😀"`.

---

## 6. THE KEY ALGORITHM — reverse map: Unicode string → byte codes

Goal: given a font dict and an edited Unicode string, produce the exact bytes that, shown with **that same font**, render the string — or a clear failure so the caller can embed a new font.

### 6.1 Build the forward map first, always

Never build the reverse map directly; build `code → unicodeString` and invert. This makes duplicate handling and "pick the lowest code" trivial and correct.

```
function buildForward(font) -> list of (codeBytes, codeInt, byteLen, unicodeString, source):
    entries = []
    if font.ToUnicode exists:
        (cs, tu) = parseToUnicode(font.ToUnicode)
        for ((n, code), s) in tu:
            entries.append((be(code, n), code, n, s, "ToUnicode"))
    if font is simple:
        enc = encodingMap(font)                       # §2.2
        for code in 0..255:
            name = enc[code]
            if name == null: continue
            s = aglToUnicode(name)                    # §6.3
            if s == null: continue
            entries.append((bytes([code]), code, 1, s, "Encoding"))
    else if font is Type0 and encoding CMap is non-Identity predefined:
        # code -> CID via the CMap; CID -> Unicode via the matching
        # Adobe-<Ordering>-UCS2 CMap resource, if you ship it.
        for (code, n, cid) in enumerateCMap(cmap):
            s = ucs2Cmap[cid]
            if s != null: entries.append((be(code,n), code, n, s, "PredefCMap"))
    return entries
```

`source` priority for conflicts: **ToUnicode > Encoding/AGL > predefined-CMap**. `/ToUnicode` is authoritative by spec.

### 6.2 Invert, with the rules

```
function buildReverse(entries) -> (exact: map<string, codeBytes>, maxKeyLen: int):
    # 1. Group by unicode string.
    byUnicode = {}
    for e in entries:
        if e.unicodeString == "" : continue
        if isUnusable(e): continue              # §6.6
        k = normalizeKey(e.unicodeString)
        prev = byUnicode.get(k)
        if prev == null: byUnicode[k] = e
        else:
            # DUPLICATE TARGET RULE: prefer higher-priority source; tie-break on
            # LOWEST numeric code (deterministic, matches "first"/base glyph in
            # nearly all subsets: base Latin sits below alternates/small-caps).
            if rank(e.source) < rank(prev.source)
               or (rank(e.source) == rank(prev.source) and e.codeInt < prev.codeInt):
                byUnicode[k] = e
    exact = { k: e.codeBytes for k, e in byUnicode }
    maxKeyLen = max(len(k) for k in exact) or 1
    return (exact, maxKeyLen)
```

`normalizeKey`: use the string **as-is** (no NFC/NFD folding) for the primary table; optionally build a *secondary* NFC-folded table as a fallback so that a `"é"` typed as U+0065 U+0301 can still find the precomposed code. Never let normalization collide two distinct exact keys.

**Multi-char destinations (ligatures).** These become multi-character keys (`"ffi"` → `0x01B4`). They must be matched by **greedy longest-first** scanning, or you will never use them:

```
function encodeString(text, exact, maxKeyLen) -> (bytes, failures):
    out = []; failures = []
    i = 0
    while i < len(text):
        matched = false
        for L in min(maxKeyLen, len(text) - i) down to 1:
            k = text[i : i+L]
            cb = exact.get(k)
            if cb != null:
                out.extend(cb); i += L; matched = true; break
        if not matched:
            # try NFC/NFD fallback table, then compatibility decomposition,
            # then per-codepoint substitution table (see 6.7)
            (cb, consumed) = fallbackLookup(text, i, exact)
            if cb != null: out.extend(cb); i += consumed
            else:
                failures.append((i, text[i])); i += 1
    return (bytes(out), failures)
```

**Is greedy ligature use safe?** Only if the ligature key is a *pure* rendering of those characters. `"ffi" → 0x01B4` (U+FB01 is actually "fi"; a 3-char "ffi" would be U+FB03) is fine visually. But greedy matching can be *wrong* when a ToUnicode destination is a multi-char string that is **not** a ligature — e.g. some producers map a single code to `"(c)"` or to a whole word. Safer policy: **only use multi-char keys of length 2–4 whose codepoints are all letters, or whose single-codepoint canonical form is in the U+FB00–U+FB4F / U+0132–U+0153 ligature blocks.** Otherwise mark multi-char entries as *decode-only* (usable for extraction, excluded from `exact`).

### 6.3 Glyph name → Unicode: the AGL algorithm

Needed for simple fonts without `/ToUnicode`. This is Adobe's normative algorithm ("Unicode and Glyph Names", TN #5098 / the AGL specification):

```
function aglToUnicode(name) -> string | null:
    # 0. Reject the obvious non-glyphs
    if name == ".notdef" or name == ".null" or name == "nonmarkingreturn": return null

    # 1. Drop everything from the FIRST period onward:  "a.sc" -> "a",  "one.oldstyle" -> "one"
    base = name.split(".")[0]
    if base == "": return null

    # 2. Split on "_" into components (ligature glyph names): "f_i" -> ["f","i"]
    result = ""
    for comp in base.split("_"):
        # 2a. AGL lookup (the "Adobe Glyph List for New Fonts" AGLFN, then the full AGL)
        if comp in AGL: result += AGL[comp]; continue
        # 2b. uniXXXX / uniXXXXYYYY...  (one or more 4-hex groups, uppercase hex)
        if regex_full(comp, "uni([0-9A-Fa-f]{4})+"):
            hexpart = comp[3:]
            ok = true; tmp = ""
            for j in 0, 4, 8, ... < len(hexpart):
                cp = int(hexpart[j:j+4], 16)
                if 0xD800 <= cp <= 0xDFFF: ok = false; break   # surrogates illegal here
                tmp += chr(cp)
            if ok: result += tmp; continue
        # 2c. uXXXX .. uXXXXXX  (4 to 6 hex digits, exactly one scalar)
        if regex_full(comp, "u[0-9A-Fa-f]{4,6}"):
            cp = int(comp[1:], 16)
            if cp <= 0x10FFFF and not (0xD800 <= cp <= 0xDFFF):
                result += chr(cp); continue
        # 2d. Non-normative but essential in practice:
        if regex_full(comp, "(g|G|cid|glyph|index)[0-9]+"): return null   # opaque index
        if regex_full(comp, "[Cc][0-9]+"):                   return null
        # 2e. Unknown component -> whole name unmapped
        return null
    return result != "" ? result : null
```

**Data files:** ship `glyphlist.txt` (the full AGL, ~4300 entries) for *forward* mapping, and `aglfn.txt` (the AGL For New Fonts, ~1100 entries) as the preferred source for *reverse* naming, since AGLFN is a function (one preferred name per codepoint). Also ship `zapfdingbats.txt` for ZapfDingbats' `aNN` names and the Symbol font's names (Symbol's names like `alpha`, `summation` are in the main AGL).

**Ambiguities in the forward direction** (harmless because you invert with "lowest code wins"): `Delta` and `increment` both → U+2206; `Omega`/`Ohm` → U+2126; `mu`/`mu1` → U+00B5 vs U+03BC; `space`, `spacehackarabic`, `nbspace` → U+0020; `hyphen`/`sfthyphen` → U+002D. Never build reverse maps from AGL directly — always invert the per-code forward map.

### 6.4 Simple font, full reverse procedure

```
function reverseSimple(font):
    entries = []
    if font.ToUnicode:                      # authoritative
        for ((n, code), s) in parseToUnicode(font.ToUnicode)[1]:
            if n == 1 and 0 <= code <= 255:
                entries.append(entry(code, 1, s, "ToUnicode"))
            elif n == 2:
                # malformed producer: 2-byte codes on a simple font.
                # If the high byte is always 0x00, treat low byte as the code.
                if (code >> 8) == 0: entries.append(entry(code & 0xFF, 1, s, "ToUnicode"))
    enc = encodingMap(font)
    for code in 0..255:
        if enc[code] == null: continue
        s = aglToUnicode(enc[code])
        if s: entries.append(entry(code, 1, s, "Encoding"))
    # restrict to codes that actually have a usable glyph:
    entries = [e for e in entries if hasGlyph(font, e.code)]        # §6.6
    return buildReverse(entries)
```

**Extending the code space.** For a simple font you additionally *may* legally add new codes to unused slots of `/Differences`, if — and only if — the embedded font program contains a glyph you can name. That is a font-surgery path, not a reverse-mapping path; treat it as a separate feature.

### 6.5 Type0 reverse procedure

```
function reverseType0(font):
    df = resolve(font.DescendantFonts[0])
    if font.ToUnicode:
        entries = [entry(code, n, s, "ToUnicode")
                   for ((n,code), s) in parseToUnicode(font.ToUnicode)[1]]
        entries = [e for e in entries if cidHasGlyph(font, df, e.code)]
        return buildReverse(entries)

    # No /ToUnicode:
    if encodingIsIdentity(font.Encoding):
        # code == CID; CID means nothing without the font program.
        if descendant program embedded and is CIDFontType2:
            # Recover code->unicode by INVERTING the embedded font's (3,1)/(3,10) cmap:
            #   unicode -> GID  (from cmap)
            #   GID     -> CID  (invert /CIDToGIDMap, or identity)
            #   CID     -> code (identity for Identity-H)
            # Subset fonts VERY often strip the cmap table -> this fails.
            if embedded cmap present: build entries from it
            else: return FAIL("Identity-H subset with no /ToUnicode and no cmap")
        else if CIDFontType0 with CID-keyed CFF and a known Registry/Ordering:
            # CID -> Unicode via Adobe-<Ordering>-UCS2 CMap resource
            build entries from that resource
        else:
            return FAIL("no usable code->Unicode path")
    else:
        # predefined non-Identity CMap: code -> CID via the CMap resource,
        # CID -> Unicode via Adobe-<Registry>-<Ordering>-UCS2.
        build entries from the two CMap resources, or FAIL if not shipped
```

### 6.6 When reverse mapping is UNSAFE — and how to detect it

Return a hard failure (caller must embed/subset a new font) on any of these:

| Condition | Detection |
|---|---|
| **Codepoint absent from the reverse map** | `encodeString` reports a non-empty `failures` list. This is the primary signal. |
| **Subset font missing the glyph** | `/BaseFont` matches `^[A-Z]{6}\+`. The code must additionally be *attested*: present in `/ToUnicode`, **and** (simple) inside `[FirstChar,LastChar]` with `Widths[code-FirstChar] != null`, or (Type0) present in `/W` or reachable via `/CIDToGIDMap` to a GID `< numGlyphs`. If you can parse the embedded program, verify `loca[gid+1] > loca[gid]` (TrueType, nonzero contours) or a non-`.notdef` CFF charstring. A composite glyph with zero contours is legitimate only for space-like glyphs. |
| **`.notdef` / null glyph** | Glyph name is `.notdef`/`.null`; or Type0 `CID → GID == 0` (and CID ≠ 0); or `aglToUnicode` returned null. Exclude such codes from `exact` entirely. |
| **Multi-char ToUnicode destination** | `len(unicodeString) > 1`. Usable for *extraction* always; usable for *re-encoding* only under the ligature whitelist of §6.2. Never emit a ligature code when the user's edit splits it (e.g. they typed `f` then `x` where the original had `ﬁ`). |
| **Duplicate targets** | Two codes with the same Unicode (small-caps vs base, alternates, `.sc`/`.alt` suffixed names). Lowest-code rule is a heuristic; the visual result may differ from the original run. **Prefer the code that already occurs in the original string being edited** — pass the original codes in as a hint and let them win over the lowest-code rule. |
| **Unpaired surrogate / U+FFFD in destination** | Malformed `/ToUnicode`; drop the entry. |
| **Symbolic TrueType with no `/ToUnicode`** | `Flags & 0x04` and no `/ToUnicode`. Codes are opaque PUA/`(3,0)` indices; AGL-derived Unicode is meaningless. FAIL. |
| **Type3** | Glyph appearance is arbitrary PostScript; `/Differences` names may be invented (`/g1`, `/a`, `/shape`). Only usable if `/ToUnicode` is present. |
| **Non-Identity predefined CMap without the Adobe resource files** | FAIL. |
| **Missing width for a needed code** | Even if the code maps, if you cannot compute its width you cannot re-lay-out. Simple font: width falls through to `/MissingWidth` (suspicious if 0). Type0: CID not in `/W` and `/DW` absent → 1000 assumed; acceptable but flag. |
| **`/Encoding` dict on a Type0** hmm — `/Encoding` on Type0 must be a CMap; a base-encoding-style dict is malformed | Reject. |

**Return shape.** Give the caller a structured result, not an exception:

```
{ ok: bool,
  bytes: byte[],                     # valid only if ok
  unmapped: [ {index, char, reason} ],
  warnings: [ "ligature-split", "duplicate-target", "width-defaulted", ... ],
  codeSize: 1 | 2,
  widths: [ int ]                    # per emitted code, 1/1000 units, for re-layout
}
```

The caller's fallback: if `unmapped` is non-empty, either (a) restrict the edit to the mappable prefix, or (b) create a **new** font resource (embed + subset a font covering the full string), append it to the page's `/Resources /Font` under a fresh name, and emit a `Tf` for it.

### 6.7 Sensible fallbacks before declaring failure

Apply in order, each only if the previous fails:

1. Exact key match (greedy longest).
2. NFC of the input segment.
3. NFD of the input segment (then match each combining piece — usually fails, but precomposed→decomposed sometimes works for fonts with combining marks).
4. Compatibility folds for typography: `U+00A0 → U+0020`, `U+2011 → U+2010 → U+002D`, `U+2018/U+2019 → U+0027`, `U+201C/U+201D → U+0022`, `U+2013/U+2014 → U+002D`, `U+2026 → "..."`, `U+00AD → ""` (drop), `U+200B/U+FEFF → ""` (drop), `U+2212 → U+002D`.
5. Ligature *expansion*: if `"ﬁ"` (U+FB01) is unmapped but `f` and `i` are, emit both codes.
6. Otherwise: unmapped.

Every substitution beyond step 2 must be recorded in `warnings` — it changes the rendered glyphs.

---

## 7. Writing the bytes back into a content stream

### 7.1 Code → bytes

* **Simple font (Type1/TrueType/Type3/MMType1):** exactly **one byte per code**, value 0–255. No shortcuts, no UTF-8.
* **Type0 with `/Identity-H` or `/Identity-V`:** exactly **two bytes per CID, big-endian**: `[cid >> 8, cid & 0xFF]`.
* **Type0 with any other CMap:** emit the byte sequence whose length and value the CMap's codespace ranges define for that code. You must round-trip through the CMap, not assume 2 bytes.

### 7.2 String syntax in the content stream (§7.3.4)

**Literal string `( ... )`** — the parser reads raw bytes with these escapes:

| Escape | Byte |
|---|---|
| `\n` | 0x0A |
| `\r` | 0x0D |
| `\t` | 0x09 |
| `\b` | 0x08 |
| `\f` | 0x0C |
| `\(` | `(` |
| `\)` | `)` |
| `\\` | `\` |
| `\ddd` | octal, 1–3 digits, value mod 256 |
| `\` + EOL | line continuation, produces nothing |

Additional hazards:
* **Unbalanced parentheses must be escaped.** Balanced pairs may be left unescaped, but never rely on it — escape every `(` and `)`.
* **An end-of-line inside a literal string is normalised to a single 0x0A** by the parser. A raw 0x0D byte therefore becomes 0x0A; a raw 0x0D 0x0A becomes a single 0x0A. This **silently corrupts binary codes**.
* A backslash before any other character: the backslash is ignored and the character passes through.

Minimal safe literal-escaping if you must use `( )`:

```
for b in bytes:
    if b in (0x28, 0x29, 0x5C):  out += "\\" + chr(b)          # ( ) \
    elif b < 32 or b > 126:      out += "\\%03o" % b           # always 3 octal digits
    else:                        out += chr(b)
```

**Hex string `< ... >`** — the parser reads pairs of hex digits; whitespace between digits is ignored; **an odd final digit is treated as if followed by `0`** (`<41F>` == `<41F0>`).

**Use hex strings.** Reasons:
1. No escaping, no `\ddd` off-by-one, no `(`/`)` balancing.
2. **Immune to EOL normalisation** — 0x0D and 0x0A survive intact. For Identity-H this is critical: CID 0x0D0A would be destroyed inside a literal string.
3. Byte-count is self-evident and even, which matches 2-byte codes exactly.
4. Trivially safe to line-wrap for readability (whitespace is ignored inside `<>`).
5. Producers and consumers universally handle them.

The only cost is 2× size (mitigated by stream compression).

### 7.3 Emitting the operators

```
# Simple font, codes [0x48, 0x65, 0x6C, 0x6C, 0x6F]:
/F1 12 Tf
<48656C6C6F> Tj

# Identity-H, CIDs [0x0024, 0x0044, 0x01B4]:
/F2 12 Tf
<002400440 1B4> Tj            # whitespace inside <> is legal but avoid it:
<00240044 01B4> Tj

# With per-glyph kerning (TJ numbers are thousandths of a text-space unit,
# SUBTRACTED from the displacement -> positive = move LEFT/closer):
[ <0024> -35 <0044> 0 <01B4> ] TJ

# Other show operators:
#   '   == T*  then  Tj
#   "   == aw ac string "   ==  set Tw=aw, Tc=ac, T*, Tj
```

If you replace a `"` operator's string, remember it also sets `Tw`/`Tc`; the safest rewrite is `aw Tw ac Tc T* <hex> Tj`.

### 7.4 Re-layout after re-encoding

```
advance(codes) = sum over codes of:
    ((w0_i) * Tfs + Tc + (isSingleByte32(code_i) ? Tw : 0)) * Th
```
where `w0_i = width1000_i / 1000` (or the Type3 FontMatrix transform). Use this to (a) verify the replacement fits the original box, and (b) synthesise a `TJ` adjustment or a `Tz`/`Tc` tweak if you must force-fit.

**Type0 caveat again:** `Tw` silently stops applying when you move from 1-byte to 2-byte codes. If the original run had `Tw != 0` and you convert to Identity-H, you must fold the word spacing into explicit `TJ` adjustments after each space CID.

---

## 8. Vertical writing: `/DW2` and `/W2` (§9.7.4.3)

Active when the `/Encoding` CMap has `WMode 1` (`/Identity-V`, `*-V`, or an embedded CMap with `/WMode 1`).

**`/DW2`** — array of two numbers, **default `[880 -1000]`**:
* `DW2[0]` = `vy`, the **y** component of the default position vector `v` (the vector from the glyph's horizontal origin to its vertical origin), in 1/1000 units. The x component is always `w0/2` (half the *horizontal* width) by default.
* `DW2[1]` = `w1y`, the default vertical displacement (negative = downward). `-1000` = one em down.

**`/W2`** — same two shapes as `/W`, but **three numbers per CID**:

```
FORM 1:  c  [ w1y_1 vx_1 vy_1   w1y_2 vx_2 vy_2   ... ]     % 3 numbers per CID, starting at c
FORM 2:  cFirst cLast  w1y vx vy                            % same triple for the whole range
```

Parsing pseudocode:

```
function parseW2(W2array) -> map<CID, (w1y, vx, vy)>:
    out = {}; i = 0; A = resolve(W2array)
    while i < len(A):
        first = int(resolve(A[i])); i += 1
        nxt = resolve(A[i])
        if nxt is Array:
            i += 1
            for k in 0 .. len(nxt)/3 - 1:
                out[first + k] = (num(nxt[3*k]), num(nxt[3*k+1]), num(nxt[3*k+2]))
        else:
            last = int(nxt); i += 1
            t = (num(resolve(A[i])), num(resolve(A[i+1])), num(resolve(A[i+2]))); i += 3
            for c in first..last: out[c] = t
    return out

function vmetrics(df, cid, w0):
    t = W2map.get(cid)
    if t: return (w1y=t[0], vx=t[1], vy=t[2])
    dw2 = df.DW2 ?? [880, -1000]
    return (w1y=dw2[1], vx=w0/2, vy=dw2[0])
```

Rendering: the glyph is positioned by translating by `-v` before painting, then the text matrix advances by `ty = (w1y/1000 - Tj/1000)*Tfs + Tc + Tw`. `tx = 0`.

Reverse-mapping and widths otherwise proceed identically; `/W`/`/DW` still supply `w0`, which you need for the default `vx`.

---

## 9. Quick-reference decision tree

```
font.Subtype?
├─ Type0
│   ├─ cmap = Encoding (predefined name | stream)
│   ├─ decode bytes via cmap.codespaceRanges  -> codes
│   ├─ cid = cmap.toCID(code)                 (Identity-H: cid == code)
│   ├─ width = W[cid] ?? DW ?? 1000           (1/1000 text space)
│   ├─ glyph = CIDFontType2 ? CIDToGIDMap[cid] : CFFcharset⁻¹[cid]
│   └─ text  = ToUnicode[(n, code)]           (REQUIRED for safe reverse mapping)
├─ Type3
│   ├─ 1 byte per code
│   ├─ width = FontMatrix ⊗ (Widths[code-FirstChar], 0)   -> text space directly
│   └─ text  = ToUnicode only; /Differences names are arbitrary
└─ Type1 | MMType1 | TrueType
    ├─ 1 byte per code
    ├─ width = Widths[code-FirstChar] / 1000
    │          ?? MissingWidth / 1000
    │          ?? AFM(standard14)[glyphName] / 1000
    ├─ glyphName = Differences > BaseEncoding > builtin > StandardEncoding
    │              (symbolic TrueType: no names — (3,0) cmap on code, then 0xF000|code)
    └─ text  = ToUnicode  >  AGL(glyphName)
```

**Reverse (Unicode → bytes), in one line:** build `code → unicode` from `/ToUnicode` (falling back to `/Encoding` + AGL for simple fonts), drop codes whose glyph is `.notdef`/absent-from-subset, invert with *highest-priority-source then lowest-code* wins, match the input greedily longest-first, emit 1 byte per code for simple fonts and 2 big-endian bytes per CID for Identity-H, wrap in a **hex string** `<...>`, and hard-fail the whole edit the moment any input codepoint has no entry — that failure is the signal to embed a new font instead.