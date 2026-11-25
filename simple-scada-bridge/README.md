# simple-scada-bridge

A **DeepSeek Harness host plugin** (plus this usage skill) that drives a locally installed
**Simple-Scada 2** SCADA/HMI project: read and edit the binary model — variables, scripts and
**screen elements** — compile scripts through the editor hot key, start/stop projects on the
server, read the runtime journal, and read/write live variables over the project's built-in
OPC UA server.

Verified against **Simple-Scada 2.7.3.1 (demo64)**. Project files written by older builds
still parse: `Variables.svr` header version 8 and 10 are handled; projects re-saved by newer
builds (header 156, e.g. the bundled `Demo-project` after an upgrade) are only partially
supported and report that explicitly.

* Plugin id / folder / patch row: **`simple-scada-bridge`**
* Package name: **`dsh-tool-simple-scada`**
* Tools: `scada_status`, `scada_projects`, `scada_read`, `scada_edit`, `scada_validate`,
  `scada_compile`, `scada_run`, `scada_journal`, `scada_values`, `scada_help`

## Why a bridge is needed

Simple-Scada 2 has **no scripting API, no CLI and no HTTP/REST interface**. The plugin is
built from the four surfaces that do exist, each verified against a real installation:

| surface | capability |
| --- | --- |
| project files (`Variables.svr`, `Scripts\Scripts.ssc`, `Pages.spg`, `Project.spr`, …) | offline model read, lossless `Scripts.ssc` round-trip, screen-element read/edit, surgical edits with automatic backup |
| server admin websocket `ws://127.0.0.1:8758` | project state, start/stop/restart, clients, journal messages, server shutdown |
| project built-in OPC UA server (`opc.tcp://host:port`) | live variable read / write / watch, with automatic port discovery |
| editor hot keys (Ctrl+Shift+S, F9, Shift+F9, F5) | script compilation, verified by `Compiled\program.exs` timestamp + `Editor-log.txt` |

## Install

### A. User-level patch (no packaging)

```yaml
# %DSH_HOME%\cordis.patch.yml
- insert:
    - id: simple-scada-bridge
      name: './plugins/simple-scada-bridge/lib/index.js'
```

Copy `plugin/` to `%DSH_HOME%\plugins\simple-scada-bridge\` first. `./` resolves relative to
the patch file, so the folder name must stay `simple-scada-bridge`.

### B. Profile-level patch

Same insert line in `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`, with `name` pointing at
an absolute path (or a path relative to the profile folder).

### C. As a pnpm plugin package (distributable)

```bash
dsh plugin --profile web add <absolute path to plugin/>
```

`plugin/package.json` declares `dsh.bundle.patch`, so the package name lands in
`dsh.profile.bundles` and its own `cordis.patch.yml` inserts the `simple-scada-bridge` row.
**Do not combine C with A/B** — the same row id twice is a loader error.

The OPC UA worker runs on a plugin-local virtualenv created on first install:

```powershell
python -m venv "$env:DSH_HOME\plugins\simple-scada-bridge\.venv"
& "$env:DSH_HOME\plugins\simple-scada-bridge\.venv\Scripts\python.exe" -m pip install asyncua
```

Nothing global on the machine is touched; delete `.venv` to reclaim ~40 MB (`scada_values`
then reports the worker as unavailable instead of failing silently).

## Two steps the bridge cannot do for you

1. **Compiling** — `Editor.exe` ignores argv and draws its own ZenGL surface (no Win32/UIA
   controls), so the project cannot be opened headlessly. Open the project in the editor
   once; `scada_compile` then sends the hot key and proves the result.
2. **Publishing values** — enable the built-in OPC UA server once in
   `Проект → Настройки`; after that `scada_values` finds the port by probing `Server.exe`.

## What is proven, what is not

Proven on this installation (see `docs/api-verified.md` for byte-level detail):

* projects parse: 25 / 27 / 39 variables, 9 / 10 scripts, 1 page each, descriptions and group
  names decoded (Russian text intact);
* `Pages.spg` element records are decoded: type (1..18 with Russian component names), geometry
  (`float32` X/Y/W/H), font/fill/border colours (BGR), object id, primary and second variable
  index, captions and button state texts — and `scada_edit {what:"page"}` rewrites geometry,
  text, bound variable, colours, clones and deletes elements; full layout in
  `plugin/docs/pages-spg.md`; measured layout rules — page grid, font metrics, clipping and
  the per-type clone patch list — in `plugin/docs/screen-layout.md`;
* `Scripts.ssc` parse → re-encode is **byte-identical**; appending a line produces the
  expected delta, a backup, and an immediate "bytecode stale" verdict;
* variable description rewrite shifts only the intended bytes and re-parses cleanly;
* admin API start/stop round-trip is recorded by the server as
  `user start project … активирован` / `user stop project … деактивирован`;
* journal returns `[kind, text, time]` triples; server log tail is returned alongside;
* OPC UA worker (asyncua 2.1.0) starts, and probing a non-UA port fails cleanly.

Not implemented (refused with an explanation, never guessed): adding/removing variables,
initial values, limits and data types, `Project.spr` flag editing, `Scripts.ssc` of a project
saved by a newer build (different container), and `Variables.svr` header version 156
(partially).

## Self-check

```bash
node simple-scada-bridge/plugin/scripts/selfcheck.mjs
SELFCHECK_SKIP_RUNTIME=1 node …/selfcheck.mjs        # server not running
SELFCHECK_PROJECT=SwimmingPool_pql node …/selfcheck.mjs
```

Loads the plugin with a minimal fake ctx, asserts registration, **compiles every tool
parameter schema with ajv** (the harness forwards `tool.parameters` as the function schema,
so a flat map or a parameter named after a JSON Schema keyword — e.g. `pattern` — makes the
provider reject every request), then exercises the read-only tools.

## Layout

```
simple-scada-bridge/
  SKILL.md                    agent-facing skill text
  README.md                   this file
  docs/api-verified.md        byte-level file formats, admin protocol, ports, hot keys
  docs/usage.md               recipes
  docs/troubleshooting.md     failure modes and how to diagnose them
  docs/changelog.md
  plugin/
    package.json              name / entry / dsh.bundle patch
    cordis.patch.yml          bundle patch row
    README.md                 plugin-level reference
    lib/index.js              10 tools + help
    lib/paths.js              registry, install/data dir, process and port discovery
    lib/binfmt.js             Variables.svr / Pages.spg / Project.spr codecs
    lib/ssc.js                Scripts.ssc codec (lossless)
    lib/admin.js              admin websocket client
    lib/editor.js             compile via hot keys + bytecode verification
    lib/values.js             OPC UA worker glue + endpoint discovery
    docs/pages-spg.md         Pages.spg record layout, field offsets, writing rules (Russian)
    scripts/ua_worker.py      asyncua CLI: status/probe/browse/read/write/watch/wait
    scripts/editor_hotkey.ps1 focus the editor window and send one key sequence
    scripts/selfcheck.mjs     standalone self-check
```

## License

MIT License. See `LICENSE` in the repository root.
