// Standalone self-check: loads the plugin with a minimal fake ctx (no DSH
// process needed), registers the tools, and exercises the read-only paths
// against the Simple-Scada installation on this machine.
//
//   node scripts/selfcheck.mjs
//   SELFCHECK_PROJECT=project_SwimmingPool node scripts/selfcheck.mjs
//   SELFCHECK_SKIP_RUNTIME=1 node scripts/selfcheck.mjs   (server not running)

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'lib', 'index.js')

const registered = new Map()
const ctx = {
  tools: {
    register: function (tool) {
      if (!tool || !tool.name) throw new Error('tool without a name')
      if (registered.has(tool.name)) throw new Error('duplicate tool: ' + tool.name)
      if (typeof tool.execute !== 'function') throw new Error('tool without execute: ' + tool.name)
      registered.set(tool.name, tool)
    },
  },
}

const mod = await import('file:///' + ENTRY.replace(/\\/g, '/'))
mod.apply(ctx, {})

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function (value) {
      results.push({ name: name, ok: true, detail: value })
    })
    .catch(function (err) {
      results.push({ name: name, ok: false, detail: err && err.message ? err.message : String(err) })
    })
}

async function run(name, args) {
  const tool = registered.get(name)
  if (!tool) throw new Error('tool not registered: ' + name)
  const text = await tool.execute(args || {})
  return typeof text === 'string' ? text : JSON.stringify(text)
}

const project = process.env.SELFCHECK_PROJECT || 'project_SwimmingPool'

await check('registration', async function () {
  const expected = ['scada_status', 'scada_projects', 'scada_read', 'scada_edit', 'scada_validate', 'scada_compile', 'scada_run', 'scada_journal', 'scada_values', 'scada_help']
  const missing = expected.filter(function (n) { return !registered.has(n) })
  if (missing.length) throw new Error('missing tools: ' + missing.join(', '))
  for (const [name, tool] of registered) {
    if (!tool.description || tool.description.length < 20) throw new Error('tool without a useful description: ' + name)
    if (tool.parameters && typeof tool.parameters !== 'object') throw new Error('bad parameters for ' + name)
  }
  return registered.size + ' tools'
})

// The host turns `tool.parameters` into the function schema sent to the model,
// so it must already BE a JSON Schema object: { type: "object", properties, required }.
// A flat parameter map (e.g. { pattern: { type: "string" } }) puts keyword-looking
// keys at the schema root and the provider rejects every request
// ("Invalid schema for function ... is not of type string"). This check compiles
// every schema with the same ajv the harness bundles.
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

let ajvCompile = null
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const dshHome = process.env.DSH_HOME
  const candidates = []
  if (dshHome) candidates.push(dshHome + '/profiles/node_modules/ajv/dist/ajv.js')
  let ajv = null
  for (const c of candidates) {
    try { ajv = require(c) } catch (e) { ajv = null }
    if (ajv) break
  }
  if (ajv) {
    const instance = new (ajv.default || ajv)({ strict: false, allErrors: true })
    ajvCompile = (schema) => instance.compile(schema)
  }
} catch (e) {
  ajvCompile = null
}

await check('parameter schemas are harness-safe', async function () {
  const problems = []
  for (const [name, tool] of registered) {
    const params = tool.parameters
    if (!params || typeof params !== 'object') {
      problems.push(name + ': parameters must be an object')
      continue
    }
    const keys = Object.keys(params)
    for (const key of keys) {
      if (['type', 'properties', 'required', 'additionalProperties'].indexOf(key) < 0) {
        problems.push(name + ': unexpected top-level schema key "' + key + '" (parameters must be a JSON Schema object)')
      }
    }
    if (params.type !== 'object') problems.push(name + ': parameters.type must be "object"')
    if (!params.properties || typeof params.properties !== 'object') {
      problems.push(name + ': parameters.properties is missing')
      continue
    }
    const declared = new Set(Object.keys(params.properties))
    for (const [prop, spec] of Object.entries(params.properties)) {
      if (!spec || typeof spec !== 'object') problems.push(name + '.' + prop + ': property schema must be an object')
      else if (spec.type && !ALLOWED_TYPES.has(String(spec.type))) problems.push(name + '.' + prop + ': unsupported type ' + JSON.stringify(spec.type))
      else if (!spec.type) problems.push(name + '.' + prop + ': property schema has no type')
    }
    for (const r of params.required || []) {
      if (!declared.has(r)) problems.push(name + ': required lists unknown property "' + r + '"')
    }
    if (ajvCompile) {
      try {
        ajvCompile(params)
      } catch (e) {
        problems.push(name + ': JSON Schema does not compile: ' + e.message)
      }
    }
  }
  if (problems.length) throw new Error(problems.join('; '))
  return registered.size + ' schemas' + (ajvCompile ? ' compiled with ajv' : ' checked structurally (ajv not found)')
})

await check('scada_status', async function () {
  const out = JSON.parse(await run('scada_status'))
  if (!out.installDir) throw new Error('installDir not detected')
  if (!out.projectsDir) throw new Error('projectsDir not detected')
  return 'install=' + out.installDir + ' projects=' + out.projectCount + ' uaWorker=' + (out.opcUaWorker && out.opcUaWorker.ok)
})

await check('scada_projects', async function () {
  const out = JSON.parse(await run('scada_projects'))
  if (!out.count) throw new Error('no projects listed')
  return out.count + ' project(s), admin=' + out.adminReachable
})

await check('scada_read summary+scripts', async function () {
  const out = JSON.parse(await run('scada_read', { project: project, what: 'all' }))
  if (!out.summary) throw new Error('no summary')
  if (!out.variables || !out.variables.count) throw new Error('no variables decoded')
  if (!out.scripts || !out.scripts.count) throw new Error('no scripts decoded')
  const first = out.scripts.items[0]
  if (!first || typeof first.source !== 'string') throw new Error('script source missing')
  return 'vars=' + out.variables.count + ' scripts=' + out.scripts.count + ' pages=' + (out.pages ? out.pages.count : 0)
})

await check('scada_validate', async function () {
  const out = JSON.parse(await run('scada_validate', { project: project }))
  if (!out.verdict) throw new Error('no verdict')
  return out.verdict + ' errors=' + out.errors.length + ' warnings=' + out.warnings.length
})

await check('scada_help', async function () {
  const text = await run('scada_help', { topic: 'editing' })
  if (text.indexOf('scripts') < 0) throw new Error('help text looks wrong')
  return text.split('\n').length + ' lines'
})

if (!process.env.SELFCHECK_SKIP_RUNTIME) {
  await check('scada_run status', async function () {
    const out = JSON.parse(await run('scada_run', { project: project, action: 'status' }))
    if (!out.server) throw new Error('no server answer')
    return 'state=' + (out.server.project ? out.server.project.stateName : 'not listed')
  })
}

const failed = results.filter(function (r) { return !r.ok })
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + ' -> ' + r.detail)
console.log('')
console.log(failed.length ? 'SELFCHECK FAILED (' + failed.length + ')' : 'SELFCHECK OK (' + results.length + ' checks)')
process.exit(failed.length ? 1 : 0)
