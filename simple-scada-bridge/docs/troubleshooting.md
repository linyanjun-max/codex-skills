# Troubleshooting

Run the bundled self-check first — it separates "plugin broken" from "environment broken":

```powershell
node <repo>\simple-scada-bridge\plugin\scripts\selfcheck.mjs
```

Expected: `SELFCHECK OK (8 checks)`, including
`parameter schemas are harness-safe -> 10 schemas compiled with ajv`.

## The plugin breaks every request after an edit ("Invalid schema for function …")

The harness forwards `tool.parameters` **as the function schema**. If `parameters` is a flat
map (`{ pattern: { type:"string" } }`) its keys land at the schema root, so a parameter named
after a JSON Schema keyword (`pattern`, `items`, `required`, `enum`, `title`, …) makes the
whole schema invalid. Version 1.0.0 builds a proper
`{ type:"object", properties, required }` in `textTool()` and the self-check compiles every
schema with the harness's own ajv, so this class of bug cannot return unnoticed.

If it ever happens again: remove the plugin row from `cordis.patch.yml`, restart the
harness, fix the schema, re-add the row.

## `scada_compile` → "the bytecode did not change"

* The editor has **no project open** (it starts on its ZenGL start screen and ignores argv).
  Open the project in the editor, then retry.
* The compile failed: read `editorLog.errors` / `editorLog.lines` in the same result.
* A modal dialog is blocking the editor; `foreground:false` in the result means the window
  could not be focused (another window stole focus, or the session is locked).

## `scada_run` reports `skipped: already started`

The project was already active. `action:"stop"` first, or use `action:"restart"`.

## `scada_edit` refuses with "is started on the server"

By design: the running instance holds the model in memory. Stop the project, edit, compile,
start again. `force:true` overrides it — the running project will overwrite your change on
its next save, so only use it on a stopped project.

## `scada_values` → "no OPC UA endpoint found for the running server"

Read `discovery.hint`: it distinguishes three cases.

1. `Server.exe` not listening → start the server (`Server.exe` or the service).
2. Only admin/client ports (8750/8753/8754/8758) → the project's built-in OPC UA server is
   disabled: enable it once in `Проект → Настройки`, set a port.
3. Other ports exist but do not answer OPC UA → project not started, or the UA server binds
   another interface; pass `endpoint:"opc.tcp://<host>:<port>"` explicitly.

The OPC UA worker itself can be checked with `scada_values {action:"status"}`; it reports the
Python path it uses.

## `Stream read error` after editing a page

The server rejects the page list (`Ошибка при загрузке страниц проекта! Stream read error |
subpage | Subpage1 | page | Page1`) when an object id or a colour/length field was written at
the wrong offset. Restore the page from the backup printed by `scada_edit` (`backupDir`), then
re-apply the change with `what:"page"` rather than editing `Pages.spg` by hand. Ids belong at
`body+107` only — see `plugin/docs/pages-spg.md`.

## My page/script edit disappeared

`Editor.exe` keeps the project in memory: if the project was open while the bridge wrote
`Pages.spg` or `Scripts.ssc`, the editor's next save replaces the file (observed: `Pages.spg`
2731 → 23 bytes). Close the editor before writing, and reopen the project afterwards. The
bridge already refuses edits while the *server* runs the project; the editor is a second,
independent holder.

## A new project folder is not listed by `scada_run`

The server reads the project list at startup. After creating a folder under `Projects\`,
restart `Server.exe` (the bridge cannot do it from inside: `scada_run action:"stopServer"`
stops the server, but starting it again is an external process).

## Demo-64 allows one running project

With a demo-64 licence only one project may be active at a time — starting a second one is
ignored. Stop the first with `scada_run {project, action:"stop"}`.

## Variables of an upgraded project fail to parse

`Variables.svr` carries a header version: `8` (2.6.x) and `10` parse, and a project re-saved
by a newer build carries `156`, which is only partially decoded — the tool still reports
groups, but `warnings` says `group N of M: file ended early`. Do not edit such a project with
the bridge; open it in the editor instead.

## Scripts of `Demo-project` are "unavailable"

That project's `Scripts.ssc` uses a newer container (named script group in the header). The
parser reports the offset it choked on; the other three sample projects decode
byte-identically. Not corruption — just an unmapped variant.

## `scada_read` says "variable has no decoded wide-string fields"

The record was found by name but the description area did not parse (unexpected project
version). Read-only access still works; edit that variable in the editor.

## Journal empty while `Logs\Server-log.txt` has lines

They are different sources: the journal comes from the admin API (page 6) and only exists
while the server runs; the log tail is read from disk and survives restarts. Both are
returned side by side.

## Diagnostics worth collecting

```text
scada_status {}                                  # paths, processes, ports, worker, UA endpoint
scada_validate {project, deep:true}              # model + worker + admin API
%DATA%\Logs\Server-log.txt                        # activation ladder, project operations
%DATA%\Logs\Editor-log.txt                        # compile ladder, bytecode creation
%DSH_HOME%\plugins\simple-scada-bridge\.venv\Scripts\python.exe -c "import asyncua; print(asyncua.__version__)"
```
