---
name: protege-ontology-bridge
description: "Build OWL 2 ontologies and reason over them headlessly through Protégé's own JVM and HermiT, using seven DSH tools — onto_status, onto_check, onto_build, onto_reason, onto_report, onto_all, onto_help. Use when the user asks to model a domain as an ontology, build a Protégé/OWL lab, check ontology consistency, infer class membership, run DL queries, or produce an ontology report. Requires that the plugin row is loaded; if the tools are not in the tool list, say so instead of pretending to reason."
whenToUse: "Use when a DSH session must turn domain knowledge into a reasoned OWL model: ontology labs (Protégé, classes/object properties/data properties/individuals/disjointness/restrictions/DL queries), consistency checks, inferred classification, or a DOCX report with class tables and query results. Also use when a previous run reported an inconsistent ontology and you need the evidence before fixing the spec."
metadata:
  platform: windows
  requires: "Protégé 5.6.x (bundled JRE 11 + HermiT 1.4.3); Python 3 with jpype1, matplotlib, python-docx, networkx"
---

# protege-ontology-bridge — OWL 2 ontology toolchain

This skill documents a **DeepSeek Harness host plugin** that exposes Protégé's own JVM, the OWL API and
the HermiT reasoner as model-callable tools. It is not a "`SKILL.md` only" skill: the capability lives in
[`plugin/`](plugin/), installed into a DSH home by one composition-patch insert.

**If `onto_status` is not in the tool list, the plugin row is not loaded.** Say that plainly; never
describe reasoning you did not run.

## What it does

Protégé has no CLI and OWL API/HermiT are Java libraries, so the bridge drives them from Python through
JPype. The agent never clicks a UI: it writes a declarative **spec (JSON)** and the bridge turns it into a
real `.owl` file, reasons over it with HermiT, and renders a report.

| Tool | Runs | Returns |
| --- | --- | --- |
| `onto_status` | — | Protégé home, bundled JVM, HermiT jar/version, jpype version, jar cache, engine path, detected Python |
| `onto_check` | no JVM | `counts`, `warnings` (assignment minima), `error` with every invalid reference |
| `onto_build` | OWL API | `owl` path, `bytes`, `axioms`, spec `counts` |
| `onto_reason` | HermiT | `consistent`, `unsatisfiable`, `hierarchy.tree/flat`, `individualTypes`, `queries[]`, `elapsedMs` |
| `onto_report` | all of it | `docx`, `figures`, `tables`, `figuresCount` |
| `onto_all` | all of it | everything above in one call (`ok:false` when inconsistent) |
| `onto_help` | — | `overview` / `spec` / `workflow` cheat sheet |

## Standard workflow

### 0. Detect before anything

```text
onto_status {}
```

If `ready` is false, read `hint` (`PROTEGE_HOME` unset, or `python -m pip install jpype1`) and stop.

### 1. Write the spec, then validate it without a JVM

```text
onto_check { "spec": "D:/work/spec.json" }
```

Fix **every** `error`. `warnings` are the assignment minima (10–15 classes, 5–7 object properties,
3–5 data properties, 8–12 individuals, ≥3 DL queries) — treat them as requirements, not advice.

### 2. Build the ontology

```text
onto_build { "spec": "D:/work/spec.json", "out": "D:/work/ontology.owl" }
```

The file is written by the OWL API (RDF/XML), so Protégé opens it without normalisation warnings.

### 3. Reason and query

```text
onto_reason { "owl": "D:/work/ontology.owl", "spec": "D:/work/spec.json", "saveJson": "D:/work/reasoning.json" }
```

Read `consistent` first. If `unsatisfiable` is non-empty, or `consistent` is false, **do not** report
success: fix the spec (usually a disjointness clash or a restriction no individual can satisfy).

Everything the lab must prove is in this one payload:

