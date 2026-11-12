// ---------------------------------------------------------------------------
// modelio-codesys-bridge — an MCP-like bridge for Modelio 4.1 and CODESYS 3.5
//
// Both IDEs expose a scripting engine but no network/RPC surface. This plugin
// turns each engine into a model-callable tool: the agent writes Python
// (IronPython 2.7 for CODESYS, Jython 2.7 for Modelio), the plugin stages the
// script in a scratch run directory together with an ASCII-only wrapper, runs
// the IDE headlessly, and returns a structured JSON report (RESULT, captured
// stdout, errors, transaction/save state).
// ---------------------------------------------------------------------------
const CODESYS_ROOT = 'D:\\CODESYS 3.5'
const MODELIO_ROOT = 'D:\\modelio'
const SCRATCH_SUFFIX = '\\.dsh\\modelio-codesys-bridge'

function pad2(n) {
  return n < 10 ? '0' + String(n) : String(n)
}
function stamp() {
  const d = new Date()
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
    + '-' + Math.random().toString(36).slice(2, 6)
}
function trunc(v, n) {
  const s = String(v === undefined || v === null ? '' : v)
  return s.length <= n ? s : s.slice(0, n) + '\n…(' + String(s.length - n) + ' more chars)'
}
// Python unicode literal, guaranteed ASCII so the wrapper decodes identically
// under any platform charset (Modelio reads batch files with the system charset).
function pyStr(value) {
  const s = String(value)
  let out = "u'"
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (cp >= 32 && cp <= 126) out += ch
    else if (cp > 0xffff) {
      const hi = 0xd800 + ((cp - 0x10000) >> 10)
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff)
      out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0')
    } else out += '\\u' + cp.toString(16).padStart(4, '0')
  }
  return out + "'"
}
// JSON value -> Python literal (True/False/None, no JSON booleans).
function pyLiteral(v) {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None'
  if (typeof v === 'string') return pyStr(v)
  if (Array.isArray(v)) return '[' + v.map(function (x) { return pyLiteral(x) }).join(', ') + ']'
  if (typeof v === 'object') {
    const parts = []
    for (const k of Object.keys(v)) parts.push(pyStr(k) + ': ' + pyLiteral(v[k]))
    return '{' + parts.join(', ') + '}'
  }
  return 'None'
}

const WRAPPER = String.raw`# modelio-codesys-bridge wrapper (generated; edit the user script instead)
import sys, os, json, traceback
_APP = u'@@APP@@'
_RUN = @@RUN@@
_USER = @@USER@@
_RES = _RUN + u'\\result.json'
_ARGS = @@ARGS@@
_SAVE = @@SAVE@@
_CAP = []
_REAL_OUT = sys.stdout
class _Tee(object):
    def __init__(self, real):
        self.real = real
    def write(self, s):
        try:
            _CAP.append(s)
        except:
            pass
        if self.real is not None:
            try:
                self.real.write(s)
            except:
                pass
    def flush(self):
        if self.real is not None:
            try:
                self.real.flush()
            except:
                pass
sys.stdout = _Tee(_REAL_OUT)
_status = u'ok'
_error = None
_tx_err = None
_G = {}
_tx = None
try:
    if _APP == u'modelio':
        try:
            from org.modelio.api.modelio import Modelio
            _MS = Modelio.getInstance().getModelingSession()
            _MROOTS = _MS.getModel().getModelRoots()
            _tx = _MS.createTransaction(u'modelio-codesys-bridge batch')
        except:
            _tx = None
            _tx_err = traceback.format_exc()
    for _n in ('system', 'projects', 'online', 'librarymanager', 'Modelio', 'modelingSession', 'selectedElements', 'coreSession'):
        try:
            _G[_n] = eval(_n)
        except:
            pass
    _G['ARGS'] = _ARGS
    _G['__name__'] = u'__main__'
    try:
        _EXECFILE = execfile
    except NameError:
        _EXECFILE = None
    if _EXECFILE is not None:
        _EXECFILE(_USER, _G)
    else:
        _SRC = open(_USER, 'rb').read()
        exec(compile(_SRC, _USER, 'exec'), _G)
    _status = u'ok'
except SystemExit:
    _status = u'ok'
except:
    _status = u'error'
    _error = traceback.format_exc()
finally:
    try:
        sys.stdout = _REAL_OUT
    except:
        pass
    _extra = {}
    if _tx_err is not None:
        _extra['transaction_error'] = _tx_err
    if _tx is not None:
        try:
            if _status == u'ok':
                _tx.commit()
                _extra['transaction'] = 'committed'
            else:
                _tx.rollback()
                _extra['transaction'] = 'rolled-back'
        except:
            _extra['transaction_error'] = traceback.format_exc()
            try:
                _tx.rollback()
            except:
                pass
    if _APP == u'modelio' and _SAVE and _status == u'ok':
        try:
            _CS = eval(u'coreSession')
            _CS.save(None)
            _extra['saved'] = True
        except:
            _extra['save_error'] = traceback.format_exc()
    _payload = {'status': _status, 'error': _error, 'output': ''.join(_CAP), 'args': _ARGS}
    if 'RESULT' in _G:
        try:
            _payload['result'] = _G['RESULT']
        except:
            _payload['result'] = repr(_G['RESULT'])
    _payload.update(_extra)
    try:
        _f = open(_RES, 'wb')
        _f.write(json.dumps(_payload, default=str, ensure_ascii=True))
        _f.close()
    except:
        pass
`

