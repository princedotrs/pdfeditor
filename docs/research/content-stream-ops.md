# PDF Content-Stream Text Operators — Implementation Reference
**Normative base: ISO 32000-1:2008 (PDF 1.7), clauses 7.2, 7.3, 8.4, 8.9.7, 9.2–9.4, 9.6, 9.7. Deltas for ISO 32000-2 (PDF 2.0) called out inline.**

---

## 0. Coordinate & matrix conventions used throughout

PDF uses **row vectors** and **row-major 3×2 matrices**. The 6-tuple `[a b c d e f]` denotes

```
        | a  b  0 |
  M  =  | c  d  0 |
        | e  f  1 |
```

A point transforms as `[x' y' 1] = [x y 1] × M`, i.e.

```
  x' = a·x + c·y + e
  y' = b·x + d·y + f
```

**Composition `M = M1 × M2` (apply M1 first, then M2):**

```
  a = a1·a2 + b1·c2
  b = a1·b2 + b1·d2
  c = c1·a2 + d1·c2
  d = c1·b2 + d1·d2
  e = e1·a2 + f1·c2 + e2
  f = e1·b2 + f1·d2 + f2
```

Identity = `[1 0 0 1 0 0]`. Translation `T(tx,ty)` = `[1 0 0 1 tx ty]`.

Every "premultiply" below means `M_new = A × M_old` in exactly this sense.

---

## 1. Full token grammar of a content stream

### 1.1 Character classes (ISO 32000-1 §7.2.2, Tables 1–2)

**White-space bytes (6):**

| Byte | Name |
|---|---|
| `0x00` | NUL |
| `0x09` | HT (tab) |
| `0x0A` | LF |
| `0x0C` | FF |
| `0x0D` | CR |
| `0x20` | SP |

**Delimiter bytes (9):** `(` 0x28, `)` 0x29, `<` 0x3C, `>` 0x3E, `[` 0x5B, `]` 0x5D, `{` 0x7B, `}` 0x7D, `/` 0x2F, `%` 0x25.

**Regular bytes:** everything else (all bytes not white-space and not delimiter, including all bytes ≥ 0x80).

A token ends at the first delimiter or white-space byte. `{` and `}` are delimiters but are **not** legal in content streams (they appear only in Type 4 PostScript calculator function streams); a lexer must still terminate tokens on them and should report/skip them.

### 1.2 Comments

`%` outside a string or inline-image data starts a comment that runs to the next EOL (`CR`, `LF`, or `CRLF`). A comment is lexically equivalent to a single white-space byte. `%` inside a literal string, hex string, or inline-image binary data is **data, not a comment**.

### 1.3 Numbers (§7.3.2, §7.3.3)

```
integer := [+-]? DIGIT+
real    := [+-]? ( DIGIT* '.' DIGIT* | DIGIT+ )      ; at least one digit total
```

Legal forms: `34`, `-17`, `+42`, `34.5`, `-.002`, `4.`, `0.0`, `+.1`. `4.` = 4.0, `.5` = 0.5, `-.002` = −0.002.

- **No exponent notation** is conforming. Real-world producers occasionally emit `1e-5` or `6.02E23`; a tolerant lexer should accept it, a strict one must reject.
- Broken producers emit `--5`, `- 5`, `6.-2`, `.-3`. Recommended tolerant rule: consume `[+-]*`, then digits/`.`; on a second `.` stop the token. Map unparseable numeric-looking tokens to `0` rather than aborting.
- Implementation limits (Annex C.1): integers ±2 147 483 647; reals ≈ ±3.403×10³⁸ with ~5 decimal digits of precision. **Internally use IEEE double; never float.**

### 1.4 Names (§7.3.5)

```
name := '/' regular_byte*
```

`/` alone is the legal **empty name**. Inside a name, `#` followed by **exactly two** hexadecimal digits denotes that byte: `/A#42` → `AB`, `/Adobe#20Green` → `Adobe Green`, `/paired#28#29parentheses` → `paired()parentheses`, `/#2F` → `/`.

Rules:
- `#00` is prohibited (§7.3.5).
- `#` not followed by two valid hex digits is malformed. Acrobat treats the `#` literally; recommended: emit the `#` verbatim and continue.
- Bytes outside `0x21`–`0x7E` *should* be written `#xx`, but a raw high byte is a regular byte and lexes fine — accept it.
- Names are byte strings, compared byte-for-byte **after** `#xx` decoding.
- Acrobat's implementation limit is 127 bytes; do not enforce it when reading.

### 1.5 Literal strings `( … )` (§7.3.4.2, Table 3)

Delimited by balanced `(` and `)`. **Unescaped parentheses may nest and must be balanced**; the lexer maintains a depth counter, starting at 1 after the opening `(`, incrementing on unescaped `(`, decrementing on unescaped `)`, and terminating when it reaches 0.

Escape sequences:

| Sequence | Produces |
|---|---|
| `\n` | 0x0A LF |
| `\r` | 0x0D CR |
| `\t` | 0x09 HT |
| `\b` | 0x08 BS |
| `\f` | 0x0C FF |
| `\(` | 0x28 `(` |
| `\)` | 0x29 `)` |
| `\\` | 0x5C `\` |
| `\ddd` | byte with octal value `ddd` |
| `\` + EOL | **nothing** (line continuation; the backslash and the EOL are both discarded) |
| `\` + any other byte | that byte, **backslash discarded** (`\q` → `q`) |

`\ddd` rules: one, two, or three octal digits. Fewer than three is legal if the next byte is not an octal digit — `\53` is `+` (0x2B), but in `\0053` the parse takes `005` then a literal `3`. **High-order overflow is ignored**, i.e. the value is taken mod 256: `\400` → 0x00. Always write three digits when generating.

**Raw EOL inside a literal string** (not preceded by `\`) is normalized: a bare `CR`, a bare `LF`, or a `CRLF` pair each become **a single 0x0A byte** in the string value. This is easy to get wrong — a CRLF is *one* byte in the result, not two.

`()` is the empty string, legal, and shows no glyphs.

### 1.6 Hex strings `< … >` (§7.3.4.3)

```
hexstring := '<' ( HEXDIGIT | whitespace )* '>'
```

White space between hex digits is ignored. Digit pairs form bytes, MSB first. **An odd final digit is padded with a trailing `0`**: `<901FA>` → `0x90 0x1F 0xA0`. `<>` is the empty string. Non-hex, non-whitespace bytes are a syntax error; Acrobat skips them — recommended: skip and continue.

Lexer note: on seeing `<`, **peek the next byte**. `<<` is the dictionary-open token; a single `<` starts a hex string.

### 1.7 Arrays, dictionaries, booleans, null

- `[` … `]` — array. Elements are any objects, heterogeneous. Nesting allowed.
- `<<` … `>>` — dictionary. Alternating key (must be a name) / value. Only appears in content streams as an operand to `BDC`, `DP`, `gs` (rare — normally a name), and as the inline-image parameter list *without* the `<< >>` wrapper.
- `true`, `false` — booleans. Lexically they are regular-character token sequences; the tokenizer must classify them as operands, **not** operators.
- `null` — the null object; same classification rule.

### 1.8 Operators

Any regular-character token that is not a number and not `true`/`false`/`null` is an **operator**. Note that `'` (0x27) and `"` (0x22) are regular bytes and are therefore valid one-byte operator tokens.

**Execution model (§7.8.2):** operands accumulate on an operand list; an operator consumes them. A conforming reader:
- takes the **last n** operands if too many were supplied,
- on error (too few / wrong type), skips the operator,
- **clears the operand list after every operator**, error or not.

`BX` … `EX` (§8.2, §7.8.2) delimit a region where unrecognized operators shall be ignored silently rather than reported. Track nesting depth.

### 1.9 Multi-part content streams

A page's `/Contents` may be an array of streams. They are concatenated **with at least one white-space byte inserted between consecutive streams**, and the division "shall occur only at lexical token boundaries" — no token, string, or inline image may span the split. When editing, you may therefore rewrite a single part in isolation, but you must not assume a `BT` in part *k* is closed by an `ET` in part *k*.

### 1.10 Inline images: `BI … ID <binary> EI` (§8.9.7)

```
BI
  /W 32 /H 32 /BPC 8 /CS /RGB /F /Fl
ID <binary bytes>
EI
```

The parameter list between `BI` and `ID` is a sequence of key/value pairs **without** `<<`/`>>`. Parse objects until the `ID` operator token is reached.

**Abbreviated keys (Table 93):**

| Abbrev | Full | Abbrev | Full |
|---|---|---|---|
| `/BPC` | `/BitsPerComponent` | `/H` | `/Height` |
| `/CS` | `/ColorSpace` | `/I` | `/Interpolate` |
| `/D` | `/Decode` | `/IM` | `/ImageMask` |
| `/DP` | `/DecodeParms` | `/W` | `/Width` |
| `/F` | `/Filter` | `/L` | `/Length` (PDF 2.0) |

**Abbreviated colour space names (Table 94):** `/G`→DeviceGray, `/RGB`→DeviceRGB, `/CMYK`→DeviceCMYK, `/I`→Indexed. (`/I` is ambiguous with `/Interpolate` — disambiguated by position: as a *key* it is Interpolate, as a *value* of `/CS` it is Indexed.)

