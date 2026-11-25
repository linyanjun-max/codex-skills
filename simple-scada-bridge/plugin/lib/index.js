// ---------------------------------------------------------------------------
// simple-scada-bridge — Simple-Scada 2 automation for DeepSeek Harness
//
// Simple-Scada 2 (a SCADA/HMI builder by Simple-Scada, Delphi based) has no
// scripting API, no CLI and no HTTP/REST surface of its own. The bridge is built
// from the four surfaces that do exist, each verified on this machine:
//
//   1. PROJECT FILES  — Projects\<name>\{Variables.svr, Pages.spg, Scripts\
//      Scripts.ssc, Project.spr, ...} are binary Delphi streams; lib/binfmt.js
//      and lib/ssc.js decode and surgically rewrite them.
//   2. ADMIN WEBSOCKET — Server.exe serves a JSON admin UI on 127.0.0.1:8758
//      (Web/js/sswebintf.js). lib/admin.js speaks it: project start/stop/
//      restart, live project state, clients, journal messages, server shutdown.
//   3. OPC UA SERVER  — a project can publish its variables over OPC UA
//      (opc.tcp://<host>:<port>); scripts/ua_worker.py (asyncua) reads, writes
//      and watches them for live value access.
//   4. EDITOR HOT KEYS — compiling is done by Editor.exe (PaxCompiler). The
//      editor UI is ZenGL (no Win32/UIA controls) and ignores argv, so the
//      bridge focuses the window and sends Ctrl+Shift+S / F9, then proves the
//      result by bytecode timestamp and Editor-log.txt.
//
// Everything that cannot be proven is reported as a warning instead of being
// silently assumed: see scada_validate and scada_compile.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs'

import * as paths from './paths.js'
import * as admin from './admin.js'
import * as editor from './editor.js'
import * as values from './values.js'
import * as binfmt from './binfmt.js'
import * as ssc from './ssc.js'

export const name = 'simple-scada-bridge'

export const inject = ['tools']

const MAX_TEXT = 60000

function clip(text, limit) {
  const s = String(text === undefined || text === null ? '' : text)
  const n = limit || MAX_TEXT
  return s.length <= n ? s : s.slice(0, n) + '\n... (' + (s.length - n) + ' more chars)'
}

// JSON output must stay valid: if a payload is too large, return a structured
// truncation marker instead of a cut-off string.
function j(value) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= 150000) return text
  return JSON.stringify({
    truncated: true,
    note: 'result exceeded 150000 characters; narrow the request (filter, limit, what=<section>)',
    length: text.length,
    preview: text.slice(0, 4000),
  }, null, 2)
}

// Tool output is always a string: JSON for data, plain text for help.
function textTool(options) {
  const props = options.parameters || {}
  const properties = {}
  const required = []

  for (const key of Object.keys(props)) {
    const spec = props[key] || {}
    const prop = {}

    if (spec.type !== undefined && spec.type !== 'json') {
      prop.type = spec.type
    }
    if (spec.description !== undefined) {
      prop.description = spec.description
    }
    if (spec.enum !== undefined) {
      prop.enum = spec.enum.slice()
    }

    properties[key] = prop
    if (spec.required === true) {
      required.push(key)
    }
  }

  const parameters = { type: 'object', properties }
  if (required.length > 0) {
    parameters.required = required
  }

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: function (args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    execute: options.execute,
  }
}

