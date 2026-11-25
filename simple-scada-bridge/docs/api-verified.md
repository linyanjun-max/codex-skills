# Verified API facts

Everything below was measured on this machine against **Simple-Scada 2 (demo64),
version 2.7.3.1**, installed at `D:\simpleScada\Simple-Scada 2 (demo64)` with data in
`D:\simpleScada\document\Simple-Scada 2 (demo64)` (registry value `DataPathDemo64`).
Where a fact is a guess it is marked as such — nothing else is.

File-format support is tied to the **header version** stored in each project file, not to the
executable version: `Variables.svr` written by 2.6.x carries version `8`, some files carry
`10` (both parse), and projects re-saved by a newer build carry `156` (partially parse — the
bridge says so in `warnings`). Pages and scripts were confirmed against 2.7.3.1.

## 1. Discovery

```
HKLM\SOFTWARE\WOW6432Node\Simple-Scada
  Language       = english
  DataPathDemo64 = <data dir>        # licensed installs use "DataPath"
HKCU\Software\Simple-Scada
  Types          = full
  Components     = base,server,client
```

Data dir holds `Projects\`, `Logs\`, `Pictures\`, `Sounds\`, `Import\`, `Screenshots\`.
Install dir is the folder containing `Server.exe` **and** `Editor.exe`.

## 2. Project files

`Projects\<name>\` — binary Delphi streams, no XML/JSON anywhere:

| file | content |
| --- | --- |
| `Project.spr` | project settings: name, GUID, database host/name/user, flag bytes |
| `Variables.svr` | variable definitions (editor source of truth), header version 8/10/156 |
| `Variables.svrr` | compact runtime index: groups → name, id, description |
| `Pages.spg` | pages, subpages, element records |
| `Trends.str`, `Messages.smg`, `Messages.smgr`, `Groups.seg`, `Windows.swn`, `ArcSystem.sar` | trends, messages, groups, windows, archive |
| `Scripts\Scripts.ssc` | script source |
| `Scripts\Compiled\program.exs`, `words.exs` | PaxCompiler bytecode loaded by the server |

### 2.1 `Variables.svr`

```
u32 version = 8
u32 reserved = 0
u32 groupCount
per group:
  u32 nameLen + UTF-8 group name
  short preamble (observed: 01 | u32 71 | u32 18)
  per variable:
    u32 nameLen + ASCII name                     <- record starts here
    ... numeric/flag area, unproven ...
    first wide string = description (u32 charCount + UTF-16LE), empty description is
      replaced by the placeholder "Noname server"
    three more wide strings: "Noname caption" / "Noname computer" / "Noname ClsID"
      (OPC source placeholders: server name, caption, computer, class id)
    fixed 32-byte tail:
      ff ff | 04 00 00 00 | "0.##" (UTF-16) | 10 zero bytes | double 100.0
```

Notes:

* the record is self-delimiting when the tail marker
  `ff ff 04 00 00 00 30 00 2e 00 23 00 23 00` is located — record end = marker + 32;
* wide-string length fields are **not** 4-byte aligned (a 13-char string was found with its
  `u32` length at record offset 97), so parsers must scan bytes, not words;
* group 2 of the swimming-pool project is literally named `..\` (root marker);
  `Demo-project` has 13 human-named groups;
* `final_project` has 39 variables, `Demo-project` 133 — used as parser fixtures;
* the file may end with 4 trailing bytes after the last record.

Unproven: data-type enum, initial value, scale min/max, decimals/format, archive flags,
bounds. Consequently the bridge writes **only** the description field.

### 2.2 `Variables.svrr`

```
u32 groupCount
per group:
  u32 nameLen + UTF-8 group name
  per variable: u32 size | u32 nameLen + UTF-8 name | int64 id | u32 | u16 |
                u32 descLen + UTF-16LE description