- `consistent` + `unsatisfiable` — the reasoner's verdict;
- `hierarchy.tree` — inferred classification (Protégé's class tree);
- `individualTypes` — every individual's inferred classes, including ones nobody asserted;
- `queries[]` — each DL query's `entities` and `count`.

### 4. Generate the report

```text
onto_report { "spec": "D:/work/spec.json", "out": "D:/work/report.docx", "owl": "D:/work/ontology.owl" }
```

The cover and styles are cloned from a previously submitted `.docx` (default: the report sitting in
`<workspace>/reports/`, or the `template` argument). Sections: цель, задачи, теория, предметная область,
концептуальная модель, построение в Protégé, reasoner + DL-запросы, выводы.

### 5. One-shot alternative

```text
onto_all { "spec": "D:/work/spec.json", "outdir": "D:/work/out" }
```

## Spec format (the only input)

```json
{
  "iri": "http://www.semanticweb.org/<you>/<project>",
  "label": "Ontology title",
  "language": "ru",
  "report": {"subtitle": "Ontology subtitle", "domainTitle": "the domain in one phrase",
             "domain": ["section 4 paragraph 1"], "conclusions": ["section 8 paragraph 1"]},
  "classes": [{"name": "Equipment", "parent": "Thing", "comment": "Оборудование"}],
  "disjointGroups": [["Equipment", "Failure", "Worker"]],
  "objectProperties": [{"name": "hasFailure", "domain": "Equipment", "range": "Failure",
                        "inverse": "isFailureOf", "characteristics": ["functional"]}],
  "dataProperties": [{"name": "hasSerialNumber", "domain": "Equipment", "range": "string"}],
  "classAxioms": [{"subject": "EquipmentWithFailure", "kind": "equivalentTo",
                   "expression": "Equipment and hasFailure some Failure"}],
  "individuals": [{"name": "Pump_101", "types": ["Pump"],
                   "objectAssertions": [{"property": "hasFailure", "target": "Failure_Overheat_1"}],
                   "dataAssertions": [{"property": "hasSerialNumber", "value": "P-101-2023"}]}],
  "queries": [{"name": "Q1", "expression": "Equipment and hasFailure some Failure", "ask": "individuals"}]
}
```

Rules the engine enforces (and reports as errors):

- names unique; `parent`/`domain`/`range`/`types`/assertion targets must resolve;
- **inverse names count as properties** — `measurementOf` may be used in assertions;
- data ranges: `string, integer, int, float, double, decimal, boolean, date, dateTime, anyURI`;
- `expression` uses Manchester syntax: `A and B`, `A or B`, `not A`, `p some C`, `p only C`, `p value v`,
  parentheses. Cardinality restrictions are not supported.
- `ask`: `individuals` | `subclasses` | `superclasses` | `equivalent`.

## Report prose

The DOCX body is domain-neutral by default. `spec.report` overrides it field by field —
`subtitle`, `domainTitle`, `scope`, `domain` (list of paragraphs), `individualsNote`, `queriesNote`,
`conclusions` (list). Anything omitted falls back to text derived from the spec, so a new domain is a spec
edit, not a code edit. Never hand-edit `engine/report.py` to change wording.

## Screenshots beat diagrams

If the user can capture the Protégé window, register the captures in `spec.report.screenshots`
(`hierarchy`, `metrics`, `queries`, `individuals`, `concept`) and regenerate: the engine inserts them and
drops the corresponding matplotlib figure. Only the concept map stays generated, because Protégé has no
single view that shows classes with labelled property edges.

## Traps that silently destroy an ontology

1. **`xsd:double` vs `xsd:float`.** A float property declared `xsd:float` with a `96.5` literal becomes an
   `xsd:double` in naive code; combined with `Functional` HermiT then reports the whole ontology
   **inconsistent**. The engine types literals from the property's declared range — keep the range honest.
2. **Open World Assumption kills negative definitions.** `UnresolvedFailure ≡ Failure ⊓ ¬∃resolvedBy.…`
   infers nothing from a *missing* assertion: a model where the relation is simply unrecorded is legal.
   Only define classes positively (`ResolvedFailure ≡ Failure ⊓ ∃resolvedBy.MaintenanceAction`).
3. **Disjointness + overlapping definitions.** Putting a *defined* class into a disjoint group (e.g.
   `Overheating`, `Leakage`, and a class that overlaps them) makes one individual belong to two disjoint
   classes → inconsistent. Keep defined classes out of sibling disjoint groups.
4. **Restrictions nobody satisfies.** `MaintenanceAction ⊑ performedBy some Worker` is fine only if every
   asserted action has a `performedBy`; otherwise classification gets slower and the report misleads.
5. **Empty query results are legitimate.** Under OWA, `count: 0` means "not entailed", not "false". Never
   rewrite the query until it returns something — explain the result.

## What the report may and may not claim

- Reasoning numbers, inference results and DL answers are produced by **real HermiT** — safe to cite.
- The bridge **does not** drive the Protégé GUI: there are no Protégé screenshots. If the assignment
  demands them, open the generated `.owl` in Protégé (Reasoner → HermiT, then the DL Query tab) and ask
  the user to capture them; state clearly that the figures in the DOCX are generated diagrams, not
  screenshots.

## Verify the install

```bash
node plugin/scripts/selfcheck.mjs                 # registration + status + spec check
node plugin/scripts/selfcheck.mjs --full spec.json  # + build + reason + report
```

See [`docs/usage.md`](docs/usage.md), [`docs/architecture.md`](docs/architecture.md),
[`docs/troubleshooting.md`](docs/troubleshooting.md), [`docs/api-verified.md`](docs/api-verified.md).
