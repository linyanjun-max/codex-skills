# Codex Skills Collection

This repository contains reusable Codex skills.

## Available skills

- `pdf-to-word-translation/` — complete translation of technical PDFs into Chinese Word documents.
- `simulink-from-matlab/` — build a clear Simulink model from MATLAB simulation code and an assignment document, preserving plant variables, disturbances, sensors, predictive analysis, RUL, and alarms.

The original PDF translation skill remains available below.

An offline Codex skill for translating Russian and other technical PDFs into complete Chinese `.docx` files while preserving formulas, figures, tables, captions, footnotes, and page coverage.

## What it does

- Renders PDF pages so formulas and symbols are read from the authoritative page image.
- Extracts raster and vector figures and keeps them in document order.
- Produces editable Word equations through OOXML/OMML.
- Validates page coverage, figure references, equation syntax, and missing assets before assembly.
- Verifies the final document in Microsoft Word.

## Installation

Copy this directory into your Codex skills directory, preserving the folder name:

```text
pdf-to-word-translation/
```

The skill is self-contained. Its scripts require Python with `lxml` and `Pillow`, plus local PDF utilities and Microsoft Word for the final visual check.

## Usage

Ask Codex in natural language, for example:

> 把 `manual.pdf` 完整翻译成中文 Word，保留所有公式、图、表格、脚注和编号，不要遗漏任何页面。

For best results, provide the source PDF and specify the desired output location or title.

## License

MIT License. See `LICENSE`.