**Abbreviated filter names (Table 95):** `/AHx`→ASCIIHexDecode, `/A85`→ASCII85Decode, `/LZW`→LZWDecode, `/Fl`→FlateDecode, `/RL`→RunLengthDecode, `/CCF`→CCITTFaxDecode, `/DCT`→DCTDecode.

**Start of data:** `ID` shall be followed by **exactly one** white-space byte; the byte immediately after it is the first byte of image data. (Exception in practice: when the filter chain is ASCII-based, leading white space is harmless and some producers emit `\r\n`. Rule: consume one white-space byte; if the filter is `AHx`/`A85`, consuming additional white space is also safe.)

Inline images **shall not** appear inside a text object (`BT`…`ET`).

### 1.11 The exact rule for finding `EI` safely

Binary image data will contain the byte pair `E` `I` by chance. Never scan naively. Use this cascade — take the **first tier that applies**:

**Tier 1 — explicit length.** If the parameter dictionary has `/L` (or `/Length`) with an integer value *L* (PDF 2.0; also emitted by some PDF 1.x producers as an extension): data is exactly the next *L* bytes. Then skip white space and require the token `EI`. If `EI` is not there, fall through to Tier 3.

**Tier 2 — unfiltered data, computable length.** If `/F`/`/Filter` is absent or an empty array, the length is exact:

```
if IM (ImageMask) is true:  ncomp = 1 ; bpc = 1
else:
  bpc   = BPC
  ncomp = 1  for DeviceGray, CalGray, Separation, Indexed
        = 3  for DeviceRGB, CalRGB, Lab
        = 4  for DeviceCMYK
        = N  for ICCBased (/N)
        = n  for DeviceN (length of the names array)

rowBytes = (W * ncomp * bpc + 7) / 8          # integer division; rows are byte-aligned
dataLen  = rowBytes * H
```

Consume `dataLen` bytes, skip white space, require `EI`. If the token there is not `EI`, fall through to Tier 3 (defensive: a wrong `/CS` resolution or a nonstandard colour space breaks the arithmetic).

**Tier 3 — validated scan.** Scan forward from the data start for every offset *p* where `bytes[p] == 'E' && bytes[p+1] == 'I'`. Accept *p* only if **all** of these hold:

1. `p > dataStart` and `bytes[p-1]` is one of the six PDF white-space bytes.
2. `p+2 == streamEnd`, **or** `bytes[p+2]` is a white-space byte or a delimiter byte.
3. **Filter-specific validation** of the candidate payload `bytes[dataStart .. p-2]` (dropping the single white-space byte before `EI`):
   - `AHx`: every byte is a hex digit, white space, or the terminating `>`.
   - `A85`: every byte is in `!`..`u`, or `z`, or white space; the payload ends with `~>`.
   - `Fl` / `LZW`: the decoder runs to completion without error **and** yields ≥ `rowBytes * H` bytes when that is computable.
   - `DCT`: payload starts `FF D8` and its last two non-whitespace bytes are `FF D9`.
   - `RL`: run-length decoding consumes the payload exactly and hits the EOD byte `128` precisely at the end.
   - `CCF` / unknown: skip to check 4 only.
4. **Token lookahead.** Starting at `p+2`, the next ~20 non-white-space bytes must lex cleanly as content-stream tokens (numbers / names / strings / known-shaped operators) with no unbalanced string and no byte that cannot begin a token. This alone eliminates the overwhelming majority of false positives.

Take the **first** *p* satisfying all four. If none does, relax in this order: (i) drop check 3, (ii) drop check 1 (some producers emit `…dataEI` with no separator), (iii) take the last `EI` before the next `BI`/end of stream and log a warning.

**Never** apply the naive rule "first occurrence of `EI`", and never apply the naive rule "first occurrence of white-space + `EI` + white-space" without at least the token lookahead — both are known to truncate real-world Flate and DCT images.

### 1.12 Reference tokenizer skeleton

```
loop:
  skip whitespace
  if EOF: done
  b = peek()
  if b == '%'        : skip to EOL; continue
  if b == '/'        : emit NAME(readName())
  elif b == '('      : emit STRING(readLiteralString())
  elif b == '<'      : if peek(1)=='<' { consume 2; emit DICT_OPEN }
                       else emit STRING(readHexString())
  elif b == '>'      : require peek(1)=='>' ; consume 2; emit DICT_CLOSE
  elif b == '['      : consume; emit ARRAY_OPEN
  elif b == ']'      : consume; emit ARRAY_CLOSE
  elif b in '+-.0-9' : emit NUMBER(readNumber())
  elif b in '{}'     : consume; emit ERROR_DELIM
  else               : t = readRegularRun()
                       if t=="true"/"false" : emit BOOL
                       elif t=="null"       : emit NULL
                       elif t=="BI"         : emit INLINE_IMAGE(readInlineImage())
                       else                 : emit OPERATOR(t)
```

---

## 2. Graphics state and text state

### 2.1 Special graphics-state operators

| Op | Operands | Effect |
|---|---|---|
| `q` | — | Push a **copy** of the entire graphics state onto the graphics state stack. |
| `Q` | — | Pop; restore the entire graphics state. |
| `cm` | `a b c d e f` | `CTM ← [a b c d e f] × CTM` (premultiply: the new matrix applies **before** the existing CTM). |

**What `q`/`Q` save and restore:** the CTM, clipping path, colour space and colour, line width/cap/join/miter/dash, rendering intent, flatness, smoothness, stroke/fill alpha, blend mode, soft mask — **and the entire text state**: `Tc`, `Tw`, `Th` (from `Tz`), `Tl` (from `TL`), the font and size (from `Tf`), `Tmode` (from `Tr`), `Trise` (from `Ts`), and `Tk` (knockout, set via ExtGState `/TK`).

**What `q`/`Q` do NOT save:** `Tm` and `Tlm`. These are **not** graphics-state parameters (§9.4.1 — they are properties of the *text object*). They exist only between `BT` and `ET`.

**Conformance constraint (§8.2, Figure 9 / Table 31):** `q`, `Q`, `cm`, path construction/painting, `Do`, `sh`, and inline images **shall not** appear inside a text object. The operators permitted between `BT` and `ET` are: general graphics state (`w J j M d ri i gs`), colour (`CS cs SC SCN sc scn G g RG rg K k`), text state (`Tc Tw Tz TL Tf Tr Ts`), text positioning (`Td TD Tm T*`), text showing (`Tj TJ ' "`), marked content (`MP DP BMC BDC EMC`), Type 3 (`d0 d1`), and `BX`/`EX`. Most viewers tolerate `q`/`Q` inside `BT`…`ET`, but **do not emit it** — see §7(c).

`gs` (ExtGState) can also set text state: `/Font [fontRef size]` sets `Tf`/`Tfs`; `/TK` sets knockout.

### 2.2 Text object delimiters

| Op | Effect |
|---|---|
| `BT` | Begin text object. **`Tm ← Identity`, `Tlm ← Identity`.** Nothing else is reset. |
| `ET` | End text object. `Tm`/`Tlm` become undefined. If any glyph in this object used render mode 4–7, **the accumulated glyph outlines become the current clipping path now** (intersected with the existing clip). |

Text objects **shall not be nested**.

**`BT` explicitly does NOT reset:** `Tf`/`Tfs`, `Tc`, `Tw`, `Tz`, `TL`, `Ts`, `Tr`, `Tk`, colour, CTM, or anything else. A file may legally do `12 TL` before `BT` and rely on it inside.

### 2.3 Text state operators (§9.3, Table 105)

| Op | Operands | Parameter | Initial value | Units / semantics |
|---|---|---|---|---|
| `Tc` | `charSpace` | `Tc` | 0 | Unscaled text-space units. Added to every glyph's advance. May be negative. |
| `Tw` | `wordSpace` | `Tw` | 0 | Unscaled text-space units. Added **only** for single-byte code 32 — see §4.2. May be negative. |
| `Tz` | `scale` | `Th = scale/100` | 100 (⇒ Th = 1) | **Percent.** Horizontal scaling. `100 Tz` ⇒ Th = 1.0. Negative legal (mirrors). |
| `TL` | `leading` | `Tl` | 0 | Unscaled text-space units. Vertical distance between baselines. **Positive `TL` moves subsequent lines DOWN** (see `T*`). |
| `Tf` | `fontName size` | `Tf`, `Tfs` | none / none | `fontName` is a key in the resource dictionary's `/Font` subdictionary. `size` may be negative (flips glyphs) or 0 (glyphs vanish but advances become 0 too). **There is no default font — a show operator before any `Tf` is an error.** |
| `Tr` | `render` | `Tmode` | 0 | Integer 0–7. See §8. |
| `Ts` | `rise` | `Trise` | 0 | Unscaled text-space units. Positive = superscript (up), negative = subscript. Enters the font matrix as the `f` translation. |

All seven are graphics-state parameters, saved/restored by `q`/`Q`, and **persistent across `BT`/`ET`**.

