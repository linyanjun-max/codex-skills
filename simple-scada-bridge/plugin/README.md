# dsh-tool-simple-scada — Simple-Scada 2 bridge for DeepSeek Harness

MCP-style tools that let the agent drive the **Simple-Scada 2** installation on this
machine: read the project model, edit scripts, start/stop projects on the server, read
the runtime journal, and read/write live variable values over the project's built-in
OPC UA server.

Simple-Scada has no scripting API, no CLI and no HTTP/REST surface, so the bridge is
built from the four surfaces that do exist. Every one of them was verified on this
machine (see *Verified facts*):

| surface | what it gives | module |
| --- | --- | --- |
| project files (`Variables.svr`, `Scripts.ssc`, `Pages.spg`, `Project.spr`, …) | offline model read + surgical edits | `lib/binfmt.js`, `lib/ssc.js` |
| server admin websocket `ws://127.0.0.1:8758` | project start/stop/restart, state, clients, journal messages, server shutdown | `lib/admin.js` |
| project built-in OPC UA server `opc.tcp://host:port` | live variable read / write / watch | `lib/values.js` + `scripts/ua_worker.py` |
| editor hot keys (Ctrl+Shift+S / F9 / Shift+F9 / F5) | script compilation with bytecode verification | `lib/editor.js` + `scripts/editor_hotkey.ps1` |

## Tools

| tool | purpose |
| --- | --- |
| `scada_status` | install/data paths from the registry, running apps and their ports, project count, OPC UA worker readiness |
| `scada_projects` | project folders with model summary (variables/scripts/pages) and live state |
| `scada_read` | `summary` / `variables` / `scripts` / `pages` / `project` / `all`, with name filter |
| `scada_edit` | script `set/add/append/remove/rename`, variable `set` (description) — backup + re-parse check |
| `scada_validate` | duplicate names, script syntax smells, scripts referencing unknown variables, stale bytecode, page bindings |
| `scada_compile` | focus the editor and send the compile hot key, then verify `Compiled\program.exs` |
| `scada_run` | `status/start/stop/restart/stopServer` via the admin API, optional desktop client launch |
| `scada_journal` | journal messages from the admin API + `Logs\Server-log.txt` tail |
| `scada_values` | OPC UA `status/wait/browse/read/write/watch` (live values, background sampling) |
| `scada_help` | overview / editing / runtime / values cookbook |

## Install

The plugin is already installed as a home-level patch row:

```yaml
# %DSH_HOME%\cordis.patch.yml
- insert:
    - id: simple-scada-bridge
      name: './plugins/simple-scada-bridge/lib/index.js'
```

Restart the harness (or reload plugins) afterwards. The OPC UA worker lives in the
plugin's own virtualenv (`plugins/simple-scada-bridge/.venv`, asyncua 2.1.0) — nothing
global on the machine is touched; delete `.venv` to reclaim ~40 MB.

## Verified facts

**Project files** (all four sample projects parse):

* `Variables.svr` — header `u32 8`, `u32 0`, `u32 groupCount`; per group `u32 nameLen` +
  UTF-8 name; per variable a record that starts at its `u32 nameLen` and ends in a fixed
  32-byte tail beginning `ff ff 04 00 00 00` + UTF-16 `0.##` + double `100.0`. The
  description and four more wide strings ("Noname server/caption/computer/ClsID"
  placeholders) live before the numeric zone. Group 2 of the swimming-pool project is
  literally named `..\` (the root marker).
* `Scripts\Scripts.ssc` — 23-byte header, then per script: `u32 id`, 4 reserved bytes,
  `u32 nameLen` + UTF-16 name, 18 flag bytes, `u32 lineCount`, then per line
  `u32 charCount` + UTF-16 text. Parses and re-encodes **byte-identically**.
* `Pages.spg` — nested Delphi stream; object names are `u32 len` + ASCII, element records
  are ~158 bytes. Only the page/subpage skeleton and the object-name index are decoded;
  geometry/type/bindings are not, so pages are read-only.
* `Project.spr` — name, GUID, database strings decoded; the flag bytes (web access,
  built-in UA server, logging) are not mapped.

**Runtime**: project states are `0/3 = stopped, 1 = queued, 2 = stopping, 4 = starting,
5 = started` (`Web/js/wilang_en.js`). Starting via the API is logged as
`user start project … активирован`; stopping as `user stop project … деактивирован`.

**Compilation**: the server only loads `Scripts\Compiled\program.exs` (PaxCompiler
bytecode) — never `Scripts.ssc`. `Editor.exe` ignores argv (folder, `Project.spr`,
`-project`, `--project-…` all tested) and its window is a ZenGL OpenGL surface with no
Win32/UIA children, so it cannot be opened headlessly. `scada_compile` therefore focuses
the editor and sends the hot key; **the project must already be open in the editor**.

## Known limitations

* Variable `add`/`remove`, initial values, limits and type changes are refused: those
  bytes in `Variables.svr` are not proven yet, and writing them blind would corrupt a
  project. Only the description is writable today.
* Page editing (elements, geometry, bindings) is refused for the same reason.
* `Project.spr` flag editing is refused: enable the built-in OPC UA server once in the
  editor (Проект → Настройки), then `scada_values` works with the resulting endpoint.
* `scada_compile` cannot open a project by itself (see above).

## Self-check

```bash
node scripts/selfcheck.mjs
SELFCHECK_SKIP_RUNTIME=1 node scripts/selfcheck.mjs     # server not running
SELFCHECK_PROJECT=SwimmingPool_pql node scripts/selfcheck.mjs
```

The self-check loads the plugin with a minimal fake ctx, asserts registration, **compiles
every tool parameter schema with ajv** (a flat parameter map, or a parameter named like a
JSON Schema keyword such as `pattern`, produces an invalid function schema that breaks
every request), and exercises the read-only tools against the real installation.

## Layout

```
simple-scada-bridge/
  package.json              # name / entry / dsh.bundle patch
  cordis.patch.yml          # bundle-level patch row
  lib/index.js              # plugin entry: 10 tools + help
  lib/paths.js              # registry/data-dir/app detection, tasklist, netstat
  lib/binfmt.js             # Variables.svr / Pages.spg / Project.spr codecs
  lib/ssc.js                # Scripts.ssc codec (lossless)
  lib/admin.js              # admin websocket client
  lib/editor.js             # compile via hot keys + bytecode verification
  lib/values.js             # OPC UA worker glue
  scripts/ua_worker.py      # asyncua CLI: status/browse/read/write/watch/wait
  scripts/editor_hotkey.ps1 # focus the editor window and send one key sequence
  scripts/selfcheck.mjs     # standalone self-check
  .venv/                    # plugin-local Python + asyncua (created here)
```


## Форматы файлов проекта

* `docs/pages-spg.md` — `Pages.spg`: структура записей объектов, смещения полей
  (геометрия, цвета, переменная, текст, id), правила записи и список грабель
  (`Stream read error`, редактор держит проект в памяти, 1280x720 и т.д.).
  Реализация: `parsePages()` / `editPages()` в `lib/binfmt.js`.
