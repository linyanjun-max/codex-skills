# OOXML pitfalls that make Word reject a .docx

Word reports every structural problem as the same two useless messages:

- `文件可能已经损坏。` / "The file may be corrupted."
- `Word 在试图打开文件时遇到错误。` / generic open failure

There is no line number and no schema validation available offline. These are the
five traps actually hit while building this toolkit, in the order they cost time.
Each shows the failing shape and the correct one.

**Before suspecting any of these, re-run under `danger-full-access`.** Under the
normal sandbox Word cannot reach its own profile, and it reports *valid* files as
corrupt. That false positive wasted a full debugging cycle.

---

## 1. `sectPr` child order — the classic

`CT_SectPr` puts the header/footer references (`EG_HdrFtrReferences`) **first**,
before `footnotePr`, `pgSz`, `pgMar`, … Putting `footerReference` last is invalid.

```xml
<!-- WRONG -->
<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar .../>
  <w:footerReference w:type="default" r:id="rIdFooter1"/>
</w:sectPr>

<!-- RIGHT -->
<w:sectPr>
  <w:footerReference w:type="default" r:id="rIdFooter1"/>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar .../>
</w:sectPr>
```

Same discipline everywhere: `w:pPr` order is `pStyle, keepNext, …, tabs, spacing,
ind, jc, outlineLvl`; `w:rPr` order is `rFonts, b, bCs, i, iCs, …, color, sz, szCs`.
Building `pPr` by "pStyle, jc, then spacing" produces `spacing` after `jc` and is
wrong.

## 2. `m:func` — the function name goes in `m:fName`, not `m:e`

`CT_Func` is `funcPr?, fName, e`. Emitting `<m:func><m:funcPr/><m:e>sin</m:e></m:func>`
is schema-invalid and Word refuses the whole package.

The pragmatic fix: don't build `m:func` at all. Render ordinary function names as
plain upright runs (`<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r>`),
which Word displays identically, and reserve `m:limLow` for names that take an
under-limit (`\lim_{s\to 0}`).

## 3. Never nest `m:e` inside an argument container

Every OMML argument container (`m:num`, `m:den`, `m:sub`, `m:sup`, `m:lim`, `m:e`,
`m:deg`) accepts a **sequence** of math elements directly. So a converter must pass
a *list* of elements, not a pre-wrapped `<m:e>`:

```xml
<!-- WRONG: m:e inside m:e (and here also inside m:f's operand) -->
<m:e><m:e><m:r><m:t>x</m:t></m:r></m:e></m:e>

<!-- RIGHT -->
<m:e><m:r><m:t>x</m:t></m:r><m:f>…</m:f></m:e>
```

This is why the parser here returns Python lists everywhere (`parse_group`,
`parse_seq`, `_nary_operand`) and only ever creates `m:e` once, at the point of use.

## 4. `_nary_operand` must go through the sequence parser

A subset of the bug above, but it survived several fixes because it only triggers on
a complex operand. Collecting an n-ary operand with a bare atom parser silently
mishandles `^`, `_` and `{…}`:

```xml
<!-- WRONG: stray empty run + nested m:e produced for \sum_{i=1}^{n}\frac{a}{b}e^{s_it} -->
<m:e><m:f>…</m:f><m:r><m:t>e</m:t></m:r><m:r><m:t></m:t></m:r>
     <m:e><m:sSub>…</m:sSub><m:r><m:t>t</m:t></m:r></m:e></m:e>
```

`\sum_{i=1}^{n}x` passes (single atom operand) while `\sum_{i=1}^{n}\frac{a}{b}` fails
— which is exactly the kind of symptom that sends you looking in the wrong place.
Route it through `parse_seq(stop='}', stop_chars=')]}', stop_right=True)`.

## 5. Regex alternation ordering in the record parser

`re` alternation is first-match, not longest-match:

```python
# WRONG: "#EQN 1.1 ..." matches "EQ", body becomes "N 1.1 ..."
r'^#(H1|H2|H3|H4|P|EQ|EQN|FIG|BUL|CAP|NOTE)\s*(.*)$'

# RIGHT
r'^#(EQN|H1|H2|H3|H4|P|EQ|FIG|BUL|CAP|NOTE)\s*(.*)$'
```

This one is nasty because it does not corrupt the file — it silently destroys every
equation number, turning `(1.13)` into literal text `N 1.13`. Always diff the
preserved equation numbers against the source text layer (`validate.py --eqnums`).

---

## Bisecting a rejection

Word gives no location, so reduce the document until it opens. This took three
rounds and is worth automating.

**Level 1 — per-chunk.** Build one .docx per `tr/chunk_NN.md` and open each in a
single Word session. Failing chunks name themselves.

**Level 2 — per-kind.** For each failing chunk build three documents: text-only,
equations-only, figures-only. In practice equations are almost always the cause;
figures and plain text rarely are.

**Level 3 — per-construct.** Build one tiny document per OMML construct
(`\frac`, `\sqrt`, `\int_{a}^{b}`, `\sum_{i=1}^{n}`, `\lim_{x\to 0}`,
`\begin{cases}`, `\overline{x}`, `A'(s)`, …) and open them all. This isolates the
element in one pass.

**Level 4 — sub-expression.** If a construct passes alone but a real equation fails,
split the equation into pieces and test each. That is how the nested-`m:e` bug
(§3) and the operand bug (§4) were found: `\sum_{i=1}^{n}x` passed while
`\sum_{i=1}^{n}\frac{B(s_i)}{s_iA(s_i)}e^{s_it}` failed.

Open all probes inside **one** Word instance — COM activation costs ~10 s each.

---

## Other things worth knowing

- **`m:oMath` may sit directly in `w:p`**; `m:oMathPara` is only needed for
  display-math paragraph properties. A bare `m:oMath` is fine.
- **Numbered equations with tabs**: give the paragraph
  `<w:tabs><w:tab w:val="center" w:pos="4706"/><w:tab w:val="right" w:pos="9412"/></w:tabs>`
  (twips, measured from the left text margin) and emit
  `[tab] <m:oMath> [tab] (1.1)`.
- **Word COM automation needs `danger-full-access`.** Also kill stale `WINWORD`
  processes and point `TEMP`/`TMP` at the real user temp dir.
- **Validate the package yourself** before blaming Word: every part must parse,
  every `r:embed` must resolve to a declared relationship, and `[Content_Types].xml`
  must list every part type you ship.
- `pdftotext -bbox` is the reliable way to find *text* positions for cropping;
  it cannot tell you where a vector drawing sits, which is why vector-figure crops
  need eyeballing.