export function apply(ctx, config) {
  const cfg = config || {}

  const state = {
    cache: null,
    cacheAt: 0,
  }

  // ---- configuration -----------------------------------------------------
  async function detect(force) {
    const now = Date.now()
    if (!force && state.cache && now - state.cacheAt < 15000) return state.cache
    const info = await paths.status()
    if (cfg.installDir) info.installDir = cfg.installDir
    if (cfg.dataDir) info.dataDir = cfg.dataDir
    if (cfg.projectsDir) info.projectsDir = cfg.projectsDir
    if (!info.projectsDir && info.dataDir) info.projectsDir = path.join(info.dataDir, 'Projects')
    state.cache = info
    state.cacheAt = now
    return info
  }

  async function projectDir(nameOrPath, info) {
    const env = info || await detect()
    return paths.resolveProject(env.projectsDir, nameOrPath)
  }

  function exePath(info, key) {
    const dir = info.installDir
    if (!dir) throw new Error('Simple-Scada installation directory was not found; pass installDir in the plugin config')
    const exe = path.join(dir, paths.EXE_NAMES[key])
    if (!existsSync(exe)) throw new Error('executable not found: ' + exe)
    return exe
  }

  function adminPort(info) {
    return cfg.adminPort || (info && info.ports && info.ports.admin) || paths.DEFAULT_ADMIN_PORT
  }

  // The project's built-in OPC UA server listens on its own port (configured in
  // the project settings; the manual example is opc.tcp://host:49875). Rather
  // than forcing the caller to know it, probe every listening port of
  // Server.exe and remember the one that answers OPC UA.
  const NON_UA_PORTS = [paths.DEFAULT_CLIENT_PORT, paths.DEFAULT_WEB_PORT, paths.DEFAULT_ADMIN_PORT, 8753, 8754]

  async function discoverUaEndpoint(info, options) {
    const o = options || {}
    if (o.force) state.uaEndpoint = null
    if (state.uaEndpoint) {
      const probe = await values.probeEndpoint(state.uaEndpoint, { timeoutSec: 3 })
      if (probe && probe.ok) return { endpoint: state.uaEndpoint, cached: true, probe: probe }
      state.uaEndpoint = null
    }
    const listening = (info && info.apps && info.apps.server && info.apps.server.listening) || []
    const candidates = listening
      .filter(function (p) { return NON_UA_PORTS.indexOf(p) < 0 })
      .map(function (p) { return 'opc.tcp://127.0.0.1:' + p })
    const probes = await Promise.all(candidates.map(function (ep) { return values.probeEndpoint(ep, { timeoutSec: 4 }) }))
    const hit = probes.find(function (p) { return p && p.ok })
    if (hit) {
      state.uaEndpoint = hit.endpoint
      return { endpoint: hit.endpoint, cached: false, probe: hit, scanned: candidates }
    }
    return {
      endpoint: null,
      scanned: candidates,
      listening: listening,
      hint: !listening.length
        ? 'Server.exe is not listening on any port: start the server (and the project) first.'
        : !candidates.length
          ? 'Server.exe listens on ' + listening.join(', ') + ' only - those are the admin/client ports, so no built-in OPC UA server is running. Enable it once in the editor (Проект -> Настройки -> встроенный OPC UA-сервер, set a port), then start the project with scada_run.'
          : 'Server.exe listens on ' + listening.join(', ') + '; its non-admin ports (' + candidates.join(', ') + ') did not answer OPC UA. Either the UA server is disabled in the project settings or the project is not started.',
    }
  }

  async function adminSession(fn, options) {
    const info = await detect()
    const opts = Object.assign({
      port: adminPort(info),
      host: cfg.adminHost || '127.0.0.1',
      timeoutMs: 12000,
      login: cfg.adminLogin || '',
      password: cfg.adminPassword || '',
    }, options || {})
    return await admin.withAdmin(opts, fn)
  }

  // ---- backups -----------------------------------------------------------
  function backupProject(dir, label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const root = cfg.backupDir || path.join(path.dirname(dir), '_dsh_backups')
    const target = path.join(root, path.basename(dir) + '_' + stamp + '_' + (label || 'edit'))
    mkdirSync(target, { recursive: true })
    let copied = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      copyFileSync(path.join(dir, entry.name), path.join(target, entry.name))
      copied++
    }
    const scriptsDir = path.join(dir, 'Scripts')
    if (existsSync(scriptsDir)) {
      const sd = path.join(target, 'Scripts')
      mkdirSync(sd, { recursive: true })
      for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
        if (entry.isFile()) copyFileSync(path.join(scriptsDir, entry.name), path.join(sd, entry.name))
      }
    }
    return { dir: target, files: copied }
  }

  // Refuse to edit a project the server currently has loaded, unless forced:
  // the running instance keeps the old model in memory and would overwrite it.
  async function guardNotRunning(dir, force) {
    const name = path.basename(dir)
    try {
      const res = await adminSession(async function (sess) { return await sess.projects() })
      const p = (res.projects || []).find(function (x) { return x.name === name })
      if (p && (p.state === 1 || p.state === 4 || p.state === 5) && !force) {
        return {
          ok: false,
          error: 'project "' + name + '" is ' + p.stateName + ' on the server; stop it first (scada_run action=stop) or pass force=true',
          state: p.stateName,
        }
      }
    } catch (e) {
      // server not reachable: editing offline files is safe
    }
    return { ok: true }
  }

  function readScriptsModel(dir) {
    const file = path.join(dir, 'Scripts', 'Scripts.ssc')
    if (!existsSync(file)) return null
    const buf = readFileSync(file)
    const parsed = ssc.parseScriptsSafe(buf)
    if (!parsed.ok) return { file, buf, model: null, error: parsed }
    return { file, buf, model: parsed.model }
  }

  const HELP_OVERVIEW = [
    'simple-scada-bridge - drive the locally installed Simple-Scada 2 (editor, server, client).',
    '',
    'Tools:',
    '  scada_status   {}                        installation, data path, processes, ports, OPC UA worker',
    '  scada_projects {}                        project folders + runtime state (server admin API)',
    '  scada_read     { project, what }         variables | pages | scripts | project | all',
    '  scada_edit     { project, what, action, payload }   surgical edits with automatic backup',
    '  scada_validate { project }               duplicate names, script refs, stale bytecode, bindings',
    '  scada_compile  { project, mode }          Ctrl+Shift+S / F9 in the editor, verified by bytecode',
    '  scada_run      { project, action }        start | stop | restart | status | stopServer | client',
    '  scada_journal  { project, lines, match } server log + journal messages',
    '  scada_values   { action, project, ... }   OPC UA read | write | watch | browse | wait',
    '  scada_help     { topic }                  this text | editing | runtime | values',
    '',
    'Typical loop:',
    '  1. scada_read  {project:"project_SwimmingPool", what:"scripts"}',
    '  2. scada_edit  {project:"...", what:"script", action:"set", payload:{"name":"Script_7","text":"..."}}',
    '  3. scada_compile {project:"..."}          (editor must have the project open)',
    '  4. scada_run   {project:"...", action:"start"}',
    '  5. scada_values {action:"watch", project:"...", nodes:["waterLevel"], seconds:10}',
    '',
    'Home directory: ' + (process.env.HOME || process.env.USERPROFILE || '') ,
    '',
    'Hard facts this bridge is built on (see scada_help topic=runtime):',
    '  * the server loads Scripts\\Compiled\\program.exs, never Scripts.ssc, so source edits need a',
    '    recompile in Editor.exe before a started project sees them;',
    '  * Editor.exe ignores argv and its window is ZenGL (no Win32/UIA controls), so the bridge can',
    '    only focus it and send hot keys - the project has to be open in the editor window;',
    '  * live variable values come from the project built-in OPC UA server (project settings), not',
    '    from the admin websocket, which only exposes project state, clients and messages.',
  ].join('\n')

  const HELP_EDITING = [
    'Editing model files (all writes are backed up first, then re-validated):',
    '',
    '  scripts   payload: {"name":"Script_7","text":"begin\\n  ...\\nend."}',
    '            actions: set | add | remove | rename | append',
    '            add:   payload {"name":"MyScript","text":"...","flags":"..."} (flags optional)',
    '            append: payload {"name":"Script_7","text":"..."} adds lines at the end',
    '',
    '  variables payload: {"name":"waterLevel","set":{"description":"...","format":"0.0"}}',
    '            actions: set | add | remove',
    '            (binfmt.js only writes fields whose offset is proven; unknown fields raise an',
    '             error instead of corrupting the record)',
    '',
    '  pages     actions: list | move | text | variable | color | clone | delete | set-caption\n            move     {"name":"fVib","x":10,"y":20,"width":80,"height":24}\n            text     {"name":"ttl","text":"..."}\n            variable {"name":"fVib","variable":"rTemp"}      (или index=15)\n            color    {"name":"panelObj","fill":"#24303A","border":"#3C4C5C"}\n            clone    {"from":"fVib","name":"fNew","x":300,"y":300,"width":80,"height":24,"variable":"rSpeed"}\n            caption  {"page":"Page1","caption":"Мнемосхема"}\n            формат и грабли: docs/pages-spg.md',
    '',
    '  project   payload {"set":{"webAccess":1}} - only decoded Project.spr fields are writable',
    '',
    'Every successful edit returns: backupDir, changed file, byte delta and a re-parse check.',
    'If Scripts.ssc changed, program.exs becomes stale: run scada_compile before scada_run start.',
  ].join('\n')

  const HELP_RUNTIME = [
    'Runtime control goes through the Server admin websocket (ws://127.0.0.1:8758):',
    '  {"c":100,...} auth, {"c":101,"page":N,...} page request (1 server, 2 projects, 3 OPC,',
    '  4 clients, 5 databases, 6 journal, 7 shutdown), {"c":104|105|106,"id":ID} start/stop/restart.',
    'Project states (Web/js/wilang_en.js): 0/3 stopped, 1 queued, 2 stopping, 4 starting, 5 started.',
    'Answers are JSON: type 500 auth failed, 501 auth ok, 502 page payload, 504 periodic push.',
    '',
    'Start/stop is graceful: Server-log.txt records "user start project" / "user stop project" and',
    'the full activation/deactivation ladder, which scada_journal returns.',
    '',
    'Compiling: Editor.exe embeds PaxCompiler and writes Scripts\\Compiled\\program.exs',
    '(Logs\\Editor-log.txt shows "Start compile all" ... "Create bytecode" ... "End compile all").',
    'Hot keys: Ctrl+Shift+S save+compile, F9 compile, Shift+F9 compile all, F5 debug run.',
    'The editor window is ZenGL, so it cannot be scripted through Win32/UIA: open the project in the',
    'editor once, then scada_compile sends the hot key and verifies the bytecode timestamp.',
  ].join('\n')

  const HELP_VALUES = [
    'Live values: Simple-Scada publishes project variables through its built-in OPC UA server.',
    'Enable it once in the editor: Проект -> Настройки -> встроенный OPC UA-сервер, then set a port.',
    'The endpoint is opc.tcp://<server-ip>:<port> (the project ID appears in the tag addresses).',
    '',
    '  scada_values {action:"discover"}                          # locate the project UA port by probing Server.exe',
    '  scada_values {action:"wait",   endpoint:"opc.tcp://127.0.0.1:49875", seconds:30}',
    '  scada_values {action:"browse", endpoint:"...", limit:200}',
    '  scada_values {action:"read",   endpoint:"...", nodes:["waterLevel","xMotor"]}',
    '  scada_values {action:"write",  endpoint:"...", values:{"waterLevel":90,"xMotor":true}}',
    '  scada_values {action:"watch",  endpoint:"...", nodes:["waterLevel"], seconds:10, intervalMs:250}',
    '',
    'nodes may be browse names, "Objects/Pool/Tank/Level" paths, or "ns=2;s=..." NodeIds.',
    'The OPC UA worker is scripts/ua_worker.py inside the plugin, running on the plugin virtualenv',
    '(.venv, asyncua 2.x); scada_status reports whether that interpreter is ready.',
    '',
    'Without an explicit endpoint the bridge probes every listening port of Server.exe and caches the',
    'one that answers OPC UA (action=discover rescans). When none answers, the tool states whether the',
    'server is down, the UA server is disabled, or only admin/client ports are open.',
  ].join('\n')

  const help = function (topic) {
    const t = String(topic || 'overview').toLowerCase()
    if (t === 'editing' || t === 'edit') return HELP_EDITING
    if (t === 'runtime' || t === 'run') return HELP_RUNTIME
    if (t === 'values' || t === 'opcua' || t === 'opc') return HELP_VALUES
    return HELP_OVERVIEW
  }

  // =========================================================================
  // scada_status
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_status',
    description: 'Report the local Simple-Scada 2 installation: install/data directories from the registry, project list, running Server/Client/Editor processes with their listening ports, and whether the OPC UA worker (asyncua) in the plugin virtualenv is usable. Call this first.',
    parameters: {
      refresh: { type: 'boolean', description: 'Ignore the 15 s cache and re-detect.' },
    },
    execute: async function (a) {
      const info = await detect(a && a.refresh)
      const projects = paths.projectFolders(info.projectsDir).map(function (p) { return path.basename(p) })
      const ua = await values.workerStatus()
      let serverState = null
      if (info.apps.server && info.apps.server.running) {
        try {
          serverState = await adminSession(async function (sess) { return await sess.projects() })
        } catch (e) {
          serverState = { error: e.message }
        }
      }
      let uaEndpoint = null
      if (info.apps.server && info.apps.server.running) {
        try {
          const d = await discoverUaEndpoint(info, {})
          uaEndpoint = d.endpoint || null
        } catch (e) { uaEndpoint = null }
      }
      const out = {
        uaEndpoint: uaEndpoint,
        installDir: info.installDir,
        dataDir: info.dataDir,
        projectsDir: info.projectsDir,
        language: info.language,
        license: { types: info.types, components: info.components },
        projectCount: projects.length,
        projects: projects,
        apps: info.apps,
        ports: info.ports,
        admin: serverState ? {
          reachable: true,
          projects: serverState.projects,
          common: serverState.common,
        } : { reachable: false, note: 'start Server.exe (or install it as a service) to use scada_run/scada_journal' },
        opcUaWorker: ua,
        plugin: {
          version: '0.1.0',
          node: process.version,
          backupDir: cfg.backupDir || path.join(info.projectsDir || '', '_dsh_backups'),
        },
      }
      return j(out)
    },
  }))

  // =========================================================================
  // scada_projects
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_projects',
    description: 'List Simple-Scada project folders with a model summary (variables, scripts, pages, trends, messages, bytecode freshness) and, when the server is running, the live project state from the admin API.',
    parameters: {
      project: { type: 'string', description: 'Optional project name: return the detailed summary for one project.' },
      limit: { type: 'number', description: 'Maximum number of projects to list (default 50).' },
    },
    execute: async function (a) {
      const info = await detect()
      if (!info.projectsDir) throw new Error('projects directory not found; is Simple-Scada installed?')
      const folders = paths.projectFolders(info.projectsDir)
      const wanted = a && a.project ? folders.filter(function (p) { return path.basename(p).toLowerCase() === String(a.project).toLowerCase() }) : folders
      let runtime = null
      try {
        const res = await adminSession(async function (sess) { return await sess.projects() })
        runtime = res.projects
      } catch (e) { runtime = null }
      const list = wanted.slice(0, (a && a.limit) || 50).map(function (dir) {
        const name = path.basename(dir)
        const summary = binfmt.summarizeProject(dir)
        const rt = runtime && runtime.find(function (p) { return p.name === name })
        return Object.assign({ name: name, path: dir }, summary, {
          runtime: rt ? { id: rt.id, state: rt.state, stateName: rt.stateName, vars: rt.vars, exec: rt.exec } : null,
        })
      })
      return j({ projectsDir: info.projectsDir, adminReachable: !!runtime, count: list.length, projects: list })
    },
  }))

  // =========================================================================
  // scada_read
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_read',
    description: 'Read a Simple-Scada project model: variables (names, descriptions, ids, raw field areas), scripts (full source), pages/elements, project settings, and a freshness summary. Use what="all" for a full picture.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project folder name (e.g. project_SwimmingPool) or an absolute path.' },
      what: { type: 'string', description: 'summary | variables | scripts | pages | project | all (default summary).' },
      filter: { type: 'string', description: 'Case-insensitive substring filter applied to variable/script/page names.' },
      includeSource: { type: 'boolean', description: 'Include script source text (default true).' },
      includeRaw: { type: 'boolean', description: 'Also return the raw hex bytes of every variable record (large; default false).' },
      limit: { type: 'number', description: 'Maximum entries per section (default 200).' },
    },
    execute: async function (a) {
      const info = await detect()
      const dir = await projectDir(a && a.project, info)
      const what = String((a && a.what) || 'summary').toLowerCase()
      const filter = (a && a.filter ? String(a.filter) : '').toLowerCase()
      const limit = (a && a.limit) || 200
      const includeSource = !(a && a.includeSource === false)
      const match = function (name) { return !filter || String(name).toLowerCase().indexOf(filter) >= 0 }

      const out = { project: path.basename(dir), path: dir, what: what }

      if (what === 'summary' || what === 'all') {
        out.summary = binfmt.summarizeProject(dir)
      }
      if (what === 'variables' || what === 'all') {
        const parsed = binfmt.readVariables(dir, !!(a && a.includeRaw))
        out.variables = {
          groups: parsed.groups.map(function (g) { return g.name }),
          count: parsed.total,
          items: parsed.items.filter(function (v) { return match(v.name) }).slice(0, limit),
          warnings: parsed.warnings,
        }
      }
      if (what === 'scripts' || what === 'all') {
        const sm = readScriptsModel(dir)
        if (!sm) out.scripts = { count: 0, items: [], note: 'no Scripts\\Scripts.ssc in this project' }
        else if (!sm.model) out.scripts = { count: null, items: [], error: sm.error.error, note: sm.error.note }
        else {
          const items = ssc.listScripts(sm.model).filter(function (s) { return match(s.name) }).slice(0, limit)
          out.scripts = {
            count: sm.model.records.length,
            items: items.map(function (s) {
              return includeSource ? s : { id: s.id, name: s.name, lines: s.lines, chars: s.chars }
            }),
            bytecode: editor.bytecodeStale(dir),
          }
        }
      }
      if (what === 'pages' || what === 'all') {
        const pages = binfmt.readPages(dir)
        out.pages = {
          count: pages.pages.length,
          items: pages.pages.filter(function (p) { return match(p.name) }).slice(0, limit),
          objectNames: (pages.objectNames || []).filter(function (o) { return match(o.name) }).slice(0, limit * 4),
          objectNameCount: (pages.objectNames || []).length,
          warnings: pages.warnings,
        }
      }
      if (what === 'project' || what === 'all') {
        out.projectSettings = binfmt.readProjectSettings(dir)
      }
      return j(out)
    },
  }))

  // =========================================================================
  // scada_edit
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_edit',
    description: 'Edit a Simple-Scada project: script source (set/add/remove/rename/append), variable fields whose byte offsets are proven, screen elements on Pages.spg (move/text/variable/color/clone/delete), page captions, project settings. Creates a timestamped backup, refuses to edit a project that is running on the server unless force=true, re-parses the result and reports the byte delta.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project folder name or absolute path.' },
      what: { type: 'string', required: true, description: 'script | variable | page | project' },
      action: { type: 'string', required: true, description: 'script: set|add|remove|rename|append; variable: set|add|remove; page: list|move|text|variable|color|clone|delete|set-caption (see docs/pages-spg.md); project: set' },
      payload: { type: 'string', description: 'JSON object with the edit data (see scada_help topic=editing).' },
      force: { type: 'boolean', description: 'Allow editing while the project is loaded on the server.' },
      dryRun: { type: 'boolean', description: 'Compute the change without writing files.' },
    },
    execute: async function (a) {
      const info = await detect()
      const dir = await projectDir(a && a.project, info)
      const what = String((a && a.what) || '').toLowerCase()
      const action = String((a && a.action) || '').toLowerCase()
      let payload = {}
      if (a && a.payload) {
        if (typeof a.payload === 'string') {
          try { payload = JSON.parse(a.payload) } catch (e) { throw new Error('payload must be valid JSON: ' + e.message) }
        } else payload = a.payload
      }
      const guard = await guardNotRunning(dir, !!(a && a.force))
      if (!guard.ok) return j(guard)

      if (what === 'script') {
        const sm = readScriptsModel(dir)
        if (!sm) throw new Error('Scripts\\Scripts.ssc not found in ' + dir)
        if (!sm.model) throw new Error(sm.error.note + ' (' + sm.error.error + ')')
        const name = payload.name
        let result
        if (action === 'set') {
          if (!name) throw new Error('payload.name is required')
          ssc.setScriptText(sm.model, name, payload.text === undefined ? '' : payload.text)
          result = { action: 'set', name: name }
        } else if (action === 'append') {
          const rec = ssc.findScript(sm.model, name)
          if (!rec) throw new Error('script not found: ' + name)
          rec.lines = rec.lines.concat(String(payload.text || '').replace(/\r\n/g, '\n').split('\n'))
          result = { action: 'append', name: name, lines: rec.lines.length }
        } else if (action === 'add') {
          const rec = ssc.addScript(sm.model, name, payload.text || '', payload.flags)
          result = { action: 'add', name: name, id: rec.id, lines: rec.lines.length }
        } else if (action === 'remove') {
          ssc.removeScript(sm.model, name)
          result = { action: 'remove', name: name }
        } else if (action === 'rename') {
          ssc.renameScript(sm.model, name, payload.to)
          result = { action: 'rename', from: name, to: payload.to }
        } else {
          throw new Error('unknown script action: ' + action)
        }
        const out = ssc.buildScripts(sm.model)
        // prove the model still round-trips before touching the file
        const reparsed = ssc.parseScripts(out)
        if (reparsed.records.length !== sm.model.records.length) throw new Error('internal error: script model does not round-trip')
        const before = sm.buf.length
        if (!(a && a.dryRun)) {
          const backup = backupProject(dir, 'script-' + action)
          writeFileSync(sm.file, out)
          result.file = sm.file
          result.backupDir = backup.dir
        }
        result.sizes = { before: before, after: out.length, delta: out.length - before }
        result.scripts = reparsed.records.length
        result.nextStep = 'scada_compile (bytecode is stale until the editor recompiles)'
        return j({ ok: true, project: path.basename(dir), edit: result })
      }

      if (what === 'variable') {
        const res = binfmt.editVariables(dir, action, payload, !!(a && a.dryRun))
        if (res && res.backupDir === undefined && !(a && a.dryRun)) {
          const backup = backupProject(dir, 'variable-' + action)
          res.backupDir = backup.dir
        }
        return j({ ok: true, project: path.basename(dir), edit: res })
      }

      if (what === 'page') {
        const res = binfmt.editPages(dir, action, payload, !!(a && a.dryRun))
        if (res && res.backupDir === undefined && !(a && a.dryRun)) {
          const backup = backupProject(dir, 'page-' + action)
          res.backupDir = backup.dir
        }
        return j({ ok: true, project: path.basename(dir), edit: res })
      }

      if (what === 'project') {
        const res = binfmt.editProjectSettings(dir, action, payload, !!(a && a.dryRun))
        if (res && res.backupDir === undefined && !(a && a.dryRun)) {
          const backup = backupProject(dir, 'project-' + action)
          res.backupDir = backup.dir
        }
        return j({ ok: true, project: path.basename(dir), edit: res })
      }

      throw new Error('unknown what: ' + what + ' (script | variable | page | project)')
    },
  }))

  // =========================================================================
  // scada_validate
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_validate',
    description: 'Static validation of a project before running it: binary files parse, duplicate variable/script names, script identifier/name syntax, scripts referencing unknown variables, page elements bound to unknown variables, bytecode freshness. Returns errors, warnings and a pass/fail verdict.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project folder name or absolute path.' },
      deep: { type: 'boolean', description: 'Also check that the OPC UA worker can start and the server admin API answers.' },
    },
    execute: async function (a) {
      const info = await detect()
      const dir = await projectDir(a && a.project, info)
      const errors = []
      const warnings = []
      const notes = []

      let vars = null
      try {
        vars = binfmt.readVariables(dir)
        notes.push('variables parsed: ' + vars.total + ' in ' + vars.groups.length + ' group(s)')
        const seen = new Map()
        for (const v of vars.items) {
          const key = v.name.toLowerCase()
          if (seen.has(key)) errors.push('duplicate variable name: ' + v.name)
          seen.set(key, true)
          if (!ssc.NAME_RE.test(v.name)) errors.push('variable name is not a valid identifier: ' + v.name)
        }
        warnings.push.apply(warnings, vars.warnings || [])
      } catch (e) {
        errors.push('Variables.svr: ' + e.message)
      }

      let scriptModel = null
      try {
        const sm = readScriptsModel(dir)
        if (!sm) warnings.push('project has no Scripts\\Scripts.ssc')
        else if (!sm.model) warnings.push('scripts: ' + sm.error.note + ' (' + sm.error.error + ')')
        else {
          scriptModel = sm.model
          notes.push('scripts parsed: ' + sm.model.records.length)
          const names = new Set()
          for (const rec of sm.model.records) {
            if (!ssc.NAME_RE.test(rec.name)) errors.push('script name is not a valid identifier: ' + rec.name)
            if (names.has(rec.name.toLowerCase())) errors.push('duplicate script name: ' + rec.name)
            names.add(rec.name.toLowerCase())
            if (!rec.lines.length) warnings.push('script has no lines: ' + rec.name)
            const text = rec.lines.join('\n')
            if (/\bbegin\b/i.test(text) && !/\bend\.?\s*$/.test(text)) warnings.push('script "' + rec.name + '" opens begin without a closing end: ' + rec.lines.length + ' lines')
          }
        }
      } catch (e) {
        errors.push('Scripts.ssc: ' + e.message)
      }

      // scripts referencing variables that do not exist
      if (vars && scriptModel) {
        const varNames = new Set(vars.items.map(function (v) { return v.name }))
        const accessors = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(Value|AsBool|AsFloat|AsInt|AsStr|AsInt64|AsSingle|AsDouble|AsExtended|AsDateTime|Quality|Timestamp|Units)\b/g
        for (const rec of scriptModel.records) {
          const text = rec.lines.join('\n')
          let m
          while ((m = accessors.exec(text)) !== null) {
            const id = m[1]
            if (!varNames.has(id)) warnings.push('script "' + rec.name + '" uses "' + id + '.' + m[2] + '" but no such variable exists')
          }
        }
      }

      // pages
      try {
        const pages = binfmt.readPages(dir)
        notes.push('pages parsed: ' + pages.pages.length)
        const varNames = vars ? new Set(vars.items.map(function (v) { return v.name })) : null
        for (const page of pages.pages) {
          for (const el of page.elements || []) {
            if (varNames && el.variable && !varNames.has(el.variable)) {
              warnings.push('element "' + el.name + '" on page "' + page.name + '" is bound to unknown variable "' + el.variable + '"')
            }
          }
        }
        warnings.push.apply(warnings, pages.warnings || [])
      } catch (e) {
        errors.push('Pages.spg: ' + e.message)
      }

      // bytecode freshness
      const stale = editor.bytecodeStale(dir)
      if (stale.stale) warnings.push('bytecode: ' + stale.reason)

      if (a && a.deep) {
        const ua = await values.workerStatus()
        if (!ua.ok) warnings.push('OPC UA worker not usable: ' + ua.error)
        else notes.push('OPC UA worker: asyncua ' + ua.asyncua + ' (python ' + ua.python + ')')
        try {
          const res = await adminSession(async function (sess) { return await sess.projects() })
          const p = (res.projects || []).find(function (x) { return x.name === path.basename(dir) })
          notes.push('server admin API reachable; project state: ' + (p ? p.stateName : 'not listed'))
        } catch (e) {
          warnings.push('server admin API not reachable: ' + e.message)
        }
      }

      return j({
        ok: errors.length === 0,
        project: path.basename(dir),
        path: dir,
        errors: errors,
        warnings: warnings,
        notes: notes,
        verdict: errors.length === 0 ? (warnings.length ? 'pass with warnings' : 'pass') : 'fail',
      })
    },
  }))

  // =========================================================================
  // scada_compile
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_compile',
    description: 'Compile the project scripts with Editor.exe: focuses the editor window and sends the hot key (Ctrl+Shift+S save+compile by default), then verifies by the Compiled\\program.exs timestamp and the Editor-log.txt compile ladder. The editor window must have the project open (it cannot be opened headlessly - see scada_help topic=runtime).',
    parameters: {
      project: { type: 'string', required: true, description: 'Project folder name or absolute path.' },
      mode: { type: 'string', description: 'saveAndCompile (Ctrl+Shift+S, default) | compile (F9) | compileAll (Shift+F9) | debug (F5)' },
      openEditor: { type: 'boolean', description: 'Launch Editor.exe first if it is not running.' },
      waitMs: { type: 'number', description: 'How long to wait after the keystroke before verifying (default 8000 ms).' },
    },
    execute: async function (a) {
      const info = await detect()
      const dir = await projectDir(a && a.project, info)
      const mode = String((a && a.mode) || 'saveAndCompile')
      const keys = editor.HOTKEYS[mode] || editor.HOTKEYS.saveAndCompile
      const before = editor.compiledInfo(dir)
      const logFile = path.join(info.dataDir || '', 'Logs', 'Editor-log.txt')
      const logBefore = existsSync(logFile) ? statSync(logFile).size : 0
      const staleBefore = editor.bytecodeStale(dir)

      let running = info.apps.editor && info.apps.editor.running
      if (!running && !(a && a.openEditor)) {
        return j({
          ok: false,
          compiled: false,
          reason: 'Editor.exe is not running. Pass openEditor=true to launch it, then open the project in the editor window (File -> Open project) and run scada_compile again.',
          stale: staleBefore,
          compiledInfo: before,
        })
      }

      let editorExe = ''
      try { editorExe = exePath(info, 'editor') } catch (e) { editorExe = '' }
      const send = await editor.sendHotkey(editorExe, keys, (a && a.waitMs) || 8000)
      const after = editor.compiledInfo(dir)
      const logText = editor.tailFile(logFile, 20000)
      const newLog = logText.length > logBefore ? logText.slice(Math.max(0, logText.length - (logText.length - logBefore))) : ''
      const compileLog = editor.compileLogSince(newLog)

      const programChanged = !!(after.program && before.program && after.program.mtimeMs !== before.program.mtimeMs)
      const firstCompile = !!(after.program && !before.program)
      const ok = programChanged || firstCompile

      return j({
        ok: send.ok && ok,
        compiled: ok,
        hotkey: { keys: keys, mode: mode, sent: send.ok, foreground: send.foreground, window: send.title, launched: send.launched },
        bytecode: {
          before: before.program ? before.program.mtime : null,
          after: after.program ? after.program.mtime : null,
          sizeBefore: before.program ? before.program.size : null,
          sizeAfter: after.program ? after.program.size : null,
          changed: programChanged,
        },
        staleBefore: staleBefore,
        editorLog: compileLog,
        reason: ok ? null
          : 'the bytecode did not change. Either the editor has no project open, or the compile reported errors (check editorLog). Open ' + path.basename(dir) + ' in the editor window and retry.',
        nextStep: ok ? 'scada_run action=start to load the new bytecode' : 'open the project in Editor.exe, then retry',
      })
    },
  }))

  // =========================================================================
  // scada_run
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_run',
    description: 'Control a project on the Simple-Scada server through the admin API: status, start (training/simulation run), stop, restart, stop the whole server, and optionally launch the desktop client against the running project.',
    parameters: {
      project: { type: 'string', description: 'Project folder name (required except for action=stopServer/status).' },
      action: { type: 'string', required: true, description: 'status | start | stop | restart | stopServer | client' },
      waitMs: { type: 'number', description: 'How long to wait for the state transition (default 30000).' },
      client: { type: 'boolean', description: 'With action=start: also launch Client.exe attached to the project.' },
      login: { type: 'string', description: 'Client login (optional).' },
      password: { type: 'string', description: 'Client password (optional).' },
      resolution: { type: 'string', description: 'Client resolution for --resolution-WxH (optional).' },
    },
    execute: async function (a) {
      const info = await detect()
      const action = String((a && a.action) || 'status').toLowerCase()
      const waitMs = (a && a.waitMs) || 30000

      if (action === 'stopserver') {
        const res = await adminSession(async function (sess) { await sess.stopServer(); return { sent: true } })
        return j({ ok: true, server: res, note: 'Server.exe shutdown requested through the admin API' })
      }

      const dir = await projectDir(a && a.project, info)
      const projectName = path.basename(dir)

      const res = await adminSession(async function (sess) {
        const list = await sess.projects()
        const p = (list.projects || []).find(function (x) { return x.name === projectName }) || null
        if (action === 'status' || !p) return { found: !!p, project: p, common: list.common }
        if (action === 'start') {
          if (p.state !== 0 && p.state !== 3) return { found: true, project: p, skipped: 'already ' + p.stateName }
          await sess.startProject(p.id)
          const after = await sess.waitForProjectState(p.id, [5], waitMs)
          return { found: true, project: after || p, common: (await sess.projects()).common }
        }
        if (action === 'stop') {
          if (p.state === 0 || p.state === 3) return { found: true, project: p, skipped: 'already ' + p.stateName }
          await sess.stopProject(p.id)
          const after = await sess.waitForProjectState(p.id, [0, 3, 7], waitMs)
          return { found: true, project: after || p, common: (await sess.projects()).common }
        }
        if (action === 'restart') {
          await sess.restartProject(p.id)
          const after = await sess.waitForProjectState(p.id, [5], waitMs)
          return { found: true, project: after || p, common: (await sess.projects()).common }
        }
        throw new Error('unknown action: ' + action)
      })

      const out = { ok: true, action: action, project: projectName, server: res, stale: editor.bytecodeStale(dir) }
      if (res && res.skipped) out.note = res.skipped

      if (action === 'start' && (a && a.client)) {
        const exe = exePath(info, 'client')
        const args = ['--host-127.0.0.1:' + (info.ports.client || paths.DEFAULT_CLIENT_PORT), '--project-' + projectName]
        if (a.login) args.push('--login-' + a.login)
        if (a.password) args.push('--pass-' + a.password)
        if (a.resolution) args.push('--resolution-' + a.resolution)
        const { spawn } = await import('node:child_process')
        const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
        child.unref()
        out.client = { launched: true, pid: child.pid, argv: [exe].concat(args) }
      }
      return j(out)
    },
  }))

  // =========================================================================
  // scada_journal
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_journal',
    description: 'Read the runtime journal for "background results": journal messages from the server admin API (plain events, bound violations, operator actions, project operations) plus the tail of Logs\\Server-log.txt and the project log lines.',
    parameters: {
      project: { type: 'string', description: 'Optional project name to filter server log lines.' },
      lines: { type: 'number', description: 'Server log lines to return (default 80).' },
      match: { type: 'string', description: 'Only keep entries whose text matches this regular expression (case-insensitive). Do not use the name "pattern": it is reserved by JSON Schema.' },
      journal: { type: 'boolean', description: 'Include admin-journal messages (default true).' },
      level: { type: 'number', description: 'Journal level filter: 3 warnings, 4 alarms (server filter field).' },
    },
    execute: async function (a) {
      const info = await detect()
      const lines = (a && a.lines) || 80
      const matchExpr = (a && a.match) || (a && a.regex) || null
      const re = matchExpr ? new RegExp(String(matchExpr), 'i') : null
      const projectName = a && a.project ? String(a.project) : null

      const logFile = path.join(info.dataDir || '', 'Logs', 'Server-log.txt')
      const logText = editor.tailFile(logFile, 200000)
      let tail = logText.split(/\r?\n/).filter(Boolean)
      if (projectName) tail = tail.filter(function (l) { return l.toLowerCase().indexOf(projectName.toLowerCase()) >= 0 })
      if (re) tail = tail.filter(function (l) { return re.test(l) })
      tail = tail.slice(-lines)

      let journalMessages = null
      if (!(a && a.journal === false)) {
        try {
          journalMessages = await adminSession(async function (sess) {
            const filters = Object.assign({}, {
              clientsOnly: 0,
              level: (a && a.level) || 0,
              grScripts: 1, grOPC: 1, grReports: 1, grDB: 1, grMail: 1,
            })
            const res = await sess.journal(filters)
            return res.items || []
          })
          if (re) journalMessages = journalMessages.filter(function (m) { return re.test(String(m.text)) })
          if (projectName) journalMessages = journalMessages.filter(function (m) { return String(m.text).toLowerCase().indexOf(projectName.toLowerCase()) >= 0 })
        } catch (e) {
          journalMessages = { error: e.message }
        }
      }

      return j({
        serverLog: { file: logFile, lines: tail },
        journal: journalMessages && journalMessages.error ? journalMessages : { count: (journalMessages || []).length, messages: (journalMessages || []).slice(-((a && a.lines) || 80)) },
      })
    },
  }))

  // =========================================================================
  // scada_values
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_values',
    description: 'Read, write and watch live project variables over OPC UA (the built-in UA server of the project): action=read|write|watch|browse|wait|status. Use watch for background sampling of results; nodes accept browse names, Objects/... paths or ns=2;s=... NodeIds.',
    parameters: {
      action: { type: 'string', required: true, description: 'status | discover | wait | browse | read | write | watch' },
      endpoint: { type: 'string', description: 'opc.tcp://host:port of the project UA server. Omit to let the bridge guess from the config.' },
      nodes: { type: 'string', description: 'Comma-separated node names/paths (default all).' },
      values: { type: 'string', description: 'JSON object {node: value} for action=write.' },
      seconds: { type: 'number', description: 'watch/wait duration in seconds (default 10 / 30).' },
      intervalMs: { type: 'number', description: 'watch sampling interval in ms (default 250).' },
      limit: { type: 'number', description: 'Maximum number of nodes (default 200).' },
      user: { type: 'string', description: 'OPC UA user name if the server requires authentication.' },
      password: { type: 'string', description: 'OPC UA password.' },
    },
    execute: async function (a) {
      const action = String((a && a.action) || 'status').toLowerCase()
      if (action === 'status') {
        const ua = await values.workerStatus()
        return j({
          ok: ua.ok,
          worker: ua,
          endpoint: (a && a.endpoint) || cfg.uaEndpoint || null,
          python: values.pythonPath(),
          hint: ua.ok ? null : 'create the plugin virtualenv: python -m venv <plugin>\\.venv && .venv\\Scripts\\pip install asyncua',
        })
      }
      const info = await detect()
      let endpoint = (a && a.endpoint) || cfg.uaEndpoint || null
      let discovery = null
      if (!endpoint || action === 'discover') {
        discovery = await discoverUaEndpoint(info, { force: action === 'discover' || !!(a && a.rescan) })
        endpoint = discovery.endpoint
      }
      if (action === 'discover') return j({ ok: !!endpoint, endpoint: endpoint, discovery: discovery })
      if (!endpoint) {
        return j({
          ok: false,
          error: 'no OPC UA endpoint found for the running server',
          discovery: discovery,
          hint: 'Enable the built-in UA server once: Editor -> Проект -> Настройки -> включить встроенный OPC UA-сервер (set a port), start the project with scada_run, then retry. See scada_help topic=values.',
        })
      }
      const nodes = a && a.nodes ? String(a.nodes).split(',').map(function (s) { return s.trim() }).filter(Boolean) : []
      const options = { user: a && a.user, password: a && a.password, limit: (a && a.limit) || 200 }

      if (action === 'wait') return j(await values.waitForEndpoint(endpoint, (a && a.seconds) || 30, options))
      if (action === 'browse') return j(await values.browse(endpoint, options))
      if (action === 'read') return j(await values.readValues(endpoint, nodes, options))
      if (action === 'write') {
        let mapping = a && a.values
        if (typeof mapping === 'string') {
          try { mapping = JSON.parse(mapping) } catch (e) { throw new Error('values must be a JSON object: ' + e.message) }
        }
        if (!mapping || typeof mapping !== 'object') throw new Error('values must be a JSON object {node: value}')
        return j(await values.writeValues(endpoint, mapping, options))
      }
      if (action === 'watch') {
        const seconds = (a && a.seconds) || 10
        const res = await values.watchValues(endpoint, nodes, Object.assign({ seconds: seconds, intervalMs: (a && a.intervalMs) || 250 }, options))
        // summarise per node: min/max/last, so a long watch stays readable
        if (res && Array.isArray(res.samples)) {
          const series = {}
          for (const sample of res.samples) {
            for (const v of sample.values || []) {
              const key = v.browseName || v.node
              if (!series[key]) series[key] = { samples: 0, min: null, max: null, last: null, status: null }
              const s = series[key]
              s.samples++
              s.last = v.value
              s.status = v.status
              if (typeof v.value === 'number') {
                s.min = s.min === null ? v.value : Math.min(s.min, v.value)
                s.max = s.max === null ? v.value : Math.max(s.max, v.value)
              }
            }
          }
          res.series = series
          res.samples = res.samples.slice(-5)
        }
        return j(res)
      }
      throw new Error('unknown action: ' + action)
    },
  }))

  // =========================================================================
  // scada_help
  // =========================================================================
  ctx.tools.register(textTool({
    name: 'scada_help',
    description: 'Cookbook for this bridge: overview of tools, model editing payloads, runtime/admin API facts and OPC UA setup. Call before the first non-trivial operation.',
    parameters: {
      topic: { type: 'string', description: 'overview | editing | runtime | values (default overview).' },
    },
    execute: async function (a) {
      return help(a && a.topic)
    },
  }))
}
