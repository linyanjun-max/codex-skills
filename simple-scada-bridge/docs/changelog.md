# Changelog

## 1.1.1 — screen layout reference (docs only, no code change)

Added `plugin/docs/screen-layout.md`: the measured rules for laying out a page that
actually survives the client's scaling.

* coordinate system: page is **1280 × 720**, the client scales it (×2 on a 2560 × 1440
  screen, verified by measuring a title at x=140 landing on 280 px); anything outside the
  page is clipped, and the page caption is drawn *over* the top-left corner;
* font metrics: line height **32 px**, single text line 26–30 px, Cyrillic glyph ≈ **15 px**
  wide, so `field width ≥ chars × 15`; text is centred **and clipped** by its field (no
  ellipsis), a 20 px field with 24 px text overlaps lines, table rows need 52 px, a 150 px
  button fits ≈ 9 characters;
* the font size byte (`body+31`) is an **enumeration, not a size** — 9 renders huge,
  12 microscopic, 17 (the Text default) normal, so layout is fitted to the font, not the
  reverse;
* a proven three-column layout with concrete X/Y/W/H numbers, and which fields must be
  patched per component type when cloning (Shape/Text/Field/Level/Button, including both
  button state texts at `body+171` and `body+235`, replaced far-field-first);
* the verification loop without the editor: write → `scada_run action:"restart"` → read
  `Logs\Server-log.txt` for `активирован` vs `Stream read error` → `PrintWindow` screenshot
  to check clipping/overlaps.

`docs/pages-spg.md` links to it; the Russian section at the end of `plugin/README.md` lists
both documents.

## 1.1.0 — screen elements (Pages.spg) are decoded and editable

Verified against **Simple-Scada 2.7.3.1 (demo64)**.

Added:

* `parsePages()` now decodes the whole object list: record type (`0` service, `1..18` screen
  components with Russian names), geometry as `float32` X/Y/W/H, font/fill/border colours
  (BGR), object id, primary and second variable index, captions, button state names/texts,
  record offsets and lengths. `scada_read {what:"pages"}` returns pages → subpages → elements.
* `editPages()` with `list`, `move`, `text`, `variable` (name or explicit index), `color`,
  `clone` (copies composite components with their `type 0` children), `delete`, `set-caption`;
  every write is backed up and re-parsed.
* `plugin/docs/pages-spg.md` — byte offsets, the variable-index semantics, and the traps
  (`Stream read error`, composite records, 1280×720 design grid, editor holding the project
  in memory).
* `scada_edit` help and parameter descriptions list the page actions.

Changed:

* version notes: project files carry a header version, not the executable version —
  `Variables.svr` 8/10 parse, 156 (newer build) is partial and says so in `warnings`.

## 1.0.0 — initial public version

Bridge for **Simple-Scada 2 (demo64) 2.6.12.3** on Windows, built from four verified
surfaces: project files, the server admin websocket, the project's built-in OPC UA server,
and editor hot keys.

Added:

* `scada_status` — registry-based install/data discovery, process and port inventory,
  OPC UA worker readiness, cached UA endpoint.
* `scada_projects` — on-disk summary merged with live project state.
* `scada_read` — variables (name, description, record offsets, optional raw hex), scripts
  with source, page/subpage skeleton + object-name index, project settings, freshness.
* `scada_edit` — `Scripts.ssc` set/append/add/remove/rename (lossless codec), variable
  description rewrite; automatic backup under `Projects\_dsh_backups`, re-parse verification,
  refusal when the project is running on the server or a field offset is unproven.
* `scada_validate` — duplicate names, identifier syntax, scripts referencing unknown
  variables, element bindings, stale bytecode; `deep` adds worker and admin API checks.
* `scada_compile` — focus the editor window, send `Ctrl+Shift+S` / `F9` / `Shift+F9` / `F5`,
  verify by `Compiled\program.exs` timestamp and the `Editor-log.txt` compile ladder.
* `scada_run` — status/start/stop/restart/stopServer via the admin websocket, optional
  `Client.exe` launch with the documented `--host/--project/--login/--pass/--resolution`
  switches.
* `scada_journal` — journal triples from the admin API plus the `Server-log.txt` tail.
* `scada_values` — OPC UA `status/probe/discover/browse/read/write/watch/wait` through a
  plugin-local virtualenv (`asyncua` 2.x), with automatic endpoint discovery by probing
  `Server.exe`'s listening ports.
* `scripts/selfcheck.mjs` — standalone check that also **compiles every tool parameter
  schema with ajv**.

Fixed during bring-up:

* tool `parameters` were emitted as a flat map, so `scada_journal`'s `pattern` parameter was
  read as the JSON Schema `pattern` keyword and the provider rejected **every** request
  (`Invalid schema for function 'scada_journal' … is not of type "string"`). Parameters are
  now wrapped as `{type:"object", properties, required}` by `textTool()`, that parameter was
  renamed to `match`, and the self-check guards against the whole class of errors.
* `Variables.svr` group iteration could walk past EOF on `Demo-project`; group boundaries are
  now detected by requiring a decodable variable-record chain after the group name.
* `admin.js` page requests could return a delta push (`{"id":2}`) instead of the full page-2
  payload, which made `scada_run` report "not listed"; requests now wait for the matching
  `type:502` answer.
* Journal payloads are `[kind, text, time]` triples (not `[kind, time, text]`).
* Large read results could be cut mid-JSON; raw variable hex is now opt-in and oversized
  results return a structured truncation marker.

Known gaps (refused with a reason, never guessed):

* variable add/remove, initial values, limits, data types;
* page element creation/editing (only names/captions are decoded);
* `Project.spr` flags (web access, built-in UA server) — enable them in the editor;
* `Scripts.ssc` of the bundled `Demo-project` (newer container variant).
