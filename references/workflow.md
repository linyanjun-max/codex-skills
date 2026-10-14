# Translation workflow: chunk format, subagent prompts, QA

## Why subagents

A 100+ page technical book is far too much for one context, and per-page vision
reading is the bottleneck. Split the pages into **4-page chunks**, one subagent per
chunk, running in background batches of ~7. Each subagent reads only its own pages
and writes exactly one file, so nothing depends on a long shared context.

Prompt size matters more than you would expect: the full glossary belongs in a file
the subagent reads (`references/glossary-ru-zh.md`), not inline in every prompt.

## The record format (one record per line)

Subagents write `<work>/tr/chunk_NN.md`. Every content line starts with a marker so
parsing is unambiguous — do **not** use a markdown/LaTeX hybrid, because `#`-prefixed
LaTeX and prose containing `|` will corrupt it.

| Marker | Meaning |
|---|---|
| `@@PAGE <n>` | page marker, **required at the start of every page** (n = PDF page) |
| `#H1 ` … `#H4 ` | headings |
| `#P ` | body paragraph (may contain inline `$...$`) |
| `#EQN <number> <latex>` | numbered display equation (number without brackets) |
| `#EQ <latex>` | unnumbered display equation |
| `#FIG <filename> \| <caption>` | figure at this position |
| `#BUL ` | list item |
| `#CAP ` | explanatory line under a figure/table, no first-line indent |

Everything is ignored except these markers, blank lines and code fences.

## LaTeX subset the converter accepts

`\frac \sqrt \sqrt[n]`, `^ _` (incl. `x_i^2`), `\left( \right)` (treated as literal
delimiters), `\int_{a}^{b} \sum_{i=1}^{n} \prod \oint`, `\lim_{x\to 0}`,
`\overline \bar \dot \ddot \hat \tilde \vec`, `\begin{pmatrix}`,
`\begin{cases}`, `\begin{aligned}`, Greek letters, `\cdot \times \pm \le \ge \ne
\approx \to \infty \partial`, `\text{...}` for upright multi-letter names
(**use `\text`, not `\mathrm`**), spacing `\, \; \quad`.

Ask for: no `\tag`, no `\label`, no `\begin{equation}`, no macro definitions.

Multi-letter Cyrillic subscripts must be braced: `W_{\text{ДПТ}}`, not `W_ДПТ`.
Single letters are fine bare: `T_Д`.

## Subagent prompt template

Substitute PAGES, FILE LIST and FIG LIST. Keep it this literal — it is what produced
a complete, omission-free translation.

```
Produce a complete, faithful Simplified-Chinese translation of a Russian
automatic-control textbook.

STEP 1 - Read the mandatory translation guide FIRST (output format, LaTeX
conventions, term glossary):
<WS>\_translate_work\tr\_GUIDE.md

STEP 2 - Read each rendered page image with the read_image tool. These are the
AUTHORITATIVE source:
<WS>\_translate_work\pages\p-013.png
<WS>\_translate_work\pages\p-014.png
<WS>\_translate_work\pages\p-015.png
<WS>\_translate_work\pages\p-016.png
NOTE the filename form: a hyphen plus three digits (p-013.png, NOT p013.png).

A Russian plain-text extract exists at ...\_translate_work\ptext\p013.txt (and
p014..p016 .txt). It LOST every Greek letter and mathematical symbol (the PDF
uses custom-encoded symbol fonts), so use it only as a spelling aid for Russian
words - NEVER take a formula, symbol or subscript from it. Always read formulas
from the page image.

STEP 3 - Figures on your pages (use the EXACT filename in a
`#FIG <filename> | <caption>` line at the position where the figure appears):
fig_p013_00.png, fig_p013_01.png, ...
Translate each original caption and, if it contains Russian labels, append a
Chinese label key in parentheses after the caption.

STEP 4 - Write the complete translation with the write tool to exactly:
<WS>\_translate_work\tr\chunk_04.md

