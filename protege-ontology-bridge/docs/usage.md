# Usage

## 0. Prerequisites

- **Protégé 5.6.x** installed (the bridge needs `bundles/`, `plugins/` and `jre/bin/server/jvm.dll`).
  Set `PROTEGE_HOME` if it is not in a usual place.
- **Python 3.9+** with:

  ```bash
  python -m pip install jpype1 matplotlib python-docx networkx
  ```

- For the DOCX step: a previously submitted `.docx` of the same course as the style donor (optional; the
  engine searches for one, otherwise pass `template`).

## 1. Check the toolchain

```text
onto_status {}
```

Key fields: `ready`, `protegeHome`, `hermitVersion`, `jpypeVersion`, `cacheRoot`. If `ready` is false the
`hint` tells you what is missing.

## 2. Write the spec

A JSON file; see `onto_help { "topic": "spec" }` for every field. Minimal but lab-grade skeleton:

```json
{
  "iri": "http://www.semanticweb.org/spbpu/tii/lab4/equipment-maintenance",
  "label": "Онтология технического обслуживания оборудования",
  "language": "ru",
  "classes": [
    {"name": "Equipment", "comment": "Оборудование"},
    {"name": "Pump", "parent": "Equipment", "comment": "Насос"},
    {"name": "Failure", "comment": "Отказ"},
    {"name": "Overheating", "parent": "Failure", "comment": "Перегрев"}
  ],
  "disjointGroups": [["Equipment", "Failure"]],
  "objectProperties": [
    {"name": "hasFailure", "domain": "Equipment", "range": "Failure", "inverse": "isFailureOf"}
  ],
  "dataProperties": [{"name": "hasSerialNumber", "domain": "Equipment", "range": "string"}],
  "classAxioms": [
    {"subject": "EquipmentWithFailure", "kind": "equivalentTo",
     "expression": "Equipment and hasFailure some Failure"}
  ],
  "individuals": [
    {"name": "Pump_101", "types": ["Pump"],
     "objectAssertions": [{"property": "hasFailure", "target": "Failure_Overheat_1"}],
     "dataAssertions": [{"property": "hasSerialNumber", "value": "P-101-2023"}]},
    {"name": "Failure_Overheat_1", "types": ["Overheating"]}
  ],
  "queries": [
    {"name": "Q1", "expression": "Equipment and hasFailure some Failure", "ask": "individuals"}
  ]
}
```

### Modelling checklist

- 10–15 classes minimum, with a real hierarchy (not 15 siblings).
- 5–7 object properties, each with `domain` and `range`; declare `inverse` for paired relations.
- 3–5 data properties; the `range` decides the literal datatype (`xsd:float` vs `xsd:double` matters).
- 8–12 individuals, each with a type; assert at least a few object and data properties.
- Disjointness on the top categories; **do not** put defined classes into a sibling disjoint group.
- Several `some`/`only` axioms; prefer **positive** definitions (see `docs/troubleshooting.md`).
- 3–5 DL queries that answer real questions about the model.

### Domain prose for the report

The report body is domain-neutral by default. To make it speak about a concrete industry, add an optional
`report` object to the spec — every key is optional:

```json
"report": {
  "subtitle": "Онтология производства твёрдых лекарственных форм",
  "domainTitle": "производство фармацевтических препаратов",
  "scope": "В качестве предметной области выбрано …",
  "domain": ["первый абзац раздела 4", "второй абзац", "третий абзац"],
  "individualsNote": "чем примечателен набор индивидов",
  "queriesNote": "на какие вопросы отвечают DL-запросы",
  "conclusions": ["первый абзац выводов", "второй", "третий"]
}
```

Missing keys fall back to text derived from the ontology (top-level classes, counts, defined classes), so
switching domain never requires touching the engine.

## 3. Validate without the JVM

```text
onto_check { "spec": "D:/work/spec.json" }
```

Everything in `error` must be fixed. `warnings` are the assignment minima.

## 4. Build

```text
onto_build { "spec": "D:/work/spec.json", "out": "D:/work/ontology.owl", "turtle": true }
```

Open the `.owl` in Protégé once if the assignment expects UI screenshots; the file is produced by the OWL
API so it loads without normalisation warnings.

## 5. Reason and query

```text
onto_reason { "owl": "D:/work/ontology.owl", "spec": "D:/work/spec.json",
              "saveJson": "D:/work/reasoning.json" }
```

Then read, in this order:

1. `consistent` — if false, stop and fix.
2. `unsatisfiable` — an empty list is the expected result.
3. `hierarchy.tree` — what Protégé's class tab shows after classification.
4. `individualTypes` — inferred membership per individual (the interesting part).
5. `queries[]` — `entities` and `count` per DL query.

A `count: 0` answer is legitimate under the Open World Assumption; report it as "not entailed", not
"false".

## 6. Report

```text
onto_report { "spec": "D:/work/spec.json", "out": "D:/work/report.docx",
              "owl": "D:/work/ontology.owl", "template": "D:/refs/prev-report.docx" }
```

`template` is a previously submitted report of the same course: its cover, fonts, heading styles and table
style are reused, only the lab number/topic/subtitle and the body are replaced. Without it the engine
searches the spec directory, its parents, the engine tree and the cwd for a `reports/*.docx`.

The DOCX contains: цель, задачи, краткие теоретические сведения, описание предметной области,
концептуальная модель (+ class/object-property/data-property tables, concept-map figure), построение
онтологии в Protégé (+ inferred hierarchy figure, individuals table), работа reasoner'а и DL-запросы
(+ inferred-types table, query table, query-results figure), выводы.

To get a PDF, convert with Word (`Word.Application` COM) or LibreOffice—the engine deliberately writes only
`.docx` so the style donor keeps its pagination.

## Screenshots from Protégé

Whenever a figure can be a real editor capture, use one — the engine prefers it over the generated
diagram. Register screenshots in the spec:

```json
"report": {
  "screenshots": {
    "hierarchy":   [{"path": "D:/shots/class-tree.png", "caption": "…", "crop": [0, 0.03, 0.62, 0.72], "width": 15.5}],
    "metrics":     [{"path": "D:/shots/metrics.png", "width": 13.2}],
    "queries":     [{"path": "D:/shots/dl-query.png", "crop": [0.30, 0.07, 0.70, 0.39], "width": 14.2}],
    "individuals": [{"path": "D:/shots/individuals.png"}],
    "concept":     []
  }
}
```

`crop` is in relative fractions of the image, `width` in centimetres, `caption` becomes the figure
caption. Anchors with a screenshot skip the generated figure; anchors without one keep it.

## 7. One-shot

```text
onto_all { "spec": "D:/work/spec.json", "outdir": "D:/work/out" }
```

Produces `ontology.owl`, `reasoning.json`, `figures/fig1_class_hierarchy.png`,
`figures/fig2_concept_map.png`, `figures/fig3_query_results.png`, `report.docx`. `ok` is false when HermiT
finds the ontology inconsistent, so a broken model never ships a report.

## 8. Command line (no DSH)

```bash
python plugin/engine/cli.py status
python plugin/engine/cli.py check  --spec spec.json
python plugin/engine/cli.py build  --spec spec.json --out ontology.owl
python plugin/engine/cli.py reason --owl ontology.owl --spec spec.json --save-json reasoning.json
python plugin/engine/cli.py report --spec spec.json --out report.docx
python plugin/engine/cli.py all    --spec spec.json --outdir out
```

Each command prints exactly one JSON object; exit code is `0` on success, `1` when `ok` is false (an
inconsistent ontology also exits `1`).