### 2.4 Text positioning operators (§9.4.2, Table 108)

| Op | Operands | Exact effect |
|---|---|---|
| `Td` | `tx ty` | `Tlm ← [1 0 0 1 tx ty] × Tlm` ; then `Tm ← Tlm` |
| `TD` | `tx ty` | Exactly equivalent to `-ty TL` followed by `tx ty Td`. **Sets `Tl ← −ty` as a side effect.** |
| `Tm` | `a b c d e f` | `Tm ← Tlm ← [a b c d e f]` — **absolute replacement, not a concatenation.** |
| `T*` | — | Exactly equivalent to `0 -Tl Td`, i.e. `Tlm ← [1 0 0 1 0 −Tl] × Tlm ; Tm ← Tlm`. |

Critical properties:

1. **Every one of these sets `Tm` from `Tlm`.** Any glyph advance accumulated in `Tm` since the last positioning operator is *discarded*.
2. **`Td`/`T*` operands are in unscaled text space** — they are **not** multiplied by `Th`, `Tfs`, `Tc`, or `Tw`. They are translated in the space that `Tlm` maps *from*.
3. **`Tm` is the only way to introduce rotation, skew, or scale into text placement**, and it is the only positioning operator that is absolute.
4. There is **no operator that sets `Tm` without also setting `Tlm`.** `Tm` and `Tlm` can diverge *only* through text-showing operators. This single fact drives all of §7.

---

## 3. Text-showing operators (§9.4.3, Table 109)

| Op | Operands | Semantics |
|---|---|---|
| `Tj` | `string` | Show `string`. Updates `Tm` glyph by glyph. **Does not touch `Tlm`.** |
| `TJ` | `array` | Array elements are strings and numbers, in any order and any count. Strings are shown; numbers adjust the position (§4.3). **Does not touch `Tlm`.** |
| `'` | `string` | **Exactly equivalent to `T*` then `string Tj`.** So: `Tlm ← T(0,−Tl) × Tlm ; Tm ← Tlm ; show`. |
| `"` | `aw ac string` | **Exactly equivalent to `aw Tw`, `ac Tc`, then `string '`** — i.e. `Tw ← aw`, `Tc ← ac`, `T*`, `string Tj`. |

**The `"` side effects are permanent.** `Tw` and `Tc` are written into the text state and remain in force for all subsequent showing until changed again or restored by `Q`. This is the single most-missed detail about `"`. Operand order is `aw` (word spacing) then `ac` (char spacing) then the string.

`'` and `"` perform their line advance **before** showing, and the new `Tw`/`Tc` from `"` apply **to the string being shown by that same operator**.

Showing an empty string (`() Tj`, `<> Tj`) is legal and produces no advance. `[] TJ` is legal and produces no advance. `[ -250 ] TJ` — an array with only a number — is legal and produces an advance with no glyphs.

Type 3 fonts add `d0` (`wx wy d0`) and `d1` (`wx wy llx lly urx ury d1`) inside the glyph procedure; `d1` additionally declares the glyph is a shape-only mask and colour operators in it shall be ignored.

---

## 4. The glyph displacement formula (§9.4.4)

### 4.1 The formula

**Horizontal writing mode (WMode = 0):**

```
  tx = ( ( w0 − Tj/1000 ) · Tfs  +  Tc  +  Tw ) · Th
  ty = 0
```

**Vertical writing mode (WMode = 1):**

```
  tx = 0
  ty = ( w1 − Tj/1000 ) · Tfs  +  Tc  +  Tw
```

**Note: `Th` does not appear in the vertical formula.** Horizontal scaling never affects vertical advances.

After each glyph (and after each `TJ` number element), the text matrix is updated by **premultiplied translation**:

```
  Tm ← [1 0 0 1 tx ty] × Tm
```

which, written out, is `Tm.e += tx·Tm.a + ty·Tm.c ; Tm.f += tx·Tm.b + ty·Tm.d`. `Tm.a`–`Tm.d` are unchanged.

Symbols:
- `Tfs` — font size from `Tf`.
- `Tc` — character spacing. **Not** multiplied by `Tfs`.
- `Tw` — word spacing, applied only per §4.2. **Not** multiplied by `Tfs`.
- `Th` — horizontal scale = `Tz/100`.
- `Tj` — the adjustment number from a `TJ` array element; **0** for `Tj`, `'`, `"`, and for every string element of a `TJ` array.
- `w0`, `w1` — the glyph's horizontal / vertical displacement **in text space** (§4.4).

`Tc`, `Tw`, and `Tj/1000` are all in **unscaled text space units**, meaning they are *not* transformed by the font matrix. For Type 3 fonts with an unusual `FontMatrix` this is a real distinction: `w0` goes through `FontMatrix`, `Tc`/`Tw`/`Tj` do not.

### 4.2 When `Tw` applies — the exact rule (§9.3.3)

> Word spacing shall be applied to every occurrence of the **single-byte character code 32** in a string when using a simple font or a composite font that defines code 32 as a single-byte code. **It shall not apply to occurrences of the byte value 32 in multiple-byte codes.**

Operationally:

| Font situation | `Tw` applies to code 32? |
|---|---|
| Simple font (Type1, TrueType, Type3, MMType1) — always 1-byte codes | **Yes**, for every byte equal to 0x20 |
| Composite font, CMap where 0x20 falls in a **1-byte codespace range** and decodes as a 1-byte code | **Yes** |
| Composite font with `Identity-H`/`Identity-V` (all codes 2 bytes) | **Never** — even for the 2-byte code `0x0020` |
| Composite font, any 2/3/4-byte code that happens to contain a 0x20 byte | **Never** |

Additional exactness:
- The rule is about the **code**, not the glyph. If code 32 maps to a non-space glyph, `Tw` still applies.
- The rule is about the code, not whether the font even has a glyph for it. `.notdef` at code 32 still gets `Tw`.
- Determination is made **during CMap decoding**, before CID lookup. Your decoder must return, per code, the tuple `(code_value, code_byte_length)`; apply `Tw` iff `code_byte_length == 1 && code_value == 32`.
- `Tw` is added **once per such code**, not once per byte.

This is the classic Identity-H text-extraction bug: an extractor that adds `Tw` for 2-byte code 0x0020 produces spurious drift.

### 4.3 `TJ` array sign convention (§9.4.3)

For a number element `n` in a `TJ` array, no glyph is drawn and:

```
  horizontal:  tx = ( − n/1000 ) · Tfs · Th
  vertical:    ty = ( − n/1000 ) · Tfs
```

`Tc` and `Tw` are **not** applied to number elements — they are per-glyph terms only.

Sign: `n` is in **thousandths of a unit of text space**, and the amount is **subtracted** from the current coordinate. Therefore, in the default coordinate system:

- **positive `n` → next glyph moves LEFT** (horizontal) or **DOWN** (vertical) — i.e. tighter kerning.
- **negative `n` → next glyph moves RIGHT** (horizontal) or **UP** (vertical) — i.e. extra gap.

This is why justified text is full of large negative numbers like `[(word) -278 (word)] TJ` inserting spaces.

### 4.4 How `w0` / `w1` are obtained

`w0` is the glyph's horizontal displacement **expressed in text space**, i.e. after applying the font matrix.

**Simple fonts (Type1, TrueType, MMType1) — glyph space is 1/1000 text space:**

```
  code = the single byte
  if FirstChar <= code <= LastChar and Widths present and Widths[code−FirstChar] is present:
       widthGlyphSpace = Widths[code − FirstChar]
  else widthGlyphSpace = FontDescriptor./MissingWidth   (default 0)
  w0 = widthGlyphSpace / 1000.0
```

For the standard 14 fonts with no `/Widths`, use the built-in AFM metrics (also in 1/1000 units). `/Widths` **always overrides** the embedded font program's own advance widths — never read hmtx/hmtx-equivalent when `/Widths` covers the code.

**Type 3 fonts — glyph space is defined by `/FontMatrix`:**

```
  wGlyph = (Widths[code − FirstChar], 0)          # Type3 /Widths are in glyph space
  (w0, wy) = wGlyph transformed by FontMatrix, translation excluded
           = ( Widths[i]·FontMatrix[0] , Widths[i]·FontMatrix[1] )
```

Only the linear part of `FontMatrix` applies (`e`, `f` are excluded). For the common `/FontMatrix [0.001 0 0 0.001 0 0]` this reduces to the simple-font case. A Type 3 with `/FontMatrix [1 0 0 1 0 0]` and `/Widths [0.6 …]` is legal and `w0 = 0.6`.

Note the value `wx` returned by the glyph procedure's `d0`/`d1` **shall agree** with `/Widths`; if they disagree, `/Widths` governs the advance in the text object.

**Composite (Type 0) fonts:**

```
  CMap decodes the byte string → sequence of (code, byteLen)
  CIDMap / CIDToGIDMap: code → CID
  descendant CIDFont:
    horizontal: w = W-array lookup for CID, else DW (default 1000)
    w0 = w / 1000.0
    vertical:   (w1y, v) from W2-array lookup for CID,
                else DW2 (default [880 −1000]) ⇒ v = (w0/2, 880), w1 = −1000
    w1 = w1y / 1000.0
```

