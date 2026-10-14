---
name: pdf-to-word-translation
description: "Complete Chinese translation of a formula- and figure-heavy PDF (textbook, manual, handout) into a Word .docx with nothing skipped: headings, paragraphs, every formula, captions, table rows and footnotes. Matches requests such as 「把这份 PDF 完整翻译成中文 Word」「翻译这本书，公式和图都不能少」, especially Russian/European engineering or science material. Formulas become native editable Word equations; figures are embedded with translated captions; page coverage is verified; no blank pages; runs fully offline."
whenToUse: "Use when the user asks to fully translate a PDF book/manual/handout into a Word document - especially scientific or engineering material containing mathematics, Greek symbols, circuit/block diagrams, or graphs - and expects formulas, figures, tables and page coverage preserved rather than summarised. Also use when you must generate a .docx without python-docx or any network access."
---

# PDF → translated Word document

Produce a **complete** Word translation of a PDF: every heading, paragraph, formula,
caption, table row and footnote, with formulas as **native, editable Word equation
objects** and figures embedded at their original positions.

## The one thing that decides success

On most scanned/exported technical PDFs, `pdftotext` **silently loses Greek letters and
math symbols** because the PDF uses custom-encoded (Symbol) fonts. A formula such as
`ω₀ − ω = ±Δω` extracts as `0   .`. Therefore:

> **The rendered page image is the only authoritative source.**
> Plain text extraction is a spelling aid for the surrounding prose and may **never** be
> used to reconstruct a formula, symbol, subscript or variable name.

Failing to follow this produces a document that looks complete but is quietly wrong.

## Pipeline

Work in `<workspace>/_translate_work/`. Never leave it behind: the user gets one .docx.

| Phase | Action | Script |
|---|---|---|
| 0 | Recon: page count, fonts, image inventory, is text extractable? | `pdfinfo`, `pdffonts`, `pdfimages -list` |
| 1 | Render every page to PNG at 150 dpi (the model reads these) | `pipeline_prepare.py` |
| 2 | Extract figures: raster images composited with their soft masks; crop vector figures | `pipeline_prepare.py`, `crop_vector_figs.py` |
| 3 | Per-page Russian/plain text + chunk plan | `pipeline_prepare.py` |
| 4 | Translate with parallel subagents, one chunk file each | prompts from `references/workflow.md` |
| 5 | Validate coverage, LaTeX, figure references | `validate.py` |
| 6 | Assemble chunks into the .docx | `assemble.py` |
| 7 | **Open the result in Word** and render a PDF to eyeball it | `check_docx.ps1` |
| 8 | Delete the work directory; deliver only the .docx | — |

### Phase 0 — recon (always do this first)

```powershell
$env:MIKTEX_LOG_DIR=""; pdfinfo "<pdf>"            # page count, producer
pdffonts "<pdf>"                                    # symbol/custom fonts => expect lossy text
pdfimages -list "<pdf>"                             # how many figures are raster
pdftotext -layout -enc UTF-8 "<pdf>" out.txt        # confirm whether Greek survives
```
If the extract shows missing symbols, you **must** use the vision route. Confirm by
rendering one formula-heavy page and reading it.

### Phase 1–3 — prepare

```powershell
python scripts/pipeline_prepare.py --workspace "<ws>" --pdf "<relative/path.pdf>"
```
Produces `_translate_work/{pages,figs,ptext,img,tmp}`, `figs_manifest.txt`,
`pages.json`, `chunks.json`, and prints **pages that carry a figure caption but have no
raster image** — those are vector graphics needing phase 2b.

### Phase 2b — vector figures

`pdfimages` cannot extract vector art (e.g. Mathcad/MATLAB plots pasted as EMF). For each
page that `pipeline_prepare.py` flagged:

1. Read `_translate_work/pages/p-NNN.png` yourself and see where the drawing sits.
2. Get exact text-line boxes to fix the band:
   `python scripts/crop_vector_figs.py --workspace "<ws>" --suggest --pages 22`
