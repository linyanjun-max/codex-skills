// Standalone self-check for dsh-tool-app-bridge.
//
// Boots the plugin module outside DeepSeek Harness against a minimal fake
// Cordis context whose `fs` / `subprocess` / `timer` adapters follow the same
// contracts as the real host services, then exercises the registered tools:
//
//   node scripts/selfcheck.mjs              # registration + status + both IDEs
//   SELFCHECK_SKIP_IDE=1 node ...           # registration + status only
//
// The IDE runs need working CODESYS / Modelio installations and take ~1-2 min.
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const entry = join(pkgRoot, 'lib', 'index.js')

const workRoot = process.env.SELFCHECK_DIR || join(tmpdir(), 'dsh-tool-app-bridge-selfcheck')
const scratch = join(workRoot, 'scratch')
const workspace = join(workRoot, 'ws')

const fsAdapter = {
  async resolve(path) {
    const displayPath = resolve(path)
    return { displayPath, targetKey: displayPath }
  },
  async stat(target) {
    try {
      const s = await stat(target.displayPath)
      return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, version: String(s.mtimeMs) }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return readFile(target.displayPath, 'utf8')
  },
  async writeText(target, content) {
    await mkdir(dirname(target.displayPath), { recursive: true })
    await writeFile(target.displayPath, content, 'utf8')
    return { operation: 'update', after: content }
  },
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
      target: { displayPath: join(target.displayPath, e.name), targetKey: join(target.displayPath, e.name) },
    }))
  },
}

const subprocessAdapter = {
  spawn(spec) {
    const chunks = { out: '', err: '' }
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (d) => { chunks.out += d.toString('utf8') })
    child.stderr.on('data', (d) => { chunks.err += d.toString('utf8') })
    const done = new Promise((resolveDone) => {
      child.on('error', () => resolveDone({ exitCode: null, signal: null }))
      child.on('close', (code) => resolveDone({ exitCode: code, signal: null }))
    })
    const reader = (key) => ({
      readFrom() {
        const text = chunks[key]
        return { text, nextOffset: text.length, lossy: false }
      },
    })
    return {
      collected: { stdout: reader('out'), stderr: reader('err') },
      done,
      terminate() {
        try { child.kill() } catch { /* already gone */ }
      },
    }
  },
}

const timerAdapter = {
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    return () => clearTimeout(handle)
  },
}

const tools = []
const ctx = {
  fs: fsAdapter,
  subprocess: subprocessAdapter,
  timeout: (callback, delay) => timerAdapter.timeout(callback, delay),
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get(name) {
    if (name === 'sandboxPolicy') {
      return {
        resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workRoot }),
      }
    }
    return undefined
  },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => {}
    },
  },
}

const mod = await import(pathToFileURL(entry).href)
if (typeof mod.apply !== 'function') throw new Error('module does not export apply()')
mod.apply(ctx, { scratchDir: scratch })

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const expected = ['bridge_status', 'codesys_run', 'modelio_run', 'bridge_launch_gui', 'bridge_help']
const missing = expected.filter((name) => !byName[name])
if (missing.length > 0) throw new Error('missing tools: ' + missing.join(', '))
console.log('registered tools:', Object.keys(byName).join(', '))

const status = JSON.parse(await byName.bridge_status.execute({}))
console.log('bridge_status:', JSON.stringify({
  codesys: { exists: status.codesys.exists, version: status.codesys.version, profile: status.codesys.profile },
  modelio: { exists: status.modelio.exists, version: status.modelio.version },
  scratch: status.scratch,
  policy: status.policy,
}))

let failures = 0
const skipIde = process.env.SELFCHECK_SKIP_IDE === '1'

// --- strict success semantics -------------------------------------------------
// A launcher that exits 0 without producing result.json must NOT be reported as
// success, and a GUI process that dies immediately must NOT be "started".
const fakePath = join(workRoot, 'fake-ide.cmd')
await mkdir(workRoot, { recursive: true })
await writeFile(fakePath, '@exit /b 0\r\n', 'utf8')

const missingResultReport = JSON.parse(await byName.codesys_run.execute({ script: 'print "never runs"', executable: fakePath }))
console.log('strict-ok (no result, exit 0):', JSON.stringify({ ok: missingResultReport.ok, resultMissing: missingResultReport.resultMissing, exitCode: missingResultReport.exitCode }))
if (missingResultReport.ok !== false || missingResultReport.resultMissing !== true) {
  failures++
  console.error('strict-ok failed: an exit-0 launcher without result.json was reported as success')
}

const fakeGuiExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
const fakeGui = JSON.parse(await byName.bridge_launch_gui.execute({ app: 'modelio', executable: fakeGuiExe }))
console.log('gui-early-exit:', JSON.stringify({ started: fakeGui.started, exitCode: fakeGui.exitCode }))
if (fakeGui.started !== false) {
  failures++
  console.error('gui-early-exit failed: a GUI that exited within the grace window was reported as started')
}