```

Used to cross-check names/descriptions against `Variables.svr` (system variables carry
their full UI help text here).

### 2.3 `Scripts\Scripts.ssc`

```
header  23 bytes: 10 00 00 00 | 00 00 00 00 | 03 00 00 00 | "..\" NUL | 00 00 00 00 | 09 00 00
per script:
  u32 id                 # not sequential after deletions (observed id 6 missing)
  u32 0
  u32 nameLen + UTF-16LE name (event handler or free-form script unit)
  18 flag bytes          # byte 0 = 0x01 for event handlers, 0x0a for a script unit
  u32 lineCount
  per line: u32 charCount + UTF-16LE text   # no newlines stored inside a line
```

Verified: parse → re-encode reproduces the input **byte for byte** for
`project_SwimmingPool` (9 scripts, 6941 bytes), `SwimmingPool_pql` (10),
`final_project` (0). `Demo-project` (82820 bytes) uses a **different container** — the header
carries a named script group (`"..\"` + `u32 3` + `u32 0d` + `u32 33` + UTF-8 group name) —
so the standard parser reports `implausible name length … at offset 31` and the bridge
degrades gracefully.

### 2.4 `Pages.spg` (fully mapped in 1.1.0)

```
[page header][subpage header][u32 count][object records…][trailer]
record: u16 type | u32 len(name) | name (ASCII) | body
body = record start + 6 + len(name)          # offsets must be taken from body, never from the record
```

`type 0` = service records (`PageN`, `SubpageN`, and the internal parts of composite
components such as `Scale`/`Field` inside a Level). `type 1..18` = screen objects: 1 Image,
2 Shape, 3 Pipe, 4 Text, 5 Field, 6 Scale, 7 Button, 8 Tank, 9 Level, 10 Time trends,
11 Valve, 12 Line, 13 Checkbox, 14 List, 15 Table, 16 Calendar, 17 Message list,
18 Schedule.

Proven field offsets inside `body`:

| offset | field | type |
| --- | --- | --- |
| +8 | X, Y, W, H | 4 × float32 |
| +40 | font colour | 3 bytes BGR |
| +45 | fill colour | 3 bytes BGR |
| +107 | object id (u32, +4 per object) | u32 |
| +111 | primary variable | `[u32 index][u32 0]`, absent = `FF × 8` |
| +127 | second variable | same |
| +137 | Text caption | `u32 len` + UTF-16LE |
| +141 | border colour | 3 bytes BGR |
| +151 / +219 | Button state-1 / state-2 names | `u32 len` + UTF-16LE |
| +171 / +235 | Button state-1 / state-2 texts | `u32 len` + UTF-16LE |

The **variable index** is the zero-based row of the variable inside its group (checked by
correlating two fields drawn on `rVib`/`rTemp`). Full Russian write-up with the traps:
`plugin/docs/pages-spg.md`.

Layout metrics (measured, not guessed — details in `plugin/docs/screen-layout.md`):

* page grid is **1280 × 720**; the client scales it (×2 on a 2560 × 1440 screen) and clips
  anything outside;
* the page caption is drawn **over** the top-left corner of the page;
* line height **32 px**, single text line 26–30 px, Cyrillic glyph ≈ **15 px**
  (`field width ≥ chars × 15`); text is centred **and clipped** by its field, with no
  ellipsis;
* the byte at `body+31` is a **font enumeration, not a size** (`9` renders huge, `12`
  microscopic, `17` is the Text default) — layout is fitted to the font, never the reverse.

### 2.5 `Project.spr`

`project_SwimmingPool` is 435 bytes. Decoded: project name, project GUID (u32 `0x24` +
36 UTF-16LE chars), database host / name / user / password flags (`localhost`, `MySQL`,
`root`, empty). Flag bytes for web access and the built-in OPC UA server are **not** mapped
→ settings are read-only, enable them in the UI.

## 3. Server admin interface (port 8758)