`/W` array syntax (two interleaved forms, freely mixed):
```
  cFirst  [ w1 w2 … wn ]         ; CIDs cFirst … cFirst+n−1 get w1…wn
  cFirst  cLast  w               ; CIDs cFirst … cLast all get w
```
`/W2` similarly, with triples `w1y vx vy` per CID.

**Vertical writing specifics:** in WMode 1 the glyph is not drawn at the current point; it is drawn at `currentPoint − v`, where `v` is the position vector from `/W2`/`/DW2` (glyph space, /1000 into text space). `w1` is normally **negative** (e.g. −1.0), so successive glyphs march downward.

### 4.5 Worked example — simple font, horizontal

Font `/F1` with `/Widths` (Helvetica metrics): `H`=722, `e`=556, `l`=222, `o`=556, `space`=278.
State: `Tfs = 12`, `Tc = 0.5`, `Tw = 2`, `Tz = 100` (`Th = 1`), `Ts = 0`.

`(Hello) Tj` — codes H, e, l, l, o; five glyphs, no code 32.

```
  Σw0 = 0.722 + 0.556 + 0.222 + 0.222 + 0.556 = 2.278
  tx  = ( 2.278·12 + 5·0.5 + 0·2 ) · 1
      = ( 27.336 + 2.5 ) · 1
      = 29.836
```

Per-glyph, for auditing: H = 0.722·12+0.5 = 9.164; e = 0.556·12+0.5 = 7.172; l = 0.222·12+0.5 = 3.164; l = 3.164; o = 7.172. Sum = 29.836. ✓

Now change to `80 Tz` (`Th = 0.8`):

```
  tx = 29.836 · 0.8 = 23.8688
```

### 4.6 Worked example — word spacing

Widths: `a`=556, `space`=278, `b`=556. `Tfs = 10`, `Tc = 0`, `Tw = 3`, `Th = 1`.

`(a b) Tj` — three codes, one of which is single-byte 32.

```
  Σw0 = 0.556 + 0.278 + 0.556 = 1.390
  tx  = ( 1.390·10 + 3·0 + 1·3 ) · 1 = 13.9 + 3 = 16.9
```

Same string in an Identity-H composite font as `<0044 0003 0045> Tj` with the same widths and `Tw = 3`: **`Tw` contributes nothing**, so `tx = 13.9`. A 3.0-unit divergence per space — this is exactly the drift bug described in §4.2.

### 4.7 Worked example — `TJ` with adjustments

Widths `A`=667, `V`=667, `E`=667. `Tfs = 20`, `Tc = 0`, `Tw = 0`, `Th = 1`.

`[(A) -120 (V) 250 (E)] TJ`

```
  glyph A :  tx = (0.667 − 0)·20      = 13.34
  num −120:  tx = −(−120/1000)·20·1   = +2.40
  glyph V :  tx = 13.34
  num  250:  tx = −(250/1000)·20·1    = −5.00
  glyph E :  tx = 13.34
  ───────────────────────────────────────────
  total                               = 37.42
```

Cross-check with the closed form of §7.4: `Σw0 = 2.001`, `Σn = −120 + 250 = +130`.
`tx_total = (2.001·20 + 0 + 0 − 130/1000·20)·1 = 40.02 − 2.60 = 37.42`. ✓

---

## 5. `Tm`, `Tlm`, and the text rendering matrix `Trm`

### 5.1 The composition (§9.4.4)

```
        | Tfs·Th    0     0 |
  Trm = |   0      Tfs    0 |  ×  Tm  ×  CTM
        |   0       Ts    1 |
```

i.e. with `Sf = [ Tfs·Th , 0 , 0 , Tfs , 0 , Ts ]`:

```
  Trm = Sf × Tm × CTM
```

**Order matters and is left-to-right in application order**: a point in text space is scaled by `Sf` first, then by `Tm`, then by `CTM`. Because PDF uses row vectors, that is written as the product above, and it must be evaluated as `(Sf × Tm) × CTM` or `Sf × (Tm × CTM)` — matrix multiplication is associative, so either grouping is fine, but you may **not** reverse the operand order.

Note that `Ts` (text rise) occupies the `f` slot of `Sf`, so it is a translation applied **in text space, before `Tm`** — a rise of 5 with a rotated `Tm` moves the glyph 5 units along `Tm`'s local *y* axis, not along the page's *y* axis.

`Trm` maps **text space** to device space. Glyph space maps to text space by a further scale: for non-Type-3 fonts multiply by `0.001`; for Type 3 fonts, by `/FontMatrix`. So the full glyph-outline transform is:

```
  non-Type3:  [0.001 0 0 0.001 0 0] × Trm
  Type3    :  FontMatrix × Trm
```