if (!skipIde) {
  const codesysReport = JSON.parse(await byName.codesys_run.execute({
    script: '# -*- coding: utf-8 -*-\nprint "selfcheck codesys"\nRESULT = {"exe": str(system.executable_filename)}\n',
    timeoutSec: 300,
  }))
  console.log('codesys_run:', JSON.stringify({ ok: codesysReport.ok, status: codesysReport.status, result: codesysReport.result, output: codesysReport.output }))
  if (!codesysReport.ok) {
    failures++
    console.error('codesys_run failed:', codesysReport.error || codesysReport.stderr)
  }

  const modelioScript = [
    'from org.modelio.api.modelio import Modelio',
    'mi = Modelio.getInstance()',
    'ms = mi.getModelingSession()',
    'model = ms.getModel()',
    'root = [r for r in model.getModelRoots() if "Standard.Project" in str(r)][0]',
    'rootpkg = [c for c in root.getCompositionChildren() if "Package" in str(type(c))][0]',
    'pkg = model.createPackage("SelfCheckPkg", rootpkg)',
    'RESULT = {"pkg": str(pkg)}',
  ].join('\n')

  const projectExists = existsSync(join(workspace, 'SelfCheckBridge'))
  const modelioReport = JSON.parse(await byName.modelio_run.execute(
    projectExists
      ? { project: 'SelfCheckBridge', workspace, script: modelioScript, timeoutSec: 240 }
      : { create: 'SelfCheckBridge', workspace, script: modelioScript, timeoutSec: 240 },
  ))
  console.log('modelio_run:', JSON.stringify({
    ok: modelioReport.ok,
    status: modelioReport.status,
    transaction: modelioReport.transaction,
    saved: modelioReport.saved,
    result: modelioReport.result,
  }))
  if (!modelioReport.ok) {
    failures++
    console.error('modelio_run failed:', modelioReport.error || modelioReport.stderr)
  }

  // A failing script must roll back and must not save; the element it created
  // must not exist on disk afterwards.
  const failingScript = [
    'from org.modelio.api.modelio import Modelio',
    'mi = Modelio.getInstance()',
    'ms = mi.getModelingSession()',
    'model = ms.getModel()',
    'root = [r for r in model.getModelRoots() if "Standard.Project" in str(r)][0]',
    'rootpkg = [c for c in root.getCompositionChildren() if "Package" in str(type(c))][0]',
    'pkg = model.createPackage("ShouldRollbackPkg", rootpkg)',
    'RESULT = {"pkg": str(pkg)}',
    'raise RuntimeError("selfcheck rollback probe")',
  ].join('\n')
  const rollbackReport = JSON.parse(await byName.modelio_run.execute({
    project: 'SelfCheckBridge',
    workspace,
    script: failingScript,
    timeoutSec: 240,
  }))
  console.log('modelio rollback:', JSON.stringify({
    ok: rollbackReport.ok,
    status: rollbackReport.status,
    transaction: rollbackReport.transaction,
    saved: rollbackReport.saved,
  }))
  if (rollbackReport.ok !== false || rollbackReport.transaction !== 'rolled-back' || rollbackReport.saved !== false) {
    failures++
    console.error('rollback failed: a failing script was not rolled back / saved')
  }

  const listScript = [
    'from org.modelio.api.modelio import Modelio',
    'mi = Modelio.getInstance()',
    'ms = mi.getModelingSession()',
    'model = ms.getModel()',
    'root = [r for r in model.getModelRoots() if "Standard.Project" in str(r)][0]',
    'rootpkg = [c for c in root.getCompositionChildren() if "Package" in str(type(c))][0]',
    'RESULT = {"children": [str(c) for c in rootpkg.getCompositionChildren()]}',
  ].join('\n')
  const listReport = JSON.parse(await byName.modelio_run.execute({
    project: 'SelfCheckBridge',
    workspace,
    script: listScript,
    save: false,
    timeoutSec: 240,
  }))
  const children = (listReport.result && listReport.result.children) || []
  const leaked = children.filter((c) => c.indexOf('ShouldRollbackPkg') !== -1)
  console.log('rollback persistence:', JSON.stringify({ ok: listReport.ok, leakedFromFailedRun: leaked.length }))
  if (!listReport.ok || leaked.length !== 0) {
    failures++
    console.error('rollback persistence failed: the failed run left ' + leaked.length + ' package(s) on disk')
  }
}

if (failures > 0) {
  console.error('selfcheck FAILED (' + failures + ' run(s))')
  process.exit(1)
}
console.log('selfcheck OK')