const HELP_OVERVIEW = [
  'modelio-codesys-bridge — drive Modelio 4.1 (Jython batch) and CODESYS 3.5 (IronPython --runscript) from the agent.',
  '',
  'Tools:',
  '  bridge_status  → detected installs, profile, workspaces, scratch dir',
  '  codesys_run    → headless CODESYS script execution (script/scriptPath, args, timeout)',
  '  modelio_run    → headless Modelio batch execution (project/create/workspace, transaction, save)',
  '  bridge_launch_gui → open the IDE GUI detached (inspect the result visually)',
  '  bridge_help    → cookbook for one target (topic: overview|codesys|modelio)',
  '',
  'Script contract for both apps:',
  '  ARGS        — the JSON object passed in the tool `args` field',
  '  RESULT      — assign a JSON-serialisable value to return it in the tool result',
  '  print(...)  — captured; returned as `output`',
  '  Exit status is reported per-script: status=ok/error, error=traceback',
  '',
  'Every run gets an isolated run directory (reported as `runDir`; default <scratch>\\<app>\\<stamp>,',
  'where scratch is %USERPROFILE%\\.dsh\\modelio-codesys-bridge or the workspace root under a workspace-write policy)',
  'containing user.py (your script) and run.py (the generated wrapper) — inspect them after a failure.',
  'Write scripts to a file yourself and pass `scriptPath` when the code is long or needs iteration.',
  '',
  'Timeouts are enforced by killing the IDE process; a killed run returns timedOut=true and whatever',
  'stdout/result was produced before termination.',
].join('\n')

const HELP_CODESYS = [
  'CODESYS 3.5 SP15 Patch 3 — IronPython 2.7 (Python 2 syntax), headless via:',
  '  CODESYS.exe --profile="CODESYS V3.5 SP15 Patch 3" --runscript=... --noUI',
  '',
  'Globals injected into your script: projects, system, online, librarymanager (+ ARGS / RESULT).',
  'Those four are .NET objects: Python dir() returns [] for them. Discover members by reflection:',
  '    RESULT = sorted(set(str(m.Name) for m in projects.primary.GetType().GetMethods()))',
  'Note that attribute access (getattr) also finds dynamically extended members that reflection',
  'does not list, so try getattr(obj, "name") before concluding a method is missing.',
  '',
  'Verified globals this install:',
  '  projects      : all, convert, create, get_by_path, open, open_archive, primary',
  '  system        : abort_autocheck, commands, dump_scripting_api, exit, get_messages,',
  '                  process_messageloop, ui, write_message, ...',
  '  online        : PermittedSourceKindsForFallback, QueryForCredentials, auth_fallback_modes,',
  '                  create_online_application, create_online_device, gateways, ...',
  '  librarymanager: find_library, get_all_libraries, get_category, install_library, repositories, ...',
  '',
  'Verified IScriptProject members (SP15 reflection):',
  '  check_all_pool_objects, clean_all, close, compare_to, create_folder, document, export_doc,',
  '  export_native, export_xml, find, generate_runtime_system_files, get_active_application,',
  '  get_children, get_dirty, get_handle, get_library, get_path, get_primary, get_project_info,',
  '  get_project_settings, import_native, import_xml, login, logout, save, save_archive, save_as,',
  '  save_as_compiled_library, set_active_application — and the dynamic create_pou(name).',
  'There is NO project.build()/compile() in this version: the compiler runs on login/download.',
  '',
  'Verified working operations:',
  '  proj = projects.open(r"C:\\work\\demo.project")            # open existing project',
  '  proj = projects.create(r"C:\\work\\demo.project", True)     # create new project',
  '  names = [str(c.get_name()) for c in proj.get_children(False)]   # e.g. ["Project Settings","Device"]',
  '  pou   = proj.create_pou("PLC_PRG")                         # name-only works; returns POU object',
  '  folder = proj.create_folder("Util")',
  '  proj.save()                                                # persist changes',
  '  proj.find("PLC_PRG", True)                                 # locate an object recursively',
  '  app   = proj.active_application                            # ScriptObject for the application',
  '',
  'Typical documented patterns (validate with getattr/GetType before relying on them):',
  '  pou.textual_declaration.replace("PROGRAM PLC_PRG\\nVAR\\n  x : BOOL;\\nEND_VAR")',
  '  pou.textual_implementation.replace("x := TRUE;")',
  '  online_app = online.create_online_application(proj.active_application)',
  '  online_app.login(True)          # download + compile; raises with build errors',
  '  online_app.start()              # RUN',
  '  online_app.set_prepared_value("PLC_PRG.x", "TRUE"); online_app.write_prepared_values()',
  '  online_app.read_value("PLC_PRG.x")',
  '  online_app.stop(); online_app.logout()',
  '  proj.login() / proj.logout()    # project-level online helpers also exist',
  '  proj.save_archive(r"C:\\work\\backup.projectarchive")',
  '',
  'Practical notes:',
  '  - Work on a COPY of a real project when experimenting: CODESYS locks the project file while open.',
  '  - Simulation needs a simulated device (e.g. "CODESYS Control Win V3 x64" in Simulation mode);',
  '    login against a real gateway fails without one.',
  '  - Cold start of CODESYS is ~60-90 s; a project open+save loop is ~70 s. Budget timeouts.',
  '  - Local references: D:\\CODESYS 3.5\\CODESYS\\DocScripting, D:\\CODESYS 3.5\\CODESYS\\Online Help\\en.',
  '    system.dump_scripting_api() dumps the engine API when the help files are not enough.',
].join('\n')

