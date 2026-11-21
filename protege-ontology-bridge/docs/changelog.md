# Changelog

## 1.0.2 — real editor screenshots instead of diagrams

- `spec.report.screenshots` accepts per-anchor lists of Protégé screenshots
  (`concept`, `hierarchy`, `metrics`, `individuals`, `queries`) with optional `crop`
  (relative x0, y0, x1, y1), `width` in cm and a caption.
- When a screenshot exists for an anchor, the corresponding generated figure is skipped:
  a real editor capture always beats a matplotlib diagram. The concept map is still drawn,
  because Protégé cannot produce it as a single view.
- Uniform white margins are trimmed automatically and figures are numbered by key, so the
  body text cites the number of whatever was actually inserted.
- Section 6 gained a metrics subsection; figures order follows the document, not the code.

## 1.0.1 — domain-neutral reports

## 1.0.1 — domain-neutral reports

- **Report prose is no longer tied to one domain.** `spec.report` (all keys optional) overrides the cover
  subtitle, the “chosen domain” sentence, the domain-description paragraphs, the individuals note, the DL
  query note and the conclusion paragraphs. Missing keys fall back to text derived from the spec itself
  (top-level class names, counts, defined-class names).
- `spec.report` is now preserved by the spec normaliser (it used to be dropped, so overrides silently did
  nothing and every report spoke about equipment maintenance).
- Section 5 uses the ontology's own top-level classes as the disjointness example instead of a hardcoded
  pair.

## 1.0.0 — first release

## 1.0.0 — first release

### Tools

- `onto_status` — Protégé home, bundled JVM, HermiT jar/version, jpype version, jar cache, engine path,
  detected Python; `ready` flag plus `hint`.
- `onto_check` — spec validation without a JVM: uniqueness, resolved parents/domains/ranges/types/targets,
  hierarchy cycles, datatype range check, assignment-minima warnings.
- `onto_build` — spec → `.owl` through the OWL API (RDF/XML, optional Turtle); returns bytes, axiom count,
  IRI.
- `onto_reason` — HermiT consistency, unsatisfiable classes, inferred hierarchy (tree + flat), inferred types
  of every individual, answers to the spec's DL queries; can save the full report as JSON.
- `onto_report` — three print-size figures (inferred hierarchy, top-level concept map, DL-query results) plus
  an eight-section Russian DOCX built on a previously submitted report as style donor.
- `onto_all` — build + reason + figures + report in one call; `ok: false` when the ontology is inconsistent.
- `onto_help` — `overview` / `spec` / `workflow` cheat sheet.

### Engine

- JVM bootstrap via JPype against Protégé's bundled JRE 11; nested-jar extraction (OWL API `lib/*.jar`,
  HermiT root jars) into an ASCII cache under `%LOCALAPPDATA%\onto-engine\cache`.
- File IRIs built with `java.io.File.toURI()` so Cyrillic/Chinese paths work.
- Literals typed from the data property's declared range — prevents the `xsd:double` vs `xsd:float`
  inconsistency.
- Manchester-syntax reader for `and` / `or` / `not` / `some` / `only` / `value` with parentheses; unknown
  names raise an error instead of creating entities silently.
- Inverse property names accepted in assertions and in expressions (`measurementOf`, `resolves`, …).
- Report template discovery from the spec directory upwards, the engine tree and the cwd; `template`
  argument and `ONTO_REPORT_TEMPLATE` override.
- Table headers repeat across pages; captions keep with their tables; “new knowledge” counts only
  non-trivial inferences (defined-class membership), not inherited ancestors.

### Verified

- Protégé 5.6.9 + JRE 11.0.25 + OWL API 4.5.29 + HermiT 1.4.3.456 + jpype 1.7.1.
- 25-class equipment-maintenance ontology: consistent, no unsatisfiable classes, 8 non-trivial inferences,
  5 DL queries answered.
- `scripts/selfcheck.mjs --full` passes both from the workspace copy and from `$DSH_HOME/plugins/`.

### Known limits

- No Protégé GUI screenshots (the bridge is headless by design).
- Manchester subset only — no cardinality restrictions.
- No performance work beyond lab-sized ontologies.
