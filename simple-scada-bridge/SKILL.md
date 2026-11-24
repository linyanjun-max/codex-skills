---
name: simple-scada-bridge
description: "Drive a locally installed Simple-Scada 2 (Russian SCADA/HMI builder) from DeepSeek Harness: read and edit the project model (variables, scripts, pages), start/stop/restart projects on the server, read the runtime journal, compile scripts through the editor hot key, and read/write live variable values over the project's built-in OPC UA server. Matches requests such as 「读取 Simple-Scada 工程」「编辑变量/脚本」「启动训练（运行工程）」「后台读取结果」「编译并校验」「把数值写进 SCADA」."
whenToUse: "Use whenever the task involves Simple-Scada 2 on this machine: inspecting or changing a project, wiring variables to a model, starting a project run (training/simulation) and watching values, compiling scripts after an edit, or checking why a project refuses to run. Also use it when the user mentions Simple-Scada in Chinese/Russian (Simple-Scada、工程、变量、脚本、тренировка、проект) instead of touching the project files by hand."
---

# Simple-Scada 2 bridge

Simple-Scada 2 is a Delphi SCADA/HMI builder with **no scripting API, no CLI and no
HTTP/REST interface**. Everything below is built from the four surfaces that actually
exist, each verified on a real installation. Do not invent other entry points.

| surface | what it gives | tool |
| --- | --- | --- |
| project files (`Variables.svr`, `Scripts\Scripts.ssc`, `Pages.spg`, `Project.spr`) | offline model read + surgical edits with backups | `scada_read`, `scada_edit` |
| admin websocket `ws://127.0.0.1:8758` (Server.exe) | project start/stop/restart, state, clients, journal, server shutdown | `scada_run`, `scada_journal` |
| built-in OPC UA server (`opc.tcp://host:port`, per project) | live variable read / write / watch | `scada_values` |
| editor hot keys (Ctrl+Shift+S, F9, Shift+F9, F5) | script compilation, verified by `Compiled\program.exs` | `scada_compile` |

Start with `scada_status`; `scada_help {topic}` returns the cookbook for
`overview | editing | runtime | values`.

## The 30-second model of the product

* A **project folder** (`…\Simple-Scada 2 (demo64)\Projects\<name>`) holds binary Delphi
  streams. `Variables.svr` = variables, `Scripts\Scripts.ssc` = script source,
  `Pages.spg` = screens, `Project.spr` = settings, `Trends.str` / `Messages.smg` = trends
  and messages, `Scripts\Compiled\program.exs` = **PaxCompiler bytecode**.
* **The server never reads `Scripts.ssc`.** It loads `Compiled\program.exs`. Editing a
  script therefore changes nothing until the editor recompiles it.
  `scada_validate` reports this as `bytecode: Scripts.ssc is newer than …`.
* **Compiling is an editor action.** `Editor.exe` ignores argv (project folder, `.spr`
  path, `-project`, `--project-…` all tested) and its window is a **ZenGL OpenGL**
  surface with no Win32/UIA children, so it cannot be opened or clicked headlessly.
  `scada_compile` focuses the window and sends the hot key — **the project must already
  be open in the editor**.
* **Live values are not in the admin interface.** The admin websocket exposes project
  state, clients and journal messages only. Values come from the project's built-in
  OPC UA server, which must be enabled once in the project settings.
* **Running state numbers** (from `Web/js/wilang_en.js`): `0/3 = stopped`, `1 = queued`,
  `2 = stopping`, `4 = starting`, `5 = started`. `scada_run` maps them for you.

## Working loop

```text
1. scada_status                                  # install, data dir, server up?, UA worker?
2. scada_projects                                # what exists, what is running
3. scada_read  {project, what:"all"}             # variables/scripts/pages/settings
4. scada_edit  {project, what:"script"|"variable", action:…, payload:{…}}
5. scada_validate {project}                      # duplicates, bad refs, stale bytecode
6. scada_compile {project}                       # editor must have the project open
7. scada_run   {project, action:"start"}         # training/simulation run
8. scada_values {action:"watch", nodes:[…], seconds:10}
9. scada_run   {project, action:"stop"}
```

## Rules that keep the project intact

1. **Never edit a project that is running on the server.** `scada_edit` refuses unless
   `force=true`, because the running instance holds the old model in memory and will
   overwrite your change. Stop it first.
2. **Every write is backed up** to `Projects\_dsh_backups\<project>_<stamp>_<what>` and the
   result is re-parsed before it is accepted. If a payload touches a field whose byte
   offset is not proven, the tool **fails with an explanation** instead of guessing.
3. **Only proven fields are writable**: script bodies (all of `Scripts.ssc`), variable
   descriptions, and nothing else yet. Variable add/remove, initial values, limits, types,
   page elements and `Project.spr` flags are refused with a reason — write those in the
   editor.
4. **`Demo-project` uses a different `Scripts.ssc` container** (header carries a named
   script group). Its scripts are reported as unavailable; the other three sample projects
   decode byte-identically. Do not treat that as corruption.
5. When a compile is refused, `scada_compile` returns the editor log lines it captured and
   the bytecode timestamps — read them instead of retrying blindly.

## Live values (OPC UA)

The project must publish its variables: in the editor set
`Проект → Настройки → встроенный OPC UA-сервер` and pick a port. The endpoint is
`opc.tcp://<host>:<port>`; the project ID appears in the tag addresses.

`scada_values` does **not** need the endpoint: when it is omitted, the bridge probes every
listening port of `Server.exe` and caches the one that answers OPC UA
(`action:"discover"` rescans). If none answers, the tool says whether the server is down,
the UA server is disabled, or only admin/client ports (8750/8753/8754/8758) are open.

Node references accepted by `nodes`: a browse name (`waterLevel`), a path
(`Objects/Pool/Tank/Level`), or `ns=2;s=…`. `write` coerces the value to the node's data
type and reads it back, so the result shows what the SCADA actually stored.

## Failure modes seen in practice

| symptom | cause | action |
| --- | --- | --- |
| `scada_compile` → `bytecode did not change` | editor has no project open, or compile errors | open the project in the editor, read `editorLog`, retry |
| `scada_run` skipped `already started` | project already active | `action:"stop"` first or `action:"restart"` |
| values `no OPC UA endpoint found` | built-in UA server disabled or project not started | enable in project settings, then `scada_run action:"start"` |
| `project not found` | name must equal the folder under `Projects\` | `scada_projects` lists exact names |
| journal empty but log has lines | journal page needs the server; log tail is separate | both are returned |