3. Crop with explicit bands (PDF points, 72 dpi):
   `python scripts/crop_vector_figs.py --workspace "<ws>" --page 22 --idx 0 --top 246 --bottom 458`
4. **Read the produced PNG back** and confirm the caption text and body text are excluded.

Auto-detection alone is unreliable (figure-internal axis labels look like body text), so
always verify visually.

### Phase 4 — translate in parallel

Split into chunks of **~4 pages**; launch one subagent per chunk (background), ~7 at a
time. Each subagent reads its page images, writes one `tr/chunk_NN.md`, and returns a
one-line DONE. Use the prompt template in `references/workflow.md` verbatim — it encodes
the output format, the LaTeX subset, the term glossary and the completeness rules.

Ask each subagent to report: page markers emitted, figure files used, formula numbers
preserved, and any source typography it chose to reproduce rather than "fix".
Those reports are your QA trail.

### Phase 5 — validate before assembling

```powershell
python scripts/validate.py --workspace "<ws>"
```
Hard gates: **every source page present**, **0 missing image files**, **0 LaTeX parse
errors**, **0 caption-looking lines without a figure**. Also diff the preserved equation
numbers against the source:

```powershell
python scripts/validate.py --workspace "<ws>" --eqnums "<ws>/_translate_work/text_layout.txt"
```

### Phase 6 — assemble

```powershell
python scripts/assemble.py --workspace "<ws>" --out "<ws>/<Title>.docx" `
    --cover-page 1 --toc-page 4 --skip-pages 2
```
Cover lines are centred by position; the contents page gets a live Word `TOC` field plus
the original (translated) contents list; each `#H1` starts a new page.

### Phase 7 — verify in Word (do not skip)

```powershell
powershell -File scripts/check_docx.ps1 -Path "<out.docx>"
```
This runs under `sandbox_permissions: danger-full-access` (Word must reach its own
profile and `%TEMP%`; under the normal sandbox it fails with
`Word 未能引发事件` / "file may be corrupted" **even for a valid file**). It reports page
count, images, equation count, and exports a PDF. Then render 3–4 PDF pages and read
them to confirm equations, numbering and figures actually look right.

### Phase 8 — clean up

```powershell
Remove-Item -LiteralPath "<ws>/_translate_work" -Recurse -Force
```
Leave only the delivered .docx (plus whatever the user already had).

## Non-negotiable output rules

- **Keep the source's symbol system inside formulas**, including Cyrillic subscripts
  (`W_{\text{ДПТ}}`, `T_Д`, `K_{Д1}`). Translate abbreviations only in running prose.
  This keeps the translation cross-checkable against the original.
- **Preserve every formula number** (`#EQN 1.13 …`), rendered right-aligned with the
  equation centred, as in the source.
- **Translate figure captions**; since labels inside a raster figure cannot be re-drawn,
  append a Chinese label key in parentheses, e.g.
  `图 1.1 功能结构图（ЗУ—给定装置；ССУ—比较求和装置；УУ—控制装置；ОУ—控制对象；ОС—反馈）`.
- **Reproduce source typos faithfully** and report them; never silently correct the book.
- No blank pages. If the source has a blank page, emit nothing for it.

## Toolkit notes

`scripts/docxkit/` is a self-contained OOXML writer plus LaTeX→OMML converter. It needs
only `lxml` + `Pillow`, so it works with **no network access** — which matters because
`pip install python-docx` frequently cannot reach PyPI. Usable on its own:

```python
from docxkit import Docx
d = Docx()
d.h(2, "标题"); d.p("行内公式 $x^2$"); d.eq(r"\frac{K}{Ts+1}", "1.1")
d.fig("figs/fig_p008_00.png", "图 1.1 功能结构图")
d.save("out.docx")
```

Before hand-editing the generator, read `references/ooxml-pitfalls.md`. It lists the five
specific schema/tooling traps that made Word reject otherwise plausible output, each with
the failing and correct shape. Word's "file may be corrupted" message gives no detail, so
that file is the fast path.

For a different source language, replace the glossary in `references/guide-template-ru-zh.md`
and keep the rest of the workflow.
