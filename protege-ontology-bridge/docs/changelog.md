# Changelog

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
