# Usage recipes

All examples assume the plugin is loaded, so the `scada_*` tools exist.

## 1. Orient yourself

```text
scada_status {}
```

Returns installation and data paths, running apps with their listening ports, project count,
whether the OPC UA worker (`asyncua`) is usable, and — when the server is up and a project
publishes values — the discovered OPC UA endpoint.

```text
scada_projects {project?: "project_SwimmingPool"}
```

Each entry merges the on-disk summary (variables, scripts, pages, bytecode freshness) with
the server's live state (`id`, `state`, `stateName`, `vars`, `exec`).

## 2. Read the model

```text
scada_read {project:"project_SwimmingPool", what:"all"}
scada_read {project:"project_SwimmingPool", what:"variables", filter:"water"}
scada_read {project:"project_SwimmingPool", what:"scripts", includeSource:false}
scada_read {project:"project_SwimmingPool", what:"variables", includeRaw:true}   # hex per record
```

`what=scripts` also returns `bytecode`: `{stale, reason, sourceMtime, programMtime}`.
`what=pages` returns the page/subpage skeleton plus an `objectNames` index (elements are not
decoded beyond their names).

## 3. Edit a script

Replace a whole script body:

```text
scada_edit {
  project: "project_SwimmingPool",
  what: "script",
  action: "set",
  payload: { name: "Script_7", text: "interface\nprocedure PoolTick;\n\nimplementation\n..." }
}
```

Other actions: `append` (add lines at the end), `add` (`payload.flags` optional), `remove`,
`rename` (`payload.to`). Every call returns `sizes {before, after, delta}`, `backupDir` and a
re-parse check. Lines are stored without embedded newlines, so `text` is split on `\n`.

Dry run first when the change is large:

```text
scada_edit {project:"…", what:"script", action:"append", payload:{name:"Script_7", text:"  // note"}, dryRun:true}
```

## 4. Edit a variable description

```text
scada_edit {
  project: "project_SwimmingPool",
  what: "variable",
  action: "set",
  payload: { name: "waterLevel", set: { description: "Уровень воды в бассейне, %" } }
}
```

Only `description` is writable today; other keys are rejected with an explanation. Variables
created without a description store the placeholder `Noname server` — the bridge inserts a
description in front of it instead of overwriting it.

## 5. Validate before running

```text
scada_validate {project:"project_SwimmingPool", deep:true}
```

Errors: unparsable binaries, duplicate variable/script names, invalid identifiers.
Warnings: scripts referencing unknown variables (`x.Foo` where `x` is not a variable),
elements bound to unknown variables, stale bytecode, pages only partially decoded.
`deep:true` additionally checks the OPC UA worker and the admin API.

## 6. Compile

Prerequisite: the project is open in `Editor.exe`.

```text
scada_compile {project:"project_SwimmingPool", mode:"saveAndCompile"}   # Ctrl+Shift+S
scada_compile {project:"project_SwimmingPool", mode:"compileAll"}       # Shift+F9
```

Modes: `saveAndCompile` (default), `compile` (F9), `compileAll` (Shift+F9), `debug` (F5).
Result reports `bytecode.before/after` timestamps, whether the file changed, and the new
`Editor-log.txt` block (`Start compile all … End compile all`, captured errors).

If the editor is not running, pass `openEditor:true` to launch it — then open the project in
the window and run the tool again.

## 7. Start a run ("training") and watch results

```text
scada_run {project:"project_SwimmingPool", action:"start", client:true}
scada_journal {project:"project_SwimmingPool", lines:40}
scada_values {action:"watch", nodes:["waterLevel","xMotor","xWBell"], seconds:15, intervalMs:250}
scada_run {project:"project_SwimmingPool", action:"stop"}
```

`action` values: `status`, `start`, `stop`, `restart`, `client`, `stopServer`.
`client:true` also launches `Client.exe --host-127.0.0.1:8750 --project-<name>` (plus
`--login-…`, `--pass-…`, `--resolution-…` when given).

`scada_values action:"watch"` polls the OPC UA server and returns both the last samples and a
per-node summary (`samples`, `min`, `max`, `last`, `status`) — that is the "background
results" view for a run.

## 8. Write a value into a running project

```text
scada_values {action:"write", values:{"waterLevel":90,"xMotor":true}}
```

Values are coerced to the node's data type and read back; the result shows `written` and
`readback` per node. Use it to drive the model (setpoints, permissives) instead of clicking
the client UI.

## 9. Discover the OPC UA endpoint by hand

```text
scada_values {action:"discover", rescan:true}
```

Output lists the scanned endpoints and the decision, e.g.:

```
Server.exe listens on 8750, 8753, 8754, 8758 only - those are the admin/client ports, so no
built-in OPC UA server is running. Enable it once in the editor (Проект -> Настройки ->
встроенный OPC UA-сервер, set a port), then start the project with scada_run.
```