The desktop server ships a browser admin UI (`Web\webintf.html` + `Web\js\sswebintf.js`)
that talks plain JSON over a websocket: `ws://127.0.0.1:8758` (no path, no subprotocol).

```
-> {"c":100,"login":"","pass":"","sil":1}          auth (silent when both empty;
                                                    otherwise pass = sha256 hex)
<- {"type":501,"wine":0}                            authenticated
<- {"type":500}                                     authentication rejected

-> {"c":101,"page":N,"filters":{...},"same":0}
<- {"type":502,"page":N,"pagedata":{…},"common":{…}}  full page payload
<- {"type":504,…}                                     periodic state push (~1 s, deltas)

-> {"c":104,"id":PROJECT_ID}                        start project
-> {"c":105,"id":PROJECT_ID}                        stop project
-> {"c":106,"id":PROJECT_ID}                        restart project
-> {"c":102,"id":CLIENT_ID}                         disconnect a client
-> {"c":103,"id":0}                                 stop the server
-> {"c":107}                                        refresh
```

Pages: `1` server state, `2` projects, `3` OPC servers, `4` clients, `5` databases,
`6` journal, `7` shutdown, `8` loading.

Project page payload (page 2): `{"id","name","state","statetimestamp","vars","debug",
"scriptscur","scriptsmax","changescur","changesmax","exec":[…]}`. Deltas may contain only
`{"id":2}` — always fetch a fresh page-2 answer before deciding state.

Project states, verbatim from `Web/js/wilang_en.js`:

```
0 stopped (never activated)   1 queued        2 stopping      3 stopped
4 starting                    5 started       (6/7 transitional)
```

Journal page (6) returns a flat triple array, **kind first**:
`[kind, text, time, kind, text, time, …]`, kind `1` normal, `2` warning, `3` alarm.

`common` carries server counters: `shutdown, allclients, webclients, prjcount, jrnalarm,
dbcount, opccount`.

Ports: `8750` desktop clients, `8755` web client (http://host:8755/<ProjectName>),
`8758` admin UI (localhost only), `8753`/`8754` internal (report subsystem), built-in UA
server on its own per-project port.

## 4. Editor / compilation

* Server log on start: `user start project`, `Начинается активация`, `активирован`,
  `archiving system version: 2`; on stop a deactivation ladder ending `деактивирован`.
* `Logs\Editor-log.txt` on compile: `Start compile all` → `Get units begin/end` →
  `Get source code begin/end` → `Create bytecode begin/end` → `End compile all`.
* `Editor.exe` argv is ignored: launching with the project folder, with
  `Project.spr`, with `-project <path>` and with `--project-<path>` all land on the ZenGL
  start screen (`Новый проект / Открыть проект / О программе / Выход`). The window class is
  `ZenGL` and UIA exposes exactly one pane, so no control can be found or clicked.
* Hot keys: `Ctrl+Shift+S` save+compile, `F9` compile, `Shift+F9` compile all,
  `F5` debug run (saves, starts locally, launches a debug client; local projects only).
* Menu item strings present in `Editor.exe`: `FSaveAndCompileProjectItem`, `FCompileItem`,
  `FCompileAllItem`, plus PaxCompiler classes (`TPaxCompiler`, `TM_CompileResult`).

## 5. Built-in OPC UA server

Per project, endpoint `opc.tcp://<server-ip>:<port>` (manual example
`opc.tcp://192.168.1.27:49875`); the project ID forms the tag addresses; there is a
read-only mode and a "trust all" option. Variables are exposed as UA variable nodes under
`Objects`, nested by variable group. The bridge discovers the port by probing
`Server.exe`'s listening sockets and caches the endpoint that answers.

## 6. Client command line

```
Client.exe --host-192.168.1.38:8750 --project-"MyProject" --login-"Оператор" --pass-"123"
           [--tls-0|1] [--resolution-1920x1080]
```

`scada_run {action:"start", client:true}` uses this form with `--host-127.0.0.1:8750`.