MANDATORY RULES
- Begin each page's content with a line `@@PAGE <n>` (PDF page numbers 13..16).
- Translate EVERYTHING and omit nothing: headings, every paragraph, every
  formula (display and inline), every figure caption, list items, tables,
  footnotes. No summarising, no merging, no reordering, no untranslated Russian
  left in running prose.
- Keep the original symbol system inside formulas, including Cyrillic subscripts.
  Translate Russian abbreviations into Chinese only in running prose.
- Every numbered formula must appear as `#EQN <number> <latex>` preserving its
  number.
- Do not output running heads or bare page numbers.
- If a page contains only a page number, emit just its `@@PAGE` line.

Self-check before finishing: the file must contain exactly 4 `@@PAGE` lines
(13, 14, 15, 16) and every page image's content must be represented.
Reply with exactly one line: DONE chunk_04 pages 13-16
```

Per-chunk variations worth adding:

- **Table pages** (appendix data tables): say explicitly *"transcribe every row, every
  column entry and every variant number; do not collapse repeated values"*, and state
  the cell convention (`one #P line per row, cells separated by " | "`). Subagents
  converge on this on their own, but tell them so all chunks agree.
- **First chunk** (cover/colophon/contents): list the pages as 1..N and require each
  cover line as its own `#P` in original order; blank pages get only their `@@PAGE`.
- **Appendix pages**: captions like `Рис. П1.x` may not exist — the figures can be
  table cells. Tell the subagent to use the row/device name as the caption instead of
  inventing a figure number.
- **Inline text**: if pages are mostly one table (e.g. `Схема N` + figure + parameter
  table), say so; otherwise the subagent may over-summarise.

## Guidance that materially improves fidelity

Put these in the guide file the subagents read:

- **The image is authoritative; the text layer is a spelling aid.** State this twice.
- **Do not correct the book.** Original typos (mismatched polynomial coefficients,
  `s→∞` where `s→0` was meant, a duplicated term) must be reproduced and reported.
  Otherwise the translator silently "fixes" things and you lose traceability.
- **Flag mid-sentence page breaks** so the next chunk's translator expects to continue
  the sentence; a 4-page chunk boundary will cut sentences roughly once per chunk.
- **Report per chunk**: page markers emitted, figure files used, formula numbers
  preserved, and any source typography reproduced rather than fixed. These reports are
  the QA trail and they caught real problems (missing figures, misread glyphs).

## Incremental QA loop

Do not launch all chunks blind. Run a **2-chunk pilot**, read both outputs against
their page images, fix the guide, then launch the rest.

After the pilot, the check that pays for itself: look for pages that carry a caption
(`Рис. N.N`) but no raster figure. In the source book that turned up four pages of
Mathcad/MATLAB plots stored as vector art which `pdfimages` cannot see. Subagents
flagged them because they were asked to report "figures I had to emit as `#CAP`
because no image file was supplied" — so the instruction to report anomalies is not
decoration.

## Assembling and the front matter

`assemble.py` handles the parts that need document-level decisions:

- **cover page**: the first N lines are centred by position (small header block,
  author, large bold title, then publisher and year) and the page ends with a break;
- **contents page**: emits a live Word `TOC` field *and* the original translated
  contents list under `原书目录（页码为原书页码）`, because the original page numbers
  no longer apply to the new document;
- **blank pages** are skipped entirely so the output has no blank pages;
- **each `#H1` starts a new page**.

## Final checks before delivery

1. `validate.py` reports OK (coverage, figures, LaTeX, stray captions, eq numbers).
2. `check_docx.ps1` opens it under full access and reports sane counts.
3. Render 3–4 PDF pages of the result and **look at them**: equations present and
   numbered, figures embedded, captions translated, no half-empty page.
4. Scan every output page for blank pages (render at 50 dpi, measure ink density).
5. Delete the work directory. Deliver one .docx.
