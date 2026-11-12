---
name: modelio-codesys-bridge
description: "Operate Modelio 4.1 (Jython batch) and CODESYS 3.5 (IronPython headless) from DeepSeek Harness with five bridge tools — bridge_status, codesys_run, modelio_run, bridge_launch_gui, bridge_help. Use when the user asks to edit, author, simulate, or validate UML models in Modelio or IEC 61131-3 projects in CODESYS on Windows. The bridge is a host-level DSH plugin installed through a composition patch; the tools exist only when that plugin row is loaded."
whenToUse: "Use when a DSH session must drive Modelio or CODESYS: create or edit UML elements and diagrams, open/save/compile CODESYS projects, add or edit POUs, log in to a simulated PLC and read/write variables, or run a validation/audit pass. Also use when a previous bridge run failed and you need to read its structured report before retrying."
---

# modelio-codesys-bridge — Modelio 4.1 / CODESYS 3.5 automation bridge

This skill documents a **DeepSeek Harness (DSH) host plugin** that turns the scripting
engines of two Windows IDEs into model-callable tools. It is not a Codex skill in the
"`SKILL.md` only" sense: the actual capability is the plugin package under
[`plugin/`](plugin/), installed into a DSH home by one composition-patch insert. If the
five tools below are not in the tool list, the plugin row is not loaded — see
[Install](#install) and do not pretend to have operated the IDEs.

## What it does

Both IDEs expose a Python scripting engine but no network/RPC surface. The bridge stages
a script in a per-run directory, launches the IDE headlessly, waits, and reads back a
structured JSON report. The agent never types IDE UI interactions; it writes Python.

| Tool | Engine | What it runs |
| --- | --- | --- |
| `bridge_status` | — | Detects installs, CODESYS profile/version, Modelio version, default workspaces, scratch dir, sandbox policy, running instances |
| `codesys_run` | IronPython 2.7 | `CODESYS.exe --profile="…" --runscript="…" --noUI` through a generated `run.cmd` |
| `modelio_run` | Jython 2.7 | `modelio.exe -workspace … -project|-create … -batch …` inside one transaction |
| `bridge_launch_gui` | — | Opens the IDE GUI detached so a human can inspect the result |
| `bridge_help` | — | Verified API cheat sheet for `codesys` / `modelio` |

Capabilities this unlocks (all exercised by the package's own self-check):

- **Modelio**: create/open projects, create packages, classes, operations, use cases,
  state machines and diagrams; audit; XMI import/export; persist the model.
- **CODESYS**: create/open/save projects, enumerate devices and objects, add POUs, edit
  declarations/implementations, export/import XML/native, save archives; log in to a
  simulated PLC (login compiles and downloads — there is no standalone `build()` in SP15),
  start/stop the application, read/write variables.

## The script contract (identical for both IDEs)

The bridge wraps your script with an ASCII-only harness. Your script runs with:

- `ARGS` — the JSON value passed in the tool's `args` field, converted to a Python literal.
- `RESULT` — assign any JSON-serialisable value; it comes back as `result`.
- `print(...)` — captured into `output` (CODESYS also mirrors it to `stdout`).
- For CODESYS: the usual globals `projects`, `system`, `online`, `librarymanager`.
- For Modelio: `Modelio`, `modelingSession`, `coreSession`, `selectedElements`.

The report is a JSON string with:

```json
{ "ok": true, "status": "ok", "result": {...},
  "transaction": "committed", "saved": true,
  "error": null, "resultMissing": false, "timedOut": false, "exitCode": 0,
  "runDir": "…", "scriptPath": "…", "stdout": "…", "stderr": "…",
  "competingInstance": null }
```

`ok` is deliberately **strict**: it is true only when a `result.json` exists, its
`status` is `ok`, there is no `transaction_error`/`save_error`, the run was not killed,
and the process exited `0`. Anything else is `ok: false` with the evidence attached.

## How to use it

### 0. Always start with detection

```text
bridge_status {}
```

Read `codesys.profile`, `modelio.version`, `scratch`, `policy.mode`. If an IDE is already
running, prefer closing it: headless script mode conflicts with a live GUI instance and
the report will carry a `competingInstance` warning.

### 1. Read the cheat sheet before non-trivial scripts

```text
bridge_help { "topic": "modelio" }   // or "codesys", "overview"
```

.NET objects in CODESYS do **not** support Python `dir()`; reflect instead:
`obj.GetType().GetMethods()`. Modelio/Jython objects do support `dir()`.

### 2. CODESYS: open, inspect, edit, save

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\nRESULT = {'children': [str(c.get_name()) for c in proj.get_children(False)]}",
  "timeoutSec": 300
}
```

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\npou = proj.create_pou('PLC_PRG')\nproj.save()\nRESULT = {'pou': str(pou)}",
  "timeoutSec": 300
}
```

Cold start is 60–90 s. Use a copy of a real project when experimenting: CODESYS locks
the `.project` file while open.

### 3. CODESYS: simulation / validation

```text
codesys_run {
  "script": "proj = projects.open(r'D:\\work\\demo.project')\napp = online.create_online_application(proj.active_application)\napp.login(True)\napp.start()\nRESULT = {'started': True}",
  "timeoutSec": 300
}
```

`login` is the compile step: build errors surface as a script exception, which the report
carries in `error`. `set_prepared_value` / `read_value` / `stop` / `logout` are documented
patterns but were not individually re-verified on this install — confirm signatures with
reflection before a batch run. A simulated device is required; login against a real
gateway fails without one.

### 4. Modelio: create a project and a model

```text
modelio_run {
  "create": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "script": "from org.modelio.api.modelio import Modelio\nmi = Modelio.getInstance()\nms = mi.getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nrootpkg = [c for c in root.getCompositionChildren() if 'Package' in str(type(c))][0]\nmodel.createPackage('Design', rootpkg)\nRESULT = {'ok': True}"
}
```

Use `create` for a new project and `project` for an existing one; the tool checks
existence and refuses a mismatched pair. The workspace directory is created if missing.

### 5. Modelio: read-only inspection

```text
modelio_run {
  "project": "Demo",
  "workspace": "D:\\proj\\modelio-ws",
  "save": false,
  "script": "from org.modelio.api.modelio import Modelio\nms = Modelio.getInstance().getModelingSession()\nmodel = ms.getModel()\nroot = [r for r in model.getModelRoots() if 'Standard.Project' in str(r)][0]\nRESULT = {'roots': [str(r) for r in root.getCompositionChildren()]}"
}
```

Transactions are opened by the wrapper; a script exception rolls the transaction back and
skips `coreSession.save()`, so a failed script leaves the project untouched.

### 6. Inspect what a human should see

```text
bridge_launch_gui { "app": "modelio", "project": "Demo", "workspace": "D:\\proj\\modelio-ws" }
```

A GUI that exits within 2.5 s is reported as `started: false` with `exitCode`/`stderr`.

## How it is built

```
$DSH_HOME/
  cordis.patch.yml                     # one insert: id modelio-codesys-bridge -> plugin/lib/index.js
  plugins/modelio-codesys-bridge/         # this package
    package.json  lib/index.js  cordis.patch.yml  scripts/selfcheck.mjs
```

- **Plane**: the plugin registers tools into the host `tools` registry, so one instance
  serves every session of every profile. It publishes no service, so it can sit at the
  host root without an `isolate` realm.
- **Patch**: DSH composes a profile from bundle patches plus the user layer; a `name`
  beginning with `./` or `../` in an insert is anchored **beside the patch file** and
  turned into a `file:` URL. That is why the row can point at a local package without
  publishing it to npm.
- **Wrapper**: the plugin writes an ASCII-only Python wrapper (`pyStr`/`pyLiteral` escape
  every non-ASCII code point as `\uXXXX`, so Modelio's system-charset decoding cannot
  corrupt the file), `execfile`s the user script with a curated globals dict, tees
  stdout, and always writes `result.json`.
- **Modelio transaction**: the wrapper touches the model, calls
  `modelingSession.createTransaction()`, commits when the script status is `ok`, rolls
  back otherwise, and only then (on success) calls `coreSession.save(None)`.
- **CODESYS quoting**: `--noUI` requires the literal `--profile="name"` form. Node's
  Windows argv quoting rewrites embedded quotes, so the plugin writes a `run.cmd` and
  launches `cmd /c` — the batch file keeps the command line byte-exact.
- **Sandbox**: files are written through the host `fs` service with the session's
  resolved policy; the scratch root and policy are re-resolved on every call, so switching
  workspace or policy between sessions cannot reuse a stale run directory.
- **Diagnostics**: a missing `result.json` returns `resultMissing` plus a `hint`; for
  Modelio it also returns the tail of the newest `modelio-*.log`.

## Install

Three mutually exclusive ways — inserting the same row id twice is a loader error.

**A. User-level patch (recommended).** Put the package at
`$DSH_HOME/plugins/modelio-codesys-bridge/` and create `$DSH_HOME/cordis.patch.yml`:

```yaml
- insert:
    - id: modelio-codesys-bridge
      name: './plugins/modelio-codesys-bridge/lib/index.js'
```

Restart DSH. The tools appear in every profile and every session.

**B. Profile-level patch.** Same insert in
`$DSH_HOME/profiles/<name>/cordis.patch.yml`, with a path anchored to that file.

**C. As a pnpm plugin.** `dsh plugin --profile web add <path to this package>`. The
package declares `dsh.bundle.patch`, so its own `plugin/cordis.patch.yml` inserts the row.

Config on the row is optional:

```yaml
- id: modelio-codesys-bridge
  name: './plugins/modelio-codesys-bridge/lib/index.js'
  config:
    codesysRoot: 'D:\CODESYS 3.5'     # default
    modelioRoot: 'D:\modelio'         # default
    scratchDir: 'C:\Users\me\bridge'  # default %USERPROFILE%\.dsh\modelio-codesys-bridge
```

## Verify and debug

```bash
node plugin/scripts/selfcheck.mjs                    # fake host ctx; registration + both IDEs + rollback
SELFCHECK_SKIP_IDE=1 node plugin/scripts/selfcheck.mjs   # load/registration only
```

The self-check also asserts the strict-success rules: an exit-0 launcher without a
result must not be `ok`, a GUI that dies immediately must not be `started`, and a failing
Modelio script must roll back, skip the save, and leave nothing on disk.

If a run fails: read `ok`, `resultMissing`, `exitCode`, `error`, `stderr`,
`competingInstance`, and for Modelio `modelioLogTail`; the run directory named by
`runDir` holds `user.py`, `run.py`, `run.cmd` (CODESYS) and `result.json`, which can be
replayed by hand.

## Limits

- Dynamic-plugin alternative (no restart) is not this skill; this one is persistent.
- The plugin requires a Windows host with the two IDEs installed; the default paths are
  overridable per row config.
- It runs the IDEs as child processes of DSH; under a `workspace-write` sandbox an IDE
  that must write outside the workspace can fail while the launcher still exits 0 — run
  with `danger-full-access`, or place scratch/workspace inside the workspace.
- CODESYS API names vary between SP versions; the cheat sheet is verified for
  **3.5 SP15 Patch 3** and the self-check re-validates the pipeline, not every API.
