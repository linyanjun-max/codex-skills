import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ontology-bridge'

export const inject = ['subprocess', 'timer', 'tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ENGINE_CLI = path.join(HERE, '..', 'engine', 'cli.py')

const HELP_OVERVIEW = [
  'ontology-bridge — OWL 2 ontology toolchain for DeepSeek Harness.',
  '',
  'Pipeline: spec (JSON) -> .owl (OWL API) -> HermiT -> DL queries -> figures + Russian DOCX.',
  '',
  'Tools:',
  '  onto_status  { }                       installation report (Protégé, jpype, cache, engine)',
  '  onto_check   { spec }                  validate a spec without starting a JVM',
  '  onto_build   { spec, out, turtle? }    build the .owl file',
  '  onto_reason  { spec?, owl?, out? }     HermiT: consistency, hierarchy, inferred types, queries',
  '  onto_report  { spec, out, ... }        figures + DOCX report',
  '  onto_all     { spec, outdir }          build + reason + figures + report in one call',
  '  onto_help    { topic }                 this text / spec format / workflow',
  '',
  'The engine is Python 3 (jpype1, matplotlib, python-docx, networkx) driving the Protégé-bundled',
  'JVM. No javac and no internet are required: every jar ships with Protégé.',
].join('\n')

const HELP_SPEC = [
  'Spec file: one JSON object. Only "classes" is strictly required, but the lab needs more.',
  '',
  '{',
  '  "iri": "http://www.semanticweb.org/spbpu/tii/lab4/equipment-maintenance",',
  '  "label": "Ontology title",',
  '  "language": "ru",',
  '  "classes": [',
  '    {"name": "Equipment", "parent": "Thing", "comment": "Оборудование"},',
  '    {"name": "Pump", "parent": "Equipment", "comment": "Насосный агрегат"}',
  '  ],',
  '  "disjointGroups": [["Equipment", "Failure", "Worker"]],',
  '  "objectProperties": [',
  '    {"name": "hasFailure", "domain": "Equipment", "range": "Failure",',
  '     "inverse": "isFailureOf", "comment": "Оборудование имеет отказ"}',
  '  ],',
  '  "dataProperties": [',
  '    {"name": "hasSerialNumber", "domain": "Equipment", "range": "string", "functional": true}',
  '  ],',
  '  "classAxioms": [',
  '    {"subject": "EquipmentWithFailure", "kind": "equivalentTo",',
  '     "expression": "Equipment and hasFailure some Failure"},',
  '    {"subject": "MaintenanceAction", "kind": "subClassOf", "expression": "resolves some Failure"}',
  '  ],',
  '  "individuals": [',
  '    {"name": "Pump_101", "types": ["Pump"],',
  '     "objectAssertions": [{"property": "hasFailure", "target": "Failure_Overheat_1"}],',
  '     "dataAssertions": [{"property": "hasSerialNumber", "value": "P-101-2023"}]}',
  '  ],',
  '  "queries": [',
  '    {"name": "Q1", "expression": "Equipment and hasFailure some Overheating", "ask": "individuals"}',
  '  ]',
  '}',
  '',
  'Rules the engine enforces:',
  '  - names must be unique and references (parent/domain/range/types/targets) must resolve;',
  '  - object property characteristics: functional, inverseFunctional, transitive, symmetric,',
  '    asymmetric, reflexive, irreflexive;',
  '  - data property ranges: string, integer, int, float, double, decimal, boolean, date, dateTime, anyURI;',
  '    a literal is always typed from the declared range, so xsd:float vs xsd:double never conflicts;',
  '  - "expression" strings use Manchester syntax: "A and B", "A or B", "not A",',
  '    "prop some Class", "prop only Class", "prop value Individual".',
].join('\n')

const HELP_WORKFLOW = [
  'Recommended order for a lab run:',
  '',
  '1. onto_status        — confirm Protégé home, jpype, HermiT jar and the cache directory.',
  '2. onto_check         — validate the spec; fix every reported error before continuing.',
  '3. onto_build         — write ontology.owl; open it once in Protégé to confirm it loads.',
  '4. onto_reason        — HermiT consistency + inferred hierarchy + inferred individual types;',
  '                        the "queries" array holds the answers to the DL queries.',
  '5. onto_report        — figures + DOCX; the cover reuses a previously submitted report.',
  '',
  'Screenshots: reasoner output and DL queries are produced headlessly, so the numbers here are the',
  'authoritative ones. If the report needs Protégé UI screenshots, open the generated .owl in Protégé',
  '(Reasoner -> HermiT, then the DL Query tab) and capture them separately.',
].join('\n')

export function apply(ctx, config) {
  const subprocess = ctx.subprocess
  const settings = config || {}
  const engineCli = typeof settings.engineCli === 'string' && settings.engineCli
    ? settings.engineCli
    : DEFAULT_ENGINE_CLI
  const pythonOverride = typeof settings.pythonExe === 'string' && settings.pythonExe
    ? settings.pythonExe
    : null
  const protegeHome = typeof settings.protegeHome === 'string' && settings.protegeHome
    ? settings.protegeHome
    : null

  let pythonPromise = null

  function readCollected(reader) {
    if (!reader) return { text: '', lossy: false }
    try {
      const result = reader.readFrom(0)
      return { text: result.text || '', lossy: !!result.lossy }
    } catch (e) {
      return { text: '' }
    }
  }

  async function spawnWait(argv, timeoutMs, cwd) {
    const handle = subprocess.spawn({
      argv: argv,
      cwd: cwd || path.dirname(engineCli),
      graceMs: 5000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 2 * 1024 * 1024 },
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
    return {
      outcome: outcome,
      timedOut: timedOut,
      stdout: readCollected(handle.stdout).text,
      stderr: readCollected(handle.stderr).text,
    }
  }

  async function probePython(candidate) {
    try {
      const result = await spawnWait(
        [candidate, '-X', 'utf8', '-c', 'import sys;print(sys.version_info[0])'],
        20000,
        undefined,
      )
      const major = parseInt(result.stdout.trim(), 10)
      return result.outcome && result.outcome.exitCode === 0 && major >= 3
    } catch (e) {
      return false
    }
  }

  async function resolvePython() {
    if (pythonPromise) return pythonPromise
    pythonPromise = (async function () {
      const candidates = []
      if (pythonOverride) candidates.push(pythonOverride)
      candidates.push('python', 'python3')
      if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'))
      }
      candidates.push('D:\\anaconda\\python.exe', 'C:\\Python312\\python.exe')
      for (const candidate of candidates) {
        if (await probePython(candidate)) return candidate
      }
      throw new Error(
        'Python 3 not found. Install Python 3 (jpype1, matplotlib, python-docx, networkx) or set',
      )
    })()
    return pythonPromise
  }

  function parseEngineJson(text) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch (e) {
      return null
    }
  }

  async function runEngine(args, timeoutMs) {
    let python
    try {
      python = await resolvePython()
    } catch (error) {
      return { ok: false, error: String(error.message || error) }
    }
    const argv = [python, '-X', 'utf8', engineCli].concat(args)
    if (protegeHome) argv.push('--protege', protegeHome)
    const result = await spawnWait(argv, timeoutMs, path.dirname(engineCli))
    const parsed = parseEngineJson(result.stdout)
    if (parsed) {
      if (result.timedOut) {
        parsed.ok = false
        parsed.error = parsed.error || 'engine timed out after ' + timeoutMs + ' ms'
      }
      parsed.engine = { python: python, cli: engineCli }
      return parsed
    }
    return {
      ok: false,
      error: result.timedOut
        ? 'engine timed out after ' + timeoutMs + ' ms'
        : 'engine produced no JSON (exit code ' + (result.outcome ? result.outcome.exitCode : '?') + ')',
      exitCode: result.outcome ? result.outcome.exitCode : null,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
      engine: { python: python, cli: engineCli },
    }
  }

  // ---- tools -----------------------------------------------------------
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

  function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(label + ' is required')
    }
    return value
  }

  ctx.tools.register(textTool({
    name: 'onto_status',
    description: 'Report the ontology toolchain readiness: Protégé installation (home, bundled JVM, HermiT jar), jpype version, jar cache directory, engine path and detected Python. Call this before the first ontology operation.',
    parameters: {},
    execute: async function () {
      const result = await runEngine(['status'], 180000)
      result.engineCli = engineCli
      result.pythonOverride = pythonOverride
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_check',
    description: 'Validate an ontology spec (JSON) without starting a JVM: uniqueness, resolved parent/domain/range/type references, cycles, data ranges, Manchester expressions syntax level. Returns counts plus the assignment minima warnings (10-15 classes, 5-7 object properties, 3-5 data properties, 8-12 individuals, >=3 DL queries).',
    parameters: {
      spec: { type: 'string', required: true, description: 'Absolute path to the spec JSON file.' },
    },
    execute: async function (a) {
      const result = await runEngine(['check', '--spec', requireString(a && a.spec, 'spec')], 120000)
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_build',
    description: 'Build an OWL 2 ontology from a spec through the OWL API and save it as RDF/XML (.owl). The file is written by the OWL API, so Protégé opens it without normalisation warnings. Returns axiom count, byte size, IRI and the spec counts.',
    parameters: {
      spec: { type: 'string', required: true, description: 'Absolute path to the spec JSON file.' },
      out: { type: 'string', required: true, description: 'Absolute path of the .owl file to write.' },
      turtle: { type: 'boolean', description: 'Also write a Turtle (.ttl) copy next to the .owl file.' },
    },
    execute: async function (a) {
      const args = ['build', '--spec', requireString(a && a.spec, 'spec'), '--out', requireString(a && a.out, 'out')]
      if (a && a.turtle === true) args.push('--turtle')
      const result = await runEngine(args, 300000)
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_reason',
    description: 'Run the Protégé-bundled HermiT headlessly: consistency, unsatisfiable classes, inferred class hierarchy (tree + flat), inferred types of every individual, and the answers to the spec DL queries. Pass spec (builds in memory) or owl (loads an existing file); pass both to get the queries from the spec while reasoning over the file.',
    parameters: {
      spec: { type: 'string', description: 'Absolute path to the spec JSON (also supplies the DL queries).' },
      owl: { type: 'string', description: 'Absolute path to an existing .owl file to reason over.' },
      out: { type: 'string', description: 'When only spec is given, save the built ontology here before reasoning.' },
      saveJson: { type: 'string', description: 'Write the full reasoning report to this JSON path.' },
    },
    execute: async function (a) {
      const args = ['reason']
      const spec = a && a.spec
      const owl = a && a.owl
      if (!spec && !owl) throw new Error('pass spec and/or owl')
      if (spec) args.push('--spec', spec)
      if (owl) args.push('--owl', owl)
      if (a && a.out) args.push('--out', a.out)
      if (a && a.saveJson) args.push('--save-json', a.saveJson)
      const result = await runEngine(args, 300000)
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_report',
    description: 'Build the ontology, reason over it, draw three figures (inferred class hierarchy, concept map, ABox individual graph) and write a Russian DOCX lab report with 8 sections and tables. The cover page of a previously submitted report is reused, so fonts and layout match the department template.',
    parameters: {
      spec: { type: 'string', required: true, description: 'Absolute path to the spec JSON file.' },
      out: { type: 'string', required: true, description: 'Absolute path of the .docx to write.' },
      owl: { type: 'string', description: 'Where to save the .owl (defaults to <out>.owl).' },
      figures: { type: 'string', description: 'Directory for the generated PNG figures.' },
      template: { type: 'string', description: 'Previously submitted .docx used as the cover/style donor.' },
    },
    execute: async function (a) {
      const args = ['report', '--spec', requireString(a && a.spec, 'spec'), '--out', requireString(a && a.out, 'out')]
      if (a && a.owl) args.push('--owl', a.owl)
      if (a && a.figures) args.push('--figures', a.figures)
      if (a && a.template) args.push('--template', a.template)
      const result = await runEngine(args, 600000)
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_all',
    description: 'One-shot pipeline into a directory: ontology.owl, reasoning.json, figures/ and report.docx. Fails with ok=false when HermiT finds the ontology inconsistent, so a broken model never silently ships a report.',
    parameters: {
      spec: { type: 'string', required: true, description: 'Absolute path to the spec JSON file.' },
      outdir: { type: 'string', required: true, description: 'Output directory (created if missing).' },
      template: { type: 'string', description: 'Cover/style donor .docx.' },
      skipReport: { type: 'boolean', description: 'Skip the DOCX and produce only the ontology, reasoning and figures.' },
    },
    execute: async function (a) {
      const args = ['all', '--spec', requireString(a && a.spec, 'spec'), '--outdir', requireString(a && a.outdir, 'outdir')]
      if (a && a.template) args.push('--template', a.template)
      if (a && a.skipReport === true) args.push('--skip-report')
      const result = await runEngine(args, 900000)
      return JSON.stringify(result, null, 2)
    },
  }))

  ctx.tools.register(textTool({
    name: 'onto_help',
    description: 'Cookbook for the ontology bridge: tool pipeline, spec format with every field, Manchester expression syntax and the Protégé screenshot caveat. Read before authoring a non-trivial spec.',
    parameters: {
      topic: { type: 'string', enum: ['overview', 'spec', 'workflow'], description: 'Cookbook section; default overview.' },
    },
    execute: async function (a) {
      const topic = a && a.topic ? a.topic : 'overview'
      if (topic === 'spec') return HELP_SPEC
      if (topic === 'workflow') return HELP_WORKFLOW
      return HELP_OVERVIEW
    },
  }))
}
