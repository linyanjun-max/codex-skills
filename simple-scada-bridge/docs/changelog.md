# Changelog

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
