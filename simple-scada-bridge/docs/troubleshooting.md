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
