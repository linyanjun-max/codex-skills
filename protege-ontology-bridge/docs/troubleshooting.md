# Troubleshooting

Every failure surfaces as `{ "ok": false, "error": "…" }`. Read `error` first, `traceback` (last lines) and
`stderr` second.

## Toolchain

### `Protégé installation not found`

`onto_status` cannot find `bundles/`, `plugins/`, `jre/`. Fix by setting the home explicitly:

```yaml
config:
  protegeHome: 'E:\Protege-5.6.9-win\Protege-5.6.9'
```

The engine also honours `PROTEGE_HOME`. Note the nested folder names: the archive unzips as
`Protege-5.6.9-win\Protege-5.6.9\`, and `bundles/` sits in the **inner** directory.

### `jpype1 is required to drive HermiT`

```bash
python -m pip install jpype1
```

### `Python 3 not found`

The plugin probes `python`, `python3`, `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`,
`D:\anaconda\python.exe`, `C:\Python312\python.exe`. Set `config.pythonExe` for anything else.

### Engine starts but returns no JSON

The plugin reports `engine produced no JSON (exit code N)` plus the last 4 KB of stdout/stderr. Usually a
Python import error in the engine directory: run `python engine/cli.py status` manually to see it.

## Reasoning

### `Inconsistent ontology` / `consistent: false`

HermiT found a contradiction. Common causes, in order of frequency:

1. **Datatype mismatch** — an `xsd:double` value on an `xsd:float` property. The engine types literals by the
   declared range, so check that the range itself is the one you meant.
2. **Disjointness clash** — an individual asserted (or inferred) into two disjoint classes. Typical setup:
   a *defined* class placed in a sibling disjoint group, e.g. `["Overheating", "Leakage", "ResolvedFailure"]`
   with an individual that is both `Leakage` and `ResolvedFailure`.
3. **Impossible restriction** — `p only C` combined with an assertion `p some D` where `C` and `D` are
   disjoint.
4. **Wrong domain/range** — an object-property assertion whose subject/object violates the declared
   domain/range *and* the individual is typed elsewhere, forcing it into a disjoint class.

Diagnose by bisecting the spec: drop `classAxioms`, then `disjointGroups`, then individual assertions.

### Query returns `count: 0` but individuals look right

The Open World Assumption is at work. Two cases:

- **Negative conditions are not entailed.** `Failure and not (resolvedBy some MaintenanceAction)` does not
  collect "failures without a repair": HermiT may complete the model with an unrecorded `resolvedBy`
  successor. Redefine the class positively (`ResolvedFailure ≡ Failure ⊓ ∃resolvedBy.MaintenanceAction`).
- **The class really has no members.** Check `individualTypes` in `reasoning.json` to see what was inferred.

### `unknown name 'X' (not a class, object property or data property of this ontology)`

A typo in a Manchester expression, or you used an inverse property that is not declared anywhere. Inverse
names are accepted **if** some property declares them via `"inverse": "X"`.

### Reasoning is slow

HermiT is worst on large disjunctions and cardinality restrictions. Keep the ontology DL-light for lab
work: hierarchies, `some`/`only`, a few defined classes. Above ~1000 classes expect seconds to minutes.

## Reporting

### `report template not found`

No `.docx` donor was found. Pass one explicitly:

```text
onto_report { "spec": "...", "out": "...", "template": "D:/refs/prev-report.docx" }
```

or set `ONTO_REPORT_TEMPLATE`. The donor must be a report of the same course so its cover paragraphs
(7, 8, 9 from the top and body start at index 27) match the expected layout. For a different template,
adjust `COVER_*` and `BODY_START` in `engine/report.py`.

### Figures are unreadable in the DOCX

Figures are drawn at print size (`figsize` inches ≈ Word width). If you changed the page size or the
`width_cm` in `builder.figure`, regenerate rather than shrink the image: scaling a large raster down makes
labels illegible.

### Word complains about the document

The DOCX is assembled with `python-docx` on top of the donor, so unsupported constructs come from the donor.
Open the donor alone; if it opens cleanly, the generated file will too.

## Plugin loading

### `onto_*` tools are missing

The plugin row is not loaded. Check `$DSH_HOME/cordis.patch.yml`:

```yaml
- insert:
    - id: protege-ontology-bridge
      name: './plugins/protege-ontology-bridge/lib/index.js'
```

The `./` is resolved **relative to the patch file**, so the plugin must be at
`$DSH_HOME/plugins/protege-ontology-bridge/`. Restart DSH—host plugins load at boot.

### Loader error: duplicate row id

The same `id` was inserted twice (e.g. both a bundle patch and a user patch). Keep exactly one insert.

## Self-check

```bash
node plugin/scripts/selfcheck.mjs                    # registration + status + spec check
node plugin/scripts/selfcheck.mjs --full spec.json   # + build + reason + report
```

It loads the module with a fake Cordis context, so it works without DSH running. `SELFCHECK PASSED` is the
gate for publishing changes.