`Trm` is **recomputed for every glyph**, because `Tm` changes after every glyph. Only the `e`/`f` components change during a run of glyphs (as long as `Tfs`, `Th`, `Ts`, `Tm`'s linear part, and `CTM` are constant).

### 5.2 Extracting position, size, rotation, and skew from `Trm = [a b c d e f]`

**Position of the glyph origin (baseline start), in the space `CTM` maps to:**

```
  x = e
  y = f
```

If `CTM` is the page's default-user-space→device transform composed with all active `cm`s, this is device space. If you initialize `CTM = Identity` at the start of the page content stream, `(e, f)` is in **default user space** = PDF page points with origin at the lower-left of the `/MediaBox` (offset by the MediaBox origin), before `/Rotate`.

**Basis vectors:**

```
  X = (a, b)     # image of text-space unit x — the glyph's baseline direction
  Y = (c, d)     # image of text-space unit y — the glyph's up direction
```

**Rotation of the baseline:**

```
  θ = atan2(b, a)               # radians, CCW from device +x
  degrees = θ · 180/π
```

**Scales (QR / Gram–Schmidt decomposition, row-vector convention):**

```
  sx     = hypot(a, b)                       # horizontal scale factor  = Tfs·Th·|Tm×CTM in x|
  skewX  = (a·c + b·d) / sx                  # shear component of the up-vector
  sy     = (a·d − b·c) / sx                  # signed vertical scale (perpendicular height)
  syAbs  = hypot(c, d)                       # length of the up-vector
  det    = a·d − b·c                         # negative ⇒ mirrored (y-flipped device space)
  italicAngle = atan2(skewX, sy)             # 0 for unskewed text
```

**Effective font size.** Two defensible definitions; they coincide when there is no skew:

- **`fontSizeEff = hypot(c, d)`** — the length of the transformed up-vector. This is what most extractors (PDF.js, PDFBox, pdfminer) report, and it is the right answer for "how tall is one em along the glyph's own vertical axis".
- **`fontSizePerp = |a·d − b·c| / hypot(a, b)`** — the perpendicular em height. Preferred when you care about the visual line height of skewed text.

When `Tm × CTM` is a pure rotation with uniform scale *s*, both give `Tfs · s`, and `sx = Tfs · Th · s`.

**Recovering `Tfs` and `Th` separately** requires knowing `Tm × CTM`; from `Trm` alone you only get the products. If your interpreter tracks state (it should), you have `Tfs` and `Th` directly and need `Trm` only for placement.

**Device-space advance vector.** A text-space advance of `(tx, 0)` maps to a device delta of `tx` transformed by the **linear part of `Tm × CTM`** — *not* by `Trm` (that would double-count `Tfs·Th`):

```
  L      = linear part of (Tm × CTM)
  dx_dev = tx · L.a
  dy_dev = tx · L.b
```

Equivalently, straight from `Trm`:

```
  dx_dev = tx · a / (Tfs · Th)
  dy_dev = tx · b / (Tfs · Th)
```

(Valid when `Tfs · Th ≠ 0`.) So a glyph's device-space bounding box advances along the unit vector `(a, b)/hypot(a,b)` by `tx · hypot(a,b) / (Tfs·Th)`.

### 5.3 Worked example — full composition

Page is 612×792. Device transform (top-left origin, 1 px = 1 pt): `CTM = [1 0 0 −1 0 792]`.
Text: 45° counter-clockwise in user space, origin at user (100, 200), `Tfs = 12`, `Tz = 100` (`Th = 1`), `Ts = 0`.

```
  Tm = [0.70711  0.70711  −0.70711  0.70711  100  200]
  Sf = [12  0  0  12  0  0]
```

**Step 1 — `Sf × Tm`:**
```
  a = 12·0.70711 + 0·(−0.70711)     =  8.48528
  b = 12·0.70711 + 0·0.70711        =  8.48528
  c =  0·0.70711 + 12·(−0.70711)    = −8.48528
  d =  0·0.70711 + 12·0.70711       =  8.48528
  e =  0·0.70711 + 0·(−0.70711) + 100 = 100
  f =  0·0.70711 + 0·0.70711   + 200 = 200
  ⇒ [8.48528  8.48528  −8.48528  8.48528  100  200]
```

**Step 2 — `(Sf × Tm) × CTM` with `CTM = [1 0 0 −1 0 792]`:**
```
  a =  8.48528·1 +  8.48528·0     =  8.48528
  b =  8.48528·0 +  8.48528·(−1)  = −8.48528
  c = −8.48528·1 +  8.48528·0     = −8.48528
  d = −8.48528·0 +  8.48528·(−1)  = −8.48528
  e =  100·1 + 200·0 + 0          =  100
  f =  100·0 + 200·(−1) + 792     =  592

  Trm = [8.48528  −8.48528  −8.48528  −8.48528  100  592]
```

**Extraction:**
```
  origin (device)  = (100, 592)                          ✓ (200 pt from bottom = 592 from top)
  sx = hypot(8.48528, −8.48528) = 12.0                   ✓ = Tfs·Th·1
  hypot(c,d) = 12.0        ⇒ fontSizeEff = 12            ✓
  θ  = atan2(−8.48528, 8.48528) = −45°                   ✓ (CCW in user space = CW in flipped device space)
  det = (8.48528)(−8.48528) − (−8.48528)(−8.48528)
      = −72 − 72 = −144  < 0                             ⇒ mirrored, as expected from the y-flip
  skewX = (a·c + b·d)/sx = (−72 + 72)/12 = 0             ⇒ no skew ✓
  sy = det/sx = −144/12 = −12                            ⇒ up-vector points "down" in device space ✓
```

**With `Ts = 5` instead of 0** — only `Sf`'s `f` changes to 5, so step 1's translation becomes:
```
  e = 0·0.70711 + 5·(−0.70711) + 100 = 96.46447
  f = 0·0.70711 + 5·0.70711    + 200 = 203.53553
```
i.e. the glyph rises 5 units **along Tm's local y**, which in a 45° frame is `(−3.5355, +3.5355)` in user space. Confirms the rise is pre-`Tm`.

**Advance check.** Showing `(Hello)` from §4.5 with `Th = 1` gives `tx = 29.836`. Device delta:
```
  dx = 29.836 · 8.48528 / (12·1) =  21.098
  dy = 29.836 · (−8.48528) / 12  = −21.098
```
New device origin = (121.098, 570.902), i.e. 29.836 pt along a 45° direction. ✓ (29.836/√2 = 21.098 ✓)

---

## 6. Precise semantics of `Td`/`TD`/`T*`/`TL` and what `BT` resets

### 6.1 The two matrices

- **`Tlm` (text line matrix)** — records the origin of the **current line**. Written by `BT`, `Td`, `TD`, `Tm`, `T*`, `'`, `"`. Never written by `Tj` or `TJ`.
- **`Tm` (text matrix)** — records the origin of the **next glyph**. Written by everything that writes `Tlm` (always to the same value), *and additionally* advanced by every glyph and every `TJ` number.

**Invariant: `Tm` and `Tlm` are equal immediately after `BT`, `Td`, `TD`, `Tm`, `T*`, and immediately after the line-advance part of `'`/`"`. They diverge only as a result of showing glyphs or `TJ` adjustments.**

### 6.2 Operator-by-operator

```
BT       :  Tm ← I ; Tlm ← I
            (Tf, Tfs, Tc, Tw, Tz/Th, TL/Tl, Ts, Tr, Tk, colour, CTM: UNCHANGED)

tx ty Td :  Tlm ← [1 0 0 1 tx ty] × Tlm
            Tm  ← Tlm

tx ty TD :  Tl  ← −ty                       # side effect on the text state (graphics state)
            Tlm ← [1 0 0 1 tx ty] × Tlm
            Tm  ← Tlm

a b c d e f Tm : Tlm ← [a b c d e f]        # ABSOLUTE, replaces
                 Tm  ← [a b c d e f]

T*       :  Tlm ← [1 0 0 1 0 −Tl] × Tlm
            Tm  ← Tlm

l TL     :  Tl ← l                          # graphics state; q/Q-saved; survives BT/ET

ET       :  Tm, Tlm undefined
            if any glyph used Tr ∈ {4,5,6,7}: clip ← clip ∩ union(glyph outlines)
```

### 6.3 The `TL` sign trap

`TL` sets a **leading**, a positive downward distance. `T*` applies `0 −Tl Td`. Therefore:

- `14 TL` + `T*` moves the line origin **down** 14 units (in `Tlm`'s local coordinate system).
- `-14 TL` + `T*` moves **up** 14 units.
- `TD` sets `Tl = −ty`, so `0 -14 TD` (move down 14) sets `Tl = 14`, and a subsequent `T*` reproduces the same downward move. This is the intended idiom.
- `0 14 TD` sets `Tl = −14`; a subsequent `T*` moves **up**. Rare but legal.

### 6.4 Canonical multi-line block

```
BT
  /F1 12 Tf
  14 TL
  72 700 Td        % Tlm = Tm = [1 0 0 1 72 700]
  (Line one) Tj    % Tm advances; Tlm still [1 0 0 1 72 700]
  T*               % Tlm = [1 0 0 1 72 686] ; Tm = Tlm
  (Line two) Tj
  T*               % Tlm = [1 0 0 1 72 672] ; Tm = Tlm
  (Line three) Tj
ET
```

Equivalent using `'`:

```
BT /F1 12 Tf 14 TL 72 714 Td
  (Line one) '     % T* first ⇒ Tlm = [.. 72 700], then show
  (Line two) '
  (Line three) '
ET
```

Note the `Td` must be one leading **above** the first baseline, because `'` advances first.

### 6.5 `Tm` vs `Td` for rotated text

`Td` can only translate. To rotate, you must issue a full `Tm`. And because `Tm` is absolute, a rotated block's line advance must either be issued as a fresh `Tm` per line (with pre-rotated line origins) or as `T*`/`Td`, whose `tx`/`ty` are interpreted **in the rotated frame** — `0 -14 Td` under a 45° `Tm` moves 14 units along the rotated down-direction, i.e. `(+9.899, −9.899)` in user space. This is usually what you want and is why `T*` is safe with rotated text.

---

## 7. Safely deleting a text-showing operator

### 7.1 The problem, stated exactly

At the point just before the target show-op, the interpreter state is `(Tm = M, Tlm = L, Tc, Tw, Th, Tfs, Tr, Ts, font)`.

The show-op produces a total advance `(tx_total, ty_total)` and leaves:

```
  Tm_after  = [1 0 0 1 tx_total ty_total] × M
  Tlm_after = L                                   # UNCHANGED for Tj / TJ
```

(For `'` and `"`, additionally `L_after = [1 0 0 1 0 −Tl] × L` and `M = L_after` before showing; for `"`, also `Tw ← aw`, `Tc ← ac`.)

**A correct replacement must reproduce BOTH `Tm_after` AND `Tlm_after`, plus any `Tw`/`Tc` side effects.** Every strategy that fails, fails because it clobbers `Tlm`.

**Structural fact:** `Tm` and `Tlm` diverge *only* through text-showing operators (§6.1). Therefore **no combination of `Td`/`TD`/`Tm`/`T*` can ever reproduce a state where `Tm ≠ Tlm`.** If the deleted op left `Tm ≠ Tlm`, only another showing operator can restore that state.

### 7.2 Strategy (a) — `a b c d e f Tm` with the post-advance matrix

Emit `Tm_after` as an explicit `Tm`.

**Requires:** exact `w0` for every code in the string (correct `/Widths`/`/W`/`/DW`/`/MissingWidth`, correct CMap decoding, correct Type 3 `FontMatrix`), plus the live `Tfs`, `Tc`, `Tw`, `Th` at that point, plus the live `Tm`.

**Failure modes:**

1. **`Tlm` corruption — fatal and common.** `Tm` writes `Tlm` too. Original `Tlm_after = L`; new `Tlm = Tm_after`. Any later `T*`, `Td`, `TD`, `'`, or `"` in the same text object is now relative to the wrong line origin, and **every subsequent line shifts by exactly `tx_total`**. See §7.6, Example E.
2. **Unrecoverable.** Because of §7.1, you cannot patch it up afterwards with any positioning operator.
3. **Width uncertainty.** Missing `/Widths` entries, `/MissingWidth` absent (defaults to 0, but the real font advance is not 0), subset fonts whose `/Widths` disagree with the embedded program, Type 3 `d0` vs `/Widths` mismatch, `/DW` assumed 1000 when the file relies on a `/W` entry you misparsed.
4. **Rounding.** You must serialize six reals. Rotated/skewed `Tm` values need many digits; producers that emit 4–5 decimals will accumulate visible drift over long text objects and across repeated edit passes.
5. **`'`/`"` not handled** — you also lose the `T*` line advance and, for `"`, the `Tw`/`Tc` assignment.
6. **Type 3 vertical component.** If the Type 3 `FontMatrix` has a nonzero `b` (skewed glyph space), `w0`'s vertical component is nonzero and `ty_total ≠ 0`.

**Verdict: do not use.** It is the strategy that looks most obviously correct and is the one that silently breaks multi-line paragraphs.

### 7.3 Strategy (b) — `tx 0 Td` with the computed advance

Emit `tx_total 0 Td` (or `tx_total ty_total Td`).

Note one thing it gets *right*: `Td`'s operands are in **unscaled text space**, which is exactly the space the advance formula's `tx` lives in — so `tx_total` is directly usable, no `Th`/`Tfs` re-scaling, and it automatically works under any rotation/skew in `Tm`. Also, only two numbers are serialized instead of six, so rounding is less bad than (a).

**Failure modes:**

1. **`Tlm` corruption.** `Td` premultiplies `Tlm` and then copies to `Tm`. `Tlm` becomes `T(tx,0) × L`, not `L`. Same fatal consequence as (a).
2. **Catastrophic when `Tm ≠ Tlm`** — worse than (a). `Td` computes `Tm` from **`Tlm`**, not from `Tm`. So it *discards every advance accumulated since the last positioning operator.* In:
   ```
   72 700 Td
   (AB) Tj      % Tm advances by 20; Tlm still [1 0 0 1 72 700]
   (CD) Tj      % ← delete this one
   (EF) Tj
   ```
   replacing `(CD) Tj` with `w 0 Td` sets `Tm = [1 0 0 1 72+w 700]` — the 20 units contributed by `(AB)` are gone, and `(EF)` jumps left by 20. Strategy (a) at least gets `Tm` right.
   **(b) is only ever valid when `Tm == Tlm` immediately before the deleted op**, i.e. when the show-op directly follows a `Td`/`TD`/`Tm`/`T*` with no intervening showing.
3. **Same width-accuracy requirement as (a).**
4. **Same `'`/`"` gap as (a).**

**Verdict: do not use.** Strictly worse than (a) in the `Tm ≠ Tlm` case, equally broken in the `Tlm` case.

### 7.4 Strategy (d) — replace with an equal-width `TJ` adjustment

Emit `[ N ] TJ` — a `TJ` array containing **only a number**, no strings. This shows no glyphs and produces a pure advance.

**Why it is correct:** `TJ` writes only `Tm`, never `Tlm`. It advances `Tm` by premultiplied translation exactly as glyphs do. It therefore reproduces `Tm_after` **and** `Tlm_after = L` — the only deletion strategy that reproduces both.

**The exact number to emit.**

From §4.3, a `TJ` number `N` produces `tx = (−N/1000)·Tfs·Th`. Set that equal to `tx_total`:

```
  N = − 1000 · tx_total / ( Tfs · Th )
```

Substituting `tx_total = ( Σᵢ w0ᵢ·Tfs + n·Tc + n₃₂·Tw − Σⱼ Nⱼ/1000 · Tfs ) · Th` gives the **closed form, with `Th` cancelling out entirely**:

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                                                                      │
  │   N  =  − 1000 · Σᵢ w0ᵢ                                              │
  │         − 1000 · n   · Tc / Tfs                                      │
  │         − 1000 · n₃₂ · Tw / Tfs                                      │
  │         + Σⱼ Nⱼ                                                      │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

    Σᵢ w0ᵢ  = sum of glyph widths in text space (i.e. Σ Widths/1000)
    n       = total number of glyphs shown by the deleted operator
    n₃₂     = number of glyphs whose code was single-byte 32 (§4.2)
    Nⱼ      = the original TJ adjustment numbers (0 if the op was Tj/'/" )
    Tfs, Tc, Tw = the live text state at the deleted operator
```

Equivalently, if you already computed `Σ Widths` in 1/1000 units as `W1000`:

```
  N = − W1000 − 1000·n·Tc/Tfs − 1000·n₃₂·Tw/Tfs + Σⱼ Nⱼ
```

**Properties of this formula:**

- **`Th` (i.e. `Tz`) does not appear.** The replacement is correct for any horizontal scaling, and remains correct even if you got `Tz` wrong. This is a genuine robustness advantage over (a) and (b).
- **`Tfs` appears only in the `Tc`/`Tw` terms.** If `Tc = Tw = 0` (very common), `N = −W1000 + ΣNⱼ` is **exact integer arithmetic** with zero floating-point error — the ideal case.
- Requires `Tfs ≠ 0`. If `Tfs == 0`, then `tx_total = (n·Tc + n₃₂·Tw)·Th` and the `TJ` mechanism cannot express it (any `N` yields `tx = 0`); in that degenerate case, delete outright if §7.5 applies, else fall back to (c).
- **Vertical writing mode:** the same derivation with `ty` gives `N = −1000·Σ w1ᵢ − 1000·n·Tc/Tfs − 1000·n₃₂·Tw/Tfs + Σⱼ Nⱼ`. Note `w1` is normally negative, so `N` is normally positive.

**Failure modes:**

1. **It still requires exact glyph widths.** *(This corrects the premise in the brief: (d) needs precisely the same width knowledge as (a) and (b). It is (c) alone that is width-free.)* Its real advantages over (a)/(b) are (i) `Tlm` preservation, (ii) `Tm ≠ Tlm` safety, (iii) `Th`-independence, (iv) a single number to serialize, often exactly.
2. **`'` and `"` need their side effects materialized first.** See §7.7.
3. Serialization: emit enough precision. `%.6f` with trailing-zero trim is ample (1e-6 thousandths of text space = 1e-9 em). Emit an integer when the value is integral.
4. A very small number of fragile third-party parsers dislike a `TJ` array with no string element. If you must appease them, emit `[ () N ] TJ` — the empty string shows nothing and adds nothing (no glyphs ⇒ no `Tc`/`Tw`). Both forms are conforming; prefer `[ N ] TJ`.
5. As with all deletion, this removes the glyphs from the content stream only. `/ActualText` on an enclosing `BDC`, the structure tree, `/Alt`, and any duplicate OCR layer are untouched and remain extractable.

### 7.5 The zero-knowledge shortcut: when compensation is unnecessary at all

The accumulated advance in `Tm` matters **only until the next operator that reassigns `Tm`**. From §6.2, `Tm` is unconditionally reassigned by `Td`, `TD`, `Tm`, `T*`, `'`, `"`, and becomes undefined at `ET`.

> **Rule.** Scan forward from the deleted show-op within the same text object. If the next operator that reads or writes `Tm` is any of `Td`, `TD`, `Tm`, `T*`, `'`, `"`, or `ET` — **simply delete the show-op with no compensation whatsoever.** Zero width knowledge required; exact by construction.

This covers the large majority of real deletions, because most producers emit exactly one show-op per positioning op. Apply it first, always.

Caveats when scanning forward:
- Stop the scan at `ET` (safe) — but if the text object continues past the end of the content-stream *part* you are editing (multi-part `/Contents`), treat it as "unknown" and do not take the shortcut.
- `Tf`, `Tc`, `Tw`, `Tz`, `Ts`, `Tr`, `gs`, colour operators, and marked-content operators do **not** reassign `Tm` — keep scanning through them. But note that if you keep scanning past a `Tf`/`Tc`/`Tw`/`Tz` and then find a `Tj`, you must compute the compensation using the state **at the deleted op**, not the changed state.
- Marked-content nesting: deleting a show-op inside a `BDC`…`EMC` that carries `/ActualText` leaves the `ActualText` behind; delete or amend the marked-content pair too.

### 7.6 Strategy (c) — render mode 3 instead of deleting

Do not remove the show-op. Set the text rendering mode to 3 (or 7 — see §8) around it.

```
  3 Tr
  (secret) Tj
  0 Tr                    % restore the value that was in force
```

**Why it is exact:** the show-op still executes, so `Tm`, `Tlm`, `Tc`, `Tw`, and every side effect are byte-identical to the original. It requires **zero knowledge of glyph widths, CMaps, font programs, or `Tz`**. It is the only strategy with that property.

**Failure modes:**

1. **It is not deletion.** The glyph codes remain in the stream. Every mainstream text extractor recovers them (§8.2). **Never use this for redaction, PII removal, or anything with a confidentiality requirement.**
2. **You must restore the previous `Tr`, not assume 0.** `Tr` is graphics state: it persists across `BT`/`ET`, is set by `Tr`, saved/restored by `q`/`Q`, and its initial value at the start of a content stream is 0. Your interpreter must track it through the `q`/`Q` stack and emit the actual prior value.
3. **Do not wrap in `q`/`Q` inside a text object.** `q` and `Q` are special-graphics-state operators and **shall not** appear between `BT` and `ET` (§8.2, Table 31). Acrobat and most viewers tolerate it, but strict validators (PDF/A, PDF/UA, veraPDF, preflight) will flag it, and a `Q` inside `BT`…`ET` also restores the CTM, which some renderers handle differently mid-text-object. Emit paired `Tr` operators instead — that is what §7.6's snippet does.
4. **Clipping modes must be mapped, not flattened.** If the original `Tr` ∈ {4, 5, 6}, the glyphs were contributing to the clipping path applied at `ET`. Replacing with 3 **removes that clip contribution**, changing what everything after `ET` looks like. Map `{0,1,2} → 3` and `{4,5,6} → 7`. `3 → 3` and `7 → 7` are no-ops.
5. **Empty-clip trap.** If a text object is in a clipping mode (4–7) and, after your edit, shows *no* glyphs at all, the clipping path produced at `ET` is **empty** and clips away everything until the enclosing `Q`. Never leave a clipping-mode text object glyph-less.
6. **Type 3 fonts.** A Type 3 glyph is an arbitrary content stream that paints itself; the text rendering mode does not select fill vs. stroke for it. Conforming readers honour mode 3 by suppressing the glyph's marks, but this is a known interoperability soft spot — a Type 3 glyph procedure that begins with `d0` (rather than `d1`) and sets its own colour has been observed to paint through mode 3 in some renderers. **For Type 3 fonts, verify against your target renderers, or prefer real deletion.**
7. **Stream size.** Nothing is removed, so the file does not shrink.

### 7.7 Handling `'` and `"` — always materialize side effects first

Before applying any strategy, rewrite the operator into its primitive equivalent:

```
  (s) '                →   T*  (s) Tj
  aw ac (s) "          →   aw Tw  ac Tc  T*  (s) Tj
```

Then delete the trailing `(s) Tj` by whichever strategy applies, and **keep the `T*` and, for `"`, keep the `aw Tw` / `ac Tc`** — those are the operator's persistent side effects and later glyphs depend on them.

For `"`, note that `N` in §7.4 must be computed with the **new** `Tw = aw` and `Tc = ac`, because those apply to the string `"` itself shows.

### 7.8 Recommendation

**Decision procedure, in order:**

```
0. Normalize:  if op is ' or " → rewrite to  [aw Tw] [ac Tc] T*  (s) Tj
               (keep the T* and the Tw/Tc; only the Tj is a deletion candidate)

1. FORWARD-SCAN SHORTCUT (§7.5)
   If the next Tm-reassigning operator in this text object is
   Td / TD / Tm / T* / ' / " / ET  →  DELETE OUTRIGHT. Done. No widths needed.

2. If you have trustworthy metrics for every code in the string
   (Widths or W/DW resolved, CMap decoded, MissingWidth known, FontMatrix known):
        emit   [ N ] TJ    with
        N = −1000·Σw0 − 1000·n·Tc/Tfs − 1000·n₃₂·Tw/Tfs + Σ Nⱼ
   (requires Tfs ≠ 0)

3. Otherwise — unknown/embedded-only widths, exotic Type 3, damaged font dict,
   Tfs == 0, or the visual result must be bit-identical and the content is not
   confidential:
        keep the op, set render mode:  {0,1,2} → 3,  {4,5,6} → 7
        emit  `<newTr> Tr` before and `<oldTr> Tr` after — NOT q/Q.
        Do NOT use this if the goal is redaction.

NEVER use (a) `… Tm` or (b) `tx 0 Td`. Both destroy Tlm, and (b) additionally
destroys any advance accumulated since the last positioning operator.
```

**Rationale in one line:** `Tj`/`TJ` are the *only* operators that write `Tm` without writing `Tlm`, so the only exact in-band replacement for a show-op is another show-op — which is what `[ N ] TJ` is.

**Precision note.** When emitting `N`, prefer integers. With `Tc = Tw = 0`, `N = −W1000 + ΣNⱼ` is exactly an integer given integer `/Widths`, which is the common case. Serialize reals with `%.6f` and trim trailing zeros and a trailing `.`; never use exponent notation (non-conforming, §1.3).

**Idempotence note.** If you delete several show-ops in the same text object, apply steps 1–2 **left to right, recomputing the live state after each edit**, so that each `N` uses the `Tc`/`Tw`/`Tfs` actually in force there. Do not compute all `N` values against the pre-edit state.

### 7.9 Worked example E — the `Tlm` corruption, demonstrated

Original (widths from §4.5, `Tfs = 12`, `Tc = 0.5`, `Tw = 2`, `Th = 1`, so `tx_total = 29.836` for `(Hello)`):

```
BT
  /F1 12 Tf
  0.5 Tc  2 Tw  14 TL
  72 700 Td            % Tm = Tlm = [1 0 0 1 72 700]
  (Hello) Tj           % Tm = [1 0 0 1 101.836 700] ; Tlm = [1 0 0 1 72 700]
  T*                   % Tlm = [1 0 0 1 72 686] ; Tm = Tlm
  (World) Tj           % "World" baseline starts at (72, 686)  ← the reference
ET
```

**Strategy (a):** replace `(Hello) Tj` with `1 0 0 1 101.836 700 Tm`.
```
  Tm = Tlm = [1 0 0 1 101.836 700]
  T*  ⇒ Tlm = Tm = [1 0 0 1 101.836 686]
  "World" starts at (101.836, 686)      ✗  shifted right by 29.836 pt
```

**Strategy (b):** replace with `29.836 0 Td`.
```
  Tlm = [1 0 0 1 72+29.836 700] = [1 0 0 1 101.836 700] ; Tm = Tlm
  T*  ⇒ (101.836, 686)                  ✗  identical failure
```

**Strategy (d):** replace with `[ N ] TJ`.
```
  Σw0 = 2.278 , n = 5 , n₃₂ = 0 , ΣNⱼ = 0
  N = −1000·2.278 − 1000·5·0.5/12 − 0 + 0
    = −2278 − 208.333333
    = −2486.333333

  Verify: tx = −(−2486.333333/1000)·12·1 = 2.486333333·12 = 29.836   ✓
  Tm = [1 0 0 1 101.836 700] ; Tlm = [1 0 0 1 72 700]   ← both correct
  T*  ⇒ Tlm = Tm = [1 0 0 1 72 686]
  "World" starts at (72, 686)           ✓  exact
```

Also verify `Th`-independence: with `80 Tz`, `tx_total = 23.8688`, and
`N = −1000·23.8688/(12·0.8) = −23868.8/9.6 = −2486.333333` — **the same number.** ✓

**Strategy (1) — the shortcut:** the next operator after `(Hello) Tj` is `T*`, which reassigns `Tm` from `Tlm`. So `(Hello) Tj` can simply be **deleted with nothing in its place**, and "World" still lands at (72, 686). ✓ No widths needed. This is why step 1 comes first.

**Strategy (c):**
```
BT /F1 12 Tf 0.5 Tc 2 Tw 14 TL 72 700 Td
  3 Tr  (Hello) Tj  0 Tr
  T*  (World) Tj
ET
```
Positioning identical by construction; "Hello" is invisible but `pdftotext` still prints it.

### 7.10 Worked example F — deleting from a `TJ` with `Tm ≠ Tlm`

```
BT /F1 20 Tf 72 500 Td
  [(A) -120 (V) 250 (E)] TJ      % ← delete this (from §4.7, tx_total = 37.42)
  (XYZ) Tj                       % must stay exactly where it was
ET
```

Step 1 shortcut does **not** apply — the next op is `Tj`, which does not reassign `Tm`.

Step 2: `Σw0 = 0.667·3 = 2.001`, `n = 3`, `n₃₂ = 0`, `Tc = 0`, `Tw = 0`, `ΣNⱼ = −120 + 250 = +130`.

```
  N = −1000·2.001 − 0 − 0 + 130 = −2001 + 130 = −1871      (exact integer)

  Verify: tx = −(−1871/1000)·20·1 = 1.871·20 = 37.42       ✓ matches §4.7
```

Result:
```
BT /F1 20 Tf 72 500 Td
  [ -1871 ] TJ
  (XYZ) Tj
ET
```
`Tm` after = `[1 0 0 1 109.42 500]`, `Tlm` = `[1 0 0 1 72 500]` — both exactly as before. ✓

By contrast, strategy (b) here would emit `37.42 0 Td`, which sets `Tm` from `Tlm` — giving `[1 0 0 1 109.42 500]` (correct in this instance, since `Tm == Tlm` before the deleted op) but corrupting `Tlm` to `[1 0 0 1 109.42 500]`. If a `T*` followed, it would break. And in the §7.3-item-2 layout, where a prior `Tj` had already advanced `Tm`, (b) breaks `Tm` too.

### 7.11 Reference implementation of the delete

```python
def delete_show_op(ops, i, state_at):
    """ops: token list; i: index of the show-op; state_at(i) -> interpreter state."""
    st = state_at(i)
    op = ops[i]

    # 0. normalize ' and "
    if op.name == "'":
        return ops[:i] + [Op("T*")] + delete_show_op(
            ops[:i] + [Op("Tj", op.operands)] + ops[i+1:], i, state_at)[i:]
    if op.name == '"':
        aw, ac, s = op.operands
        pre = [Num(aw), Op("Tw"), Num(ac), Op("Tc"), Op("T*")]
        # then delete the equivalent (s) Tj with Tw=aw, Tc=ac
        st = st.with_(Tw=aw, Tc=ac)
        return ops[:i] + pre + _delete_tj(ops, i, st) 

    return _delete_tj(ops, i, st)


def _delete_tj(ops, i, st):
    # 1. forward-scan shortcut
    j = i + 1
    while j < len(ops):
        n = ops[j].name
        if n in ("Td", "TD", "Tm", "T*", "'", '"', "ET"):
            return ops[:i] + ops[i+1:]              # plain delete, exact
        if n in ("Tj", "TJ"):
            break                                   # a later glyph depends on Tm
        j += 1
    else:
        return ops[:i] + ops[i+1:]                  # ran off the end of this part?
                                                    # only safe if the BT/ET closes here

    # 2. equal-width TJ adjustment
    if st.Tfs != 0 and metrics_are_trustworthy(st.font):
        sum_w0 = 0.0; n_glyphs = 0; n_space = 0; sum_adj = 0.0
        for elem in elements_of(ops[i]):            # Tj -> one string; TJ -> mixed
            if is_number(elem):
                sum_adj += elem
            else:
                for (code, nbytes) in st.font.decode(elem):
                    sum_w0   += st.font.w0(code)    # already /1000 (or via FontMatrix)
                    n_glyphs += 1
                    if nbytes == 1 and code == 32:
                        n_space += 1
        N = (-1000.0 * sum_w0
             - 1000.0 * n_glyphs * st.Tc / st.Tfs
             - 1000.0 * n_space  * st.Tw / st.Tfs
             + sum_adj)
        return ops[:i] + [Array([Num(N)]), Op("TJ")] + ops[i+1:]

    # 3. fall back to invisible (NOT redaction)
    new_tr = 7 if st.Tr in (4, 5, 6) else 3
    return (ops[:i] + [Num(new_tr), Op("Tr")] + [ops[i]]
                    + [Num(st.Tr),  Op("Tr")] + ops[i+1:])
```

---

## 8. Text rendering mode: 3 vs 7, and text extraction

### 8.1 The eight modes (§9.3.6, Table 106)

| `Tr` | Fill | Stroke | Add to clip |
|---|:---:|:---:|:---:|
| 0 | ● | | |
| 1 | | ● | |
| 2 | ● | ● | |
| 3 | | | | ← **invisible**, no clip
| 4 | ● | | ● |
| 5 | | ● | ● |
| 6 | ● | ● | ● |
| 7 | | | ● | ← **invisible**, clip only

Mode 3 = "neither fill nor stroke (invisible)". Mode 7 = "add to path for clipping" with no painting.

**Mode 7 is not a drop-in for mode 3.** The glyph outlines of every glyph shown in modes 4–7 within a text object accumulate, and **at `ET`** their union is intersected with the current clipping path, which then governs everything drawn afterwards until the enclosing `Q`. Consequences:

- If you set `7 Tr` where the file had `0 Tr`, you have silently installed a glyph-shaped clip on the rest of the page.
- If a text object is in a clipping mode and ends up showing **no glyphs**, the resulting clip is **empty** — everything after `ET` disappears.
- There is no operator to "un-clip"; only `Q` restores the previous clip. If there is no enclosing `q`, the clip persists to the end of the content stream.

**Use mode 7 only to preserve an existing clip contribution** (original `Tr` was 4, 5, or 6). Otherwise use mode 3.

Stroking modes (1, 2, 5, 6) stroke the glyph outline with the current line width, which is specified in **user space** and transformed by the **CTM** — not by `Tm` and not scaled by `Tfs`. A tiny `Tfs` with a normal line width produces solid blobs.

For **Type 3 fonts**, glyph procedures paint themselves; the mode does not select fill vs. stroke. Conforming readers suppress marks for modes 3 and 7, but see §7.6 item 6.

### 8.2 Is invisible text still extracted? **Yes — universally.**

Text rendering mode is a **rendering** parameter. It has no effect whatsoever on the character codes present in the content stream, on the font's `/ToUnicode` CMap, on `/ActualText`, or on the logical structure tree. Every mainstream extractor recovers mode-3 text by default:

| Extractor | Extracts `Tr 3` text? |
|---|---|
| Adobe Acrobat (Select/Copy, Find, Export) | **Yes** |
| `pdftotext` (Poppler) | **Yes** |
| PDF.js (`getTextContent`) | **Yes** (`textContent.items` include them; only the *rendered* text layer honours the mode) |
| Apache PDFBox `PDFTextStripper` | **Yes** |
| iText / iText 7 | **Yes** |
| pdfminer.six | **Yes** |
| macOS Quartz / PDFKit `string` | **Yes** |
| Search-engine and DLP indexers | **Yes** |

This is not an accident — it is the *designed* behaviour that makes searchable-image (OCR) PDFs work: the scanned bitmap is painted, and the OCR text is laid under or over it with `3 Tr` so it is selectable and searchable but invisible. Every OCR pipeline (ABBYY, Tesseract's `pdf` output, Acrobat's "Scanned Document" OCR, ocrmypdf) emits exactly this.

**Therefore:**

- **`3 Tr` is a rendering change, never a redaction.** Content hidden this way is trivially recovered with `pdftotext` or by re-setting the mode.
- Real removal requires deleting the glyph codes from the content stream (this document's §7), **and additionally** auditing: `/ActualText` and `/Alt` on marked-content and structure elements, the tagged structure tree's `/K` content, `/ToUnicode` (does not leak the text itself but confirms the mapping), document `/Info` and XMP metadata, embedded files, annotation `/Contents` and appearance streams, form field `/V` values, JavaScript, optional-content groups, and any incremental-update history in earlier revisions of the file (which requires rewriting the file without incremental updates).
- A handful of extractors expose an *option* to honour render mode (e.g. some PDFBox subclasses override `showGlyph`, PDF.js's rendered text layer). None does so by default, and you cannot rely on any consumer doing so.

---

## 9. Quick-reference summary

```
LEXING
  whitespace:  00 09 0A 0C 0D 20
  delimiters:  ( ) < > [ ] { } / %
  '<' vs '<<': peek one byte
  literal string: balanced unescaped parens; \n\r\t\b\f\(\)\\ \ddd(oct, mod 256)
                  \+EOL = splice; \+other = drop the backslash
                  raw CR / LF / CRLF each become ONE 0x0A
  hex string:   whitespace ignored; odd digit count pads a trailing 0
  name:         #xx = one byte; '/' alone = empty name
  inline image: BI kv-pairs ID <1 ws byte> data EI   — see §1.11 for EI

STATE
  q/Q save & restore: CTM, clip, colour, line params, AND Tc Tw Th Tl Tf Tfs Tr Ts Tk
  q/Q do NOT touch:   Tm, Tlm
  BT sets:            Tm = Tlm = Identity   (and nothing else)
  q/Q/cm/Do/sh/paths/inline-images are NOT permitted inside BT..ET

POSITIONING (all of these do  Tm <- Tlm  as the final step)
  tx ty Td          Tlm <- T(tx,ty) x Tlm
  tx ty TD          Tl <- -ty ; then Td
  a..f Tm           Tlm <- [a..f]                 (ABSOLUTE)
  T*                Tlm <- T(0,-Tl) x Tlm         ( == 0 -Tl Td )

SHOWING (write Tm only; NEVER write Tlm)
  (s) Tj
  [...] TJ
  (s) '             == T* (s) Tj
  aw ac (s) "       == aw Tw  ac Tc  T*  (s) Tj      (Tw/Tc changes PERSIST)

ADVANCE  (per glyph; premultiply Tm <- T(tx,ty) x Tm)
  horiz:  tx = ((w0 - Tj/1000)*Tfs + Tc + Tw) * Th ,  ty = 0
  vert:   ty =  (w1 - Tj/1000)*Tfs + Tc + Tw       ,  tx = 0   (no Th!)
  Th = Tz/100 ;  Tj = TJ number (0 for Tj/'/") ; +Tj moves LEFT/DOWN
  Tw ONLY for single-byte code 32 (never in Identity-H)
  w0 = Widths[code-FirstChar]/1000 | MissingWidth/1000 | W/DW lookup /1000
       | Type3: Widths[i] through FontMatrix linear part

MATRICES
  Trm = [Tfs*Th, 0, 0, Tfs, 0, Ts] x Tm x CTM
  device origin = (Trm.e, Trm.f)
  rotation      = atan2(Trm.b, Trm.a)
  sx            = hypot(Trm.a, Trm.b)
  font size     = hypot(Trm.c, Trm.d)      [ or |ad-bc|/hypot(a,b) for perp height ]
  mirrored      = (a*d - b*c) < 0
  device advance for text-space tx: ( tx*a/(Tfs*Th) , tx*b/(Tfs*Th) )

DELETING A SHOW-OP
  1. next Tm-writer is Td/TD/Tm/T*/'/"/ET  ->  just delete it. exact, no metrics.
  2. else  ->  [ N ] TJ  with
         N = -1000*SUM(w0) - 1000*n*Tc/Tfs - 1000*n32*Tw/Tfs + SUM(orig TJ numbers)
       (Th cancels; integer-exact when Tc=Tw=0; needs Tfs != 0)
  3. else  ->  keep the op, {0,1,2}->3 and {4,5,6}->7 via paired Tr ops (no q/Q).
               NOT redaction: every extractor still reads it.
  NEVER  'a b c d e f Tm'  (clobbers Tlm)
  NEVER  'tx 0 Td'         (clobbers Tlm AND resets Tm from Tlm)

RENDER MODES
  0 fill | 1 stroke | 2 fill+stroke | 3 invisible
  4 fill+clip | 5 stroke+clip | 6 fill+stroke+clip | 7 clip only
  4-7 accumulate glyph outlines; the union becomes the clip AT ET.
  A clipping-mode text object with zero glyphs yields an EMPTY clip.
  Mode 3 text is extracted by Acrobat, pdftotext, PDF.js, PDFBox, iText,
  pdfminer, PDFKit, and every indexer. It is how OCR layers work.
```