// Standalone self-check: loads the plugin with a minimal fake Cordis context and
// exercises the tools without DSH running.
//
//   node scripts/selfcheck.mjs                 # registration + status + spec check
//   node scripts/selfcheck.mjs --full          # also build + reason over a fixture
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = await import(new URL('../lib/index.js', import.meta.url).href)

function fakeSubprocess() {
  return {
    spawn(options) {
      const child = spawn(options.argv[0], options.argv.slice(1), {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const done = new Promise((resolve) => {
        child.on('close', (code) => resolve({ exitCode: code === null ? -1 : code }))
        child.on('error', () => resolve({ exitCode: -1 }))
      })
      return {
        done,
        stdout: { readFrom() { return { text: stdout, lossy: false } } },
        stderr: { readFrom() { return { text: stderr, lossy: false } } },
        terminate() { try { child.kill() } catch (e) { } },
      }
    },
  }
}

const registered = new Map()
const ctx = {
  subprocess: fakeSubprocess(),
  timeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
  tools: { register(tool) { registered.set(tool.name, tool) } },
  get() { return undefined },
  effect() { },
}

const problems = []

function check(condition, message) {
  if (condition) {
    console.log('  ok   ' + message)
  } else {
    problems.push(message)
    console.log('  FAIL ' + message)
  }
}

console.log('plugin name:', PLUGIN.name)
console.log('inject     :', JSON.stringify(PLUGIN.inject))

PLUGIN.apply(ctx, {})

console.log('\nregistered tools (' + registered.size + '):')
for (const toolName of registered.keys()) console.log('  - ' + toolName)

check(registered.size === 7, 'seven tools registered')
for (const expected of ['onto_status', 'onto_check', 'onto_build', 'onto_reason', 'onto_report', 'onto_all', 'onto_help']) {
  check(registered.has(expected), 'tool ' + expected + ' present')
}

const status = JSON.parse(await registered.get('onto_status').execute({}))
console.log('\nstatus.ok        :', status.ok)
console.log('status.protege   :', status.protegeHome)
console.log('status.hermit    :', status.hermitVersion)
console.log('status.jpype     :', status.jpypeVersion)
check(status.ok === true, 'toolchain ready (Protégé + jpype found)')

const helpText = await registered.get('onto_help').execute({ topic: 'spec' })
check(helpText.includes('disjointGroups'), 'help/spec documents the spec format')

const full = process.argv.includes('--full')
if (full) {
  const fixture = process.argv.find((arg) => arg.endsWith('.json'))
    || path.join(HERE, '..', '..', '_dev', 'test_spec.json')
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-selfcheck-'))
  const checkResult = JSON.parse(await registered.get('onto_check').execute({ spec: fixture }))
  console.log('\ncheck.ok         :', checkResult.ok, '| classes:', checkResult.counts && checkResult.counts.classes)
  check(checkResult.ok === true, 'fixture spec validates')

  const all = JSON.parse(await registered.get('onto_all').execute({ spec: fixture, outdir: workdir }))
  console.log('all.ok           :', all.ok)
  console.log('all.consistent   :', all.consistent)
  console.log('all.owl          :', all.owl)
  console.log('all.queries      :', JSON.stringify(all.queries))
  check(all.ok === true, 'build + reason pipeline succeeded on the fixture')
  check(fs.existsSync(path.join(workdir, 'ontology.owl')), 'ontology.owl written')
  check(fs.existsSync(path.join(workdir, 'report.docx')), 'report.docx written')
  console.log('workdir          :', workdir)
}

console.log('\n' + (problems.length === 0 ? 'SELFCHECK PASSED' : 'SELFCHECK FAILED: ' + problems.length + ' problem(s)'))
process.exit(problems.length === 0 ? 0 : 1)