const HELP_MODELIO = [
  'Modelio 4.1.00 — Jython 2.7 (Python 2 syntax), headless via:',
  '  modelio.exe -workspace <ws> (-project <name> | -create <name>) -batch <script.py>',
  '',
  'Globals injected into your script: Modelio (class), modelingSession, coreSession, ARGS.',
  'The wrapper touches the model, opens exactly one transaction, runs the script, commits (or rolls',
  'back on a script error) and — unless save=false — persists the model with coreSession.save(None).',
  'Do NOT create your own transaction unless you need several savepoints; a nested transaction is',
  'allowed but unnecessary, and the wrapper commits everything at the end.',
  '',
  'Verified entry points:',
  '  mi    = Modelio.getInstance()          # auditService, diagramService, editionService,',
  '                                         # exchangeService, imageService, logService,',
  '                                         # metamodelService, modelComponentService,',
  '                                         # modelManipulationService, modelingSession,',
  '                                         # moduleService, navigationService, patternService,',
  '                                         # pickingService, scriptService',
  '  ms    = mi.getModelingSession()        # createTransaction, getModel, getRequirementModel,',
  '                                         # findElementById, findByClass, findByAtt, ...',
  '  model = ms.getModel()                  # IUmlModel: createPackage/createClass/createUseCase/...',
  '  mi.getContext().getWorkspacePath()     # current workspace',
  '  mi.getExchangeService().exportXmiFile(...) / importXmiFile(...)   # XMI exchange',
  '',
  'Model root (verified):',
  '  model.getModelRoots()        -> [LocalModule (Infrastructure.ModuleComponent), <project> (Standard.Project)]',
  '  The Standard.Project is NOT a NameSpace, so createPackage(name, project) fails.',
  '  The project owns the root Package; reach it through the composition children:',
  '    root = [r for r in model.getModelRoots() if "Standard.Project" in str(r)][0]',
  '    rootpkg = [c for c in root.getCompositionChildren() if "Package" in str(type(c))][0]',
  '    pkg = model.createPackage("Design", rootpkg)',
  '    cls = model.createClass("Tank", pkg)',
  '    op  = model.createOperation("fill", cls)          # then set return/params as needed',
  '',
  'Notes:',
  '  - Keep the batch script ASCII-safe. Modelio decodes run.py with the system charset; this bridge',
  '    already writes ASCII-only wrappers, so put non-ASCII text in a separate user.py (execfile\'d)',
  '    or pass it through `args` (the bridge escapes it as \\uXXXX). Do not add a coding declaration',
  '    to the inline wrapper.',
  '  - Modelio needs `-workspace` to exist and `-project` to name an existing project; use `create`',
  '    of this tool for a new project.',
  '  - A malformed script usually shows up in the returned `error` field (Jython traceback), not in',
  '    stdout: batch mode swallows script print() unless it goes through the wrapper tee.',
  '  - Logs: %USERPROFILE%\\.modelio\\4.1\\modelio-*.log. API docs: D:\\modelio\\plugins\\',
  '    org.modelio.documentation.modelioapi_4.1.0.*.jar (html/ tree).',
].join('\n')

export const name = 'modelio-codesys-bridge'

export const inject = ['fs', 'subprocess', 'timer', 'tools']

export function apply(ctx, config) {

    const fs = ctx.fs
    const subprocess = ctx.subprocess
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const codesysRoot = (config && config.codesysRoot) || CODESYS_ROOT
    const modelioRoot = (config && config.modelioRoot) || MODELIO_ROOT
    const scratchOverride = config && typeof config.scratchDir === 'string' && config.scratchDir !== '' ? config.scratchDir : null
    const live = new Set()
    let installCache = null

    ctx.effect(function () {
      return function () {
        for (const h of live) {
          try { h.terminate() } catch (e) { }
        }
        live.clear()
      }
    })

    // ---- process helpers -------------------------------------------------
    function readCollected(reader) {
      if (!reader) return { text: '', lossy: false }
      try {
        const r = reader.readFrom(0)
        return { text: r.text || '', lossy: !!r.lossy }
      } catch (e) {
        return { text: '' }
      }
    }

    async function spawnWait(argv, timeoutMs, cwd) {
      const handle = subprocess.spawn({
        argv: argv,
        cwd: cwd || 'C:\\',
        graceMs: 8000,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 16 * 1024 * 1024 },
          stderr: { maxBytes: 4 * 1024 * 1024 },
        },
      })
      let timedOut = false
      let dispose = null
      try {
        dispose = ctx.timeout(function () {
          timedOut = true
          try { handle.terminate() } catch (e) { }
        }, timeoutMs)
      } catch (e) {
        dispose = null
      }
      let outcome
      try {
        outcome = await handle.done
      } finally {
        if (dispose) {
          try { dispose() } catch (e) { }
        }
      }
      return { handle: handle, outcome: outcome, timedOut: timedOut }
    }

    // Create a directory through the fs service: the atomic write already
    // mkdir -p's the parent chain, so a throwaway keep-file is the portable way
    // to materialize a directory (and it obeys the same sandbox policy).
    async function ensureDir(dir) {
      const target = await fs.resolve(dir)
      const info = await fs.stat(target)
      if (info !== undefined) {
        if (info.type !== 'directory') throw new Error('path exists but is not a directory: ' + dir)
        return
      }
      await writeText(dir + '\\.dsh-keep', '')
    }

    async function readTextOrNull(path) {
      try {
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        if (!info) return null
        return await fs.readText(target)
      } catch (e) {
        return null
      }
    }

    async function statOrNull(path) {
      try {
        const target = await fs.resolve(path)
        return await fs.stat(target)
      } catch (e) {
        return undefined
      }
    }

    async function listDirOrNull(path) {
      try {
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        if (!info) return null
        return await fs.listDir(target)
      } catch (e) {
        return null
      }
    }

    // ---- write policy ----------------------------------------------------
    // fs mutations are fenced by a per-call policy; the tool layer normally
    // resolves it from the session. This bridge resolves the same policy so its
    // scratch writes behave exactly like the agent's own file tools.
    function resolvedPolicy() {
      try {
        const agents = ctx.get('agents')
        const agent = agents ? agents.currentInitiator() : undefined
        const session = agent && agent.session ? agent.session : undefined
        const p = session ? sandboxPolicy.resolve({ session: session }) : sandboxPolicy.resolve()
        return { mode: p.mode, workspaceRoot: p.workspaceRoot }
      } catch (e) {
        return null
      }
    }

    async function writeText(path, text) {
      const target = await fs.resolve(path)
      const policy = resolvedPolicy()
      await fs.writeText(target, text, undefined, undefined, policy || undefined)
    }

    function userHome() {
      return process.env.USERPROFILE || process.env.HOME || null
    }

    async function processRunning(image) {
      try {
        const h = subprocess.spawn({
          argv: ['cmd', '/c', 'tasklist /FI "IMAGENAME eq ' + image + '" /NH'],
          cwd: 'C:\\',
          graceMs: 5000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: 'ignore' },
        })
        await h.done
        const text = readCollected(h.collected && h.collected.stdout).text
        return text.toLowerCase().indexOf(image.toLowerCase()) !== -1
      } catch (e) {
        return false
      }
    }

    // ---- detection -------------------------------------------------------
    async function detectProfile() {
      const entries = await listDirOrNull(codesysRoot + '\\CODESYS\\Profiles')
      if (!entries) return null
      for (const e of entries) {
        if (e.type === 'file' && /\.profile$/i.test(e.name)) return e.name.replace(/\.profile$/i, '')
      }
      return null
    }

    async function detectCodesysVersion() {
      const ini = await readTextOrNull(codesysRoot + '\\VersionKey.ini')
      if (!ini) return null
      const m = /^\s*Version\s*=\s*(\S+)\s*$/mi.exec(ini)
      return m ? m[1] : null
    }

    async function detectModelioVersion() {
      const entries = await listDirOrNull(modelioRoot + '\\plugins')
      if (!entries) return null
      for (const e of entries) {
        const m = /^org\.modelio\.version_(\d+\.\d+\.\d+)/.exec(e.name)
        if (m) return m[1]
      }
      return null
    }

    // Installation facts are stable within one process, so cache them; the
    // scratch root and the sandbox policy are resolved per call, because a
    // session's workspace (and therefore the writable root) can change.
    async function buildInstall() {
      const cdExe = codesysRoot + '\\CODESYS\\Common\\CODESYS.exe'
      const codesys = {
        root: codesysRoot,
        common: codesysRoot + '\\CODESYS\\Common',
        exe: cdExe,
        exists: (await statOrNull(cdExe)) !== undefined,
        profile: await detectProfile(),
        version: await detectCodesysVersion(),
        running: await processRunning('CODESYS.exe'),
      }
      const miExe = modelioRoot + '\\modelio.exe'
      const modelio = {
        root: modelioRoot,
        exe: miExe,
        exists: (await statOrNull(miExe)) !== undefined,
        version: await detectModelioVersion(),
        defaultWorkspace: userHome() ? userHome() + '\\modelio\\workspace' : null,
        running: await processRunning('modelio.exe'),
      }
      return { codesys: codesys, modelio: modelio }
    }

    async function detect(force) {
      if (installCache === null || force === true) installCache = await buildInstall()
      const home = userHome()
      const policy = resolvedPolicy()
      const base = policy && policy.mode !== 'danger-full-access' && policy.workspaceRoot ? policy.workspaceRoot : home
      return {
        home: home,
        scratch: scratchOverride || (base ? base + SCRATCH_SUFFIX : null),
        policy: policy,
        codesys: installCache.codesys,
        modelio: installCache.modelio,
      }
    }

    // ---- run plumbing ----------------------------------------------------
    function seconds(value, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || n <= 0) return fallback
      return Math.min(Math.max(n, 10), 7200)
    }

    async function makeRunDir(base, app) {
      if (!base) throw new Error('bridge scratch directory is unknown (set workDir explicitly)')
      const dir = base + '\\' + app + '\\' + stamp()
      await ensureDir(dir)
      return dir
    }

    async function stageUserScript(runDir, a) {
      if (a.scriptPath) return a.scriptPath
      if (a.script === undefined || a.script === null || String(a.script).trim() === '') {
        throw new Error('this tool needs either `script` (inline source) or `scriptPath`')
      }
      const path = runDir + '\\user.py'
      await writeText(path, String(a.script))
      return path
    }

    async function writeWrapper(runDir, app, userPath, args, save) {
      const source = WRAPPER
        .replace('@@APP@@', app)
        .replace('@@RUN@@', pyStr(runDir))
        .replace('@@USER@@', pyStr(userPath))
        .replace('@@ARGS@@', pyLiteral(args === undefined || args === null ? {} : args))
        .replace('@@SAVE@@', save ? 'True' : 'False')
      const path = runDir + '\\run.py'
      await writeText(path, source)
      return path
    }

    async function readResult(runDir) {
      const text = await readTextOrNull(runDir + '\\result.json')
      if (text === null) return null
      try {
        return JSON.parse(text)
      } catch (e) {
        return { status: 'error', error: 'result.json is not valid JSON: ' + String(e && e.message ? e.message : e), raw: trunc(text, 2000) }
      }
    }

    // Tail of the newest Modelio log, used when a batch run produces no result.
    async function modelioLogTail() {
      const home = userHome()
      if (!home) return null
      const dir = home + '\\.modelio\\4.1'
      const entries = await listDirOrNull(dir)
      if (!entries) return null
      const logs = entries.filter(function (e) { return e.type === 'file' && /^modelio-.*\.log$/.test(e.name) })
      if (logs.length === 0) return null
      logs.sort(function (a, b) { return a.name < b.name ? -1 : 1 })
      const text = await readTextOrNull(dir + '\\' + logs[logs.length - 1].name)
      if (text === null) return null
      return trunc(text.slice(-4000), 4000)
    }

    async function report(app, runDir, userPath, spawned, payload, extra) {
      const stdout = readCollected(spawned.handle.collected && spawned.handle.collected.stdout)
      const stderr = readCollected(spawned.handle.collected && spawned.handle.collected.stderr)
      const resultMissing = payload === null || payload === undefined
      // Success needs positive evidence: the wrapper wrote status=ok, it did not
      // report transaction/save failures, the process exited 0, and it was not killed.
      const ok = !resultMissing
        && payload.status === 'ok'
        && !payload.transaction_error
        && !payload.save_error
        && !spawned.timedOut
        && spawned.outcome.exitCode === 0
      const body = {
        app: app,
        ok: ok,
        resultMissing: resultMissing,
        timedOut: spawned.timedOut,
        exitCode: spawned.outcome.exitCode,
        scriptPath: userPath,
        runDir: runDir,
        status: payload ? payload.status : null,
        error: payload ? payload.error : null,
        result: payload && payload.result !== undefined ? payload.result : null,
        transaction: payload && payload.transaction ? payload.transaction : null,
        transaction_error: payload && payload.transaction_error ? trunc(payload.transaction_error, 3000) : null,
        saved: payload ? payload.saved === true : false,
        save_error: payload && payload.save_error ? trunc(payload.save_error, 3000) : null,
        output: payload ? trunc(payload.output, 8000) : '',
        stdout: trunc(stdout.text, 8000),
        stderr: trunc(stderr.text, 4000),
      }
      if (resultMissing) {
        body.hint = 'no result.json: the IDE did not reach the end of the generated wrapper. Check stdout/stderr and the '
          + 'runDir files, and verify the IDE can write outside the session workspace (a workspace-write sandbox can block '
          + 'the IDE while the launcher itself still exits 0). Manual check: run run.cmd (CODESYS) / the modelio command '
          + 'printed in the runDir by hand and inspect the IDE log.'
        if (app === 'modelio') body.modelioLogTail = await modelioLogTail()
      }
      if (extra) {
        for (const k of Object.keys(extra)) body[k] = extra[k]
      }
      return JSON.stringify(body, null, 2)
    }

    // ---- CODESYS ---------------------------------------------------------
    // CODESYS requires the literal `--profile="name"` form (quotes included) in
    // --noUI mode, which Windows argv quoting through Node rewrites. A batch
    // launcher keeps the command line byte-exact and cmd inherits our stdio.
    async function runCodesys(a) {
      const cfg = await detect(false)
      const opts = a || {}
      const runDir = await makeRunDir(opts.workDir || cfg.scratch, 'codesys')
      const userPath = await stageUserScript(runDir, opts)
      const runPy = await writeWrapper(runDir, 'codesys', userPath, opts.args, false)
      const exe = opts.executable || cfg.codesys.exe
      const profile = opts.profile || cfg.codesys.profile
      if (!profile) throw new Error('CODESYS profile was not detected; pass `profile` explicitly (see bridge_status)')
      const parts = ['"' + exe + '"', '--profile="' + profile + '"', '--runscript="' + runPy + '"']
      if (opts.noUI !== false) parts.push('--noUI')
      const cmdPath = runDir + '\\run.cmd'
      await writeText(cmdPath, '@echo off\r\n' + parts.join(' ') + '\r\n')
      const competing = await processRunning('CODESYS.exe')
      const spawned = await spawnWait(['cmd', '/c', cmdPath], seconds(opts.timeoutSec, 600) * 1000, cfg.codesys.exists ? cfg.codesys.common : 'C:\\')
      const payload = await readResult(runDir)
      return await report('codesys', runDir, userPath, spawned, payload, {
        profile: profile,
        command: parts.join(' '),
        competingInstance: competing ? 'a CODESYS instance was already running; headless script mode can conflict with it — close CODESYS and retry' : null,
      })
    }

    // ---- Modelio ---------------------------------------------------------
    async function runModelio(a) {
      const cfg = await detect(false)
      const opts = a || {}
      const workspace = opts.workspace || cfg.modelio.defaultWorkspace
      if (!workspace) throw new Error('Modelio workspace is unknown; pass `workspace` explicitly')
      await ensureDir(workspace)
      const project = opts.create || opts.project
      if (!project) throw new Error('modelio_run needs `project` (existing project in the workspace) or `create` (new project name)')
      const projectDir = workspace + '\\' + project
      const projectExists = (await statOrNull(projectDir)) !== undefined
      if (opts.create && projectExists) {
        throw new Error('Modelio project "' + project + '" already exists in ' + workspace + '; pass `project` instead of `create`')
      }
      if (!opts.create && !projectExists) {
        throw new Error('Modelio project "' + project + '" was not found in ' + workspace + '; pass `create` to create it (or fix `workspace`)')
      }
      const runDir = await makeRunDir(opts.workDir || cfg.scratch, 'modelio')
      const userPath = await stageUserScript(runDir, opts)
      const save = opts.save === false ? false : true
      const runPy = await writeWrapper(runDir, 'modelio', userPath, opts.args, save)
      const argv = [
        opts.executable || cfg.modelio.exe,
        '-workspace', workspace,
        opts.create ? '-create' : '-project', project,
        '-batch', runPy,
      ]
      const competing = await processRunning('modelio.exe')
      const spawned = await spawnWait(argv, seconds(opts.timeoutSec, 300) * 1000, cfg.modelio.exists ? cfg.modelio.root : 'C:\\')
      const payload = await readResult(runDir)
      return await report('modelio', runDir, userPath, spawned, payload, {
        workspace: workspace,
        project: project,
        created: opts.create ? project : null,
        competingInstance: competing ? 'a Modelio instance was already running; batch mode can conflict with it — close Modelio and retry' : null,
      })
    }

    // ---- GUI -------------------------------------------------------------
    async function launchGui(a) {
      const cfg = await detect(false)
      const opts = a || {}
      const app = opts.app
      let argv
      let cwd = 'C:\\'
      if (app === 'codesys') {
        const profile = opts.profile || cfg.codesys.profile
        if (!profile) throw new Error('CODESYS profile was not detected; pass `profile` explicitly')
        const dir = await makeRunDir(cfg.scratch, 'codesys-gui')
        const parts = ['"' + (opts.executable || cfg.codesys.exe) + '"', '--profile="' + profile + '"']
        if (opts.project) parts.push('"' + opts.project + '"')
        const cmdPath = dir + '\\launch.cmd'
        await writeText(cmdPath, '@echo off\r\n' + parts.join(' ') + '\r\n')
        argv = ['cmd', '/c', cmdPath]
        if (cfg.codesys.exists) cwd = cfg.codesys.common
      } else if (app === 'modelio') {
        const workspace = opts.workspace || cfg.modelio.defaultWorkspace
        await ensureDir(workspace)
        argv = [opts.executable || cfg.modelio.exe, '-workspace', workspace]
        if (opts.create) {
          argv.push('-create', opts.create)
        } else if (opts.project) {
          argv.push('-project', opts.project)
        }
        if (cfg.modelio.exists) cwd = cfg.modelio.root
      } else {
        throw new Error("bridge_launch_gui needs `app`: 'codesys' or 'modelio'")
      }
      const handle = subprocess.spawn({
        argv: argv,
        cwd: cwd,
        graceMs: 5000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      })
      // A launch that dies immediately is a failure, not a started GUI.
      let timerDispose = null
      const stillRunning = new Promise(function (resolveRace) {
        timerDispose = ctx.timeout(function () { resolveRace(null) }, 2500)
      })
      const earlyOutcome = await Promise.race([
        handle.done.then(function (o) { return o }, function () { return { exitCode: null } }),
        stillRunning,
      ])
      if (timerDispose) {
        try { timerDispose() } catch (e) { }
      }
      if (earlyOutcome !== null) {
        const earlyOut = readCollected(handle.collected && handle.collected.stdout)
        const earlyErr = readCollected(handle.collected && handle.collected.stderr)
        return JSON.stringify({
          app: app,
          started: false,
          exitCode: earlyOutcome.exitCode,
          argv: argv,
          stdout: trunc(earlyOut.text, 2000),
          stderr: trunc(earlyErr.text, 4000),
          note: 'The GUI process exited within 2.5 s; treat this as a launch failure.',
        }, null, 2)
      }
      live.add(handle)
      Promise.resolve(handle.done).then(function () { live.delete(handle) }, function () { live.delete(handle) })
      return JSON.stringify({
        app: app,
        started: true,
        argv: argv,
        note: 'The GUI is running detached; close it manually when you are done.',
      }, null, 2)
    }

    // ---- tools -----------------------------------------------------------
    // Raw ToolDefinition (JSON-Schema parameters) instead of importing
    // @deepseek-ai/dsh-tools, so this bundle is dependency-free and portable
    // across installations.
    function textTool(options) {
      const props = options.parameters || {}
      const properties = {}
      const required = []
      for (const key of Object.keys(props)) {
        const spec = props[key] || {}
        const prop = {}
        if (spec.type !== undefined && spec.type !== 'json') prop.type = spec.type
        if (spec.description !== undefined) prop.description = spec.description
        if (spec.enum !== undefined) prop.enum = spec.enum.slice()
        properties[key] = prop
        if (spec.required === true) required.push(key)
      }
      const parameters = { type: 'object', properties: properties }
      if (required.length > 0) parameters.required = required
      return {
        name: options.name,
        description: options.description,
        parameters: parameters,
        output: {
          schema: { type: 'string' },
          render: function (args, value) { return [{ type: 'text', text: String(value) }] },
        },
        execute: options.execute,
      }
    }

    ctx.tools.register(textTool({
      name: 'bridge_status',
      description: 'Detect the installed Modelio 4.1 and CODESYS 3.5: executables, CODESYS profile name and version, Modelio version, default workspaces, scratch directory, sandbox policy, and whether the IDEs are currently running. Call before the first IDE operation.',
      parameters: {
        refresh: { type: 'boolean', description: 'Re-run detection instead of returning the cached result.' },
      },
      execute: async function (a) {
        const cfg = await detect(a && a.refresh === true)
        return JSON.stringify(cfg, null, 2)
      },
    }))

    ctx.tools.register(textTool({
      name: 'codesys_run',
      description: 'Run an IronPython 2.7 script headlessly inside CODESYS 3.5 (CODESYS.exe --profile --runscript --noUI, launched through a generated run.cmd so the literal quoted profile survives). The script gets the CODESYS globals (projects, system, online, librarymanager) plus ARGS; set RESULT to return structured data; print() output is captured. Use for project create/open/save, device and POU editing, compile via login/download, simulation login/start, variable read/write, and validation. Returns a JSON report with ok, status, RESULT, stdout, stderr, exitCode and runDir.',
      parameters: {
        script: { type: 'string', description: 'Inline IronPython source (Python 2 syntax). Use instead of scriptPath.' },
        scriptPath: { type: 'string', description: 'Absolute path of an existing .py file to execute (better for long scripts and iteration).' },
        args: { type: 'json', description: 'JSON value exposed to the script as ARGS.' },
        timeoutSec: { type: 'number', description: 'Hard timeout in seconds; default 600 (CODESYS cold start takes ~60-90 s).' },
        profile: { type: 'string', description: 'Override the detected CODESYS profile name.' },
        executable: { type: 'string', description: 'Override the detected CODESYS.exe path.' },
        workDir: { type: 'string', description: 'Scratch root for this run; defaults to the configured scratch directory.' },
        noUI: { type: 'boolean', description: 'Default true; set false to keep the CODESYS window on screen.' },
      },
      execute: runCodesys,
    }))

    ctx.tools.register(textTool({
      name: 'modelio_run',
      description: 'Run a Jython 2.7 script headlessly inside Modelio 4.1 (modelio.exe -workspace -project|-create -batch). The bridge touches the model, opens one transaction, runs the script, commits it (rollback on script error) and persists the project unless save=false. The script gets Modelio, modelingSession, coreSession and ARGS; set RESULT to return data. Root packages: [c for c in project.getCompositionChildren() if "Package" in str(type(c))][0]. Use for creating/editing UML elements and diagrams, audits, XMI import/export.',
      parameters: {
        script: { type: 'string', description: 'Inline Jython source (Python 2 syntax, no inline coding declaration). Use instead of scriptPath.' },
        scriptPath: { type: 'string', description: 'Absolute path of an existing .py file to execute.' },
        project: { type: 'string', description: 'Existing project name inside the workspace to open.' },
        create: { type: 'string', description: 'Create a new project with this name in the workspace (instead of project).' },
        workspace: { type: 'string', description: 'Modelio workspace directory; defaults to %USERPROFILE%\\modelio\\workspace.' },
        args: { type: 'json', description: 'JSON value exposed to the script as ARGS.' },
        save: { type: 'boolean', description: 'Persist the model after the script (default true).' },
        timeoutSec: { type: 'number', description: 'Hard timeout in seconds; default 300.' },
        executable: { type: 'string', description: 'Override the detected modelio.exe path.' },
        workDir: { type: 'string', description: 'Scratch root for this run; defaults to the configured scratch directory.' },
      },
      execute: runModelio,
    }))

    ctx.tools.register(textTool({
      name: 'bridge_launch_gui',
      description: 'Open the Modelio or CODESYS GUI detached so a human can inspect or edit what the headless runs produced. Close the GUI manually when done.',
      parameters: {
        app: { type: 'string', enum: ['codesys', 'modelio'], description: 'Which IDE to open.' },
        project: { type: 'string', description: 'Modelio: project name to open. CODESYS: optional project path to pass to the launcher.' },
        create: { type: 'string', description: 'Modelio: create a new project with this name.' },
        workspace: { type: 'string', description: 'Modelio workspace directory.' },
        executable: { type: 'string', description: 'Override the detected executable path.' },
        profile: { type: 'string', description: 'CODESYS profile override.' },
      },
      execute: launchGui,
    }))

    ctx.tools.register(textTool({
      name: 'bridge_help',
      description: 'Cookbook for the app bridge: script contract, verified API entry points and common operations for CODESYS or Modelio. Read this before writing non-trivial scripts.',
      parameters: {
        topic: { type: 'string', enum: ['overview', 'codesys', 'modelio'], description: 'Cookbook section; default overview.' },
      },
      execute: async function (a) {
        const topic = a && a.topic ? a.topic : 'overview'
        if (topic === 'codesys') return HELP_CODESYS
        if (topic === 'modelio') return HELP_MODELIO
        return HELP_OVERVIEW
      },
    }))
  }
