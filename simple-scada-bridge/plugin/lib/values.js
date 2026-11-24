// Live variable access through the OPC UA server built into Simple-Scada 2.
//
// The Node side stays thin: scripts/ua_worker.py (asyncua) does the OPC UA
// talking and prints one JSON object, which this module parses and hands back.
// The worker lives in the plugin's own virtual environment so nothing global on
// the machine is touched.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.join(HERE, '..')
export const WORKER = path.join(PLUGIN_ROOT, 'scripts', 'ua_worker.py')
export const VENV_PYTHON = path.join(PLUGIN_ROOT, '.venv', 'Scripts', 'python.exe')

export function pythonPath() {
  if (process.env.SCADA_PYTHON) return process.env.SCADA_PYTHON
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON
  return 'python'
}

export function runWorker(args, timeoutMs) {
  const py = pythonPath()
  return new Promise(function (resolve) {
    const child = spawn(py, [WORKER].concat(args), { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(function () {
      try { child.kill() } catch (e) { }
      resolve({ ok: false, error: 'OPC UA worker timed out after ' + timeoutMs + ' ms', stdout: out, stderr: err })
    }, timeoutMs || 30000)
    child.stdout.on('data', function (d) { out += d.toString('utf8') })
    child.stderr.on('data', function (d) { err += d.toString('utf8') })
    child.on('error', function (e) {
      clearTimeout(timer)
      resolve({ ok: false, error: 'failed to start the OPC UA worker: ' + e.message + ' (python: ' + py + ')' })
    })
    child.on('close', function (code) {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop()
      if (!line) {
        resolve({ ok: false, error: 'OPC UA worker produced no JSON', exitCode: code, stderr: err.slice(-4000) })
        return
      }
      try {
        const parsed = JSON.parse(line)
        parsed.exitCode = code
        if (err.trim()) parsed.stderr = err.slice(-2000)
        resolve(parsed)
      } catch (e) {
        resolve({ ok: false, error: 'OPC UA worker returned invalid JSON: ' + e.message, raw: line.slice(0, 4000), stderr: err.slice(-2000) })
      }
    })
  })
}

export async function workerStatus() {
  return await runWorker(['status'], 30000)
}

export async function readValues(endpoint, nodes, options) {
  const o = options || {}
  const args = ['read', '--endpoint', endpoint, '--nodes', (nodes && nodes.length ? nodes.join(',') : 'all')]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  if (o.limit) args.push('--limit', String(o.limit))
  return await runWorker(args, o.timeoutMs || 45000)
}

export async function browse(endpoint, options) {
  const o = options || {}
  const args = ['browse', '--endpoint', endpoint]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  if (o.limit) args.push('--limit', String(o.limit))
  return await runWorker(args, o.timeoutMs || 60000)
}

export async function writeValues(endpoint, mapping, options) {
  const o = options || {}
  const args = ['write', '--endpoint', endpoint, '--set', JSON.stringify(mapping)]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  return await runWorker(args, o.timeoutMs || 45000)
}

export async function watchValues(endpoint, nodes, options) {
  const o = options || {}
  const seconds = o.seconds || 5
  const args = ['watch', '--endpoint', endpoint, '--nodes', (nodes && nodes.length ? nodes.join(',') : 'all'),
    '--seconds', String(seconds), '--interval', String(o.intervalMs || 250)]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  if (o.limit) args.push('--limit', String(o.limit))
  return await runWorker(args, Math.ceil(seconds * 1000) + 60000)
}

// Probe one endpoint: does it speak OPC UA? Used to discover the port of the
// project's built-in UA server without asking the user for it.
export async function probeEndpoint(endpoint, options) {
  const o = options || {}
  const args = ['probe', '--endpoint', endpoint, '--timeout', String(o.timeoutSec || 4)]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  return await runWorker(args, Math.ceil((o.timeoutSec || 4) * 1000) + 15000)
}

export async function waitForEndpoint(endpoint, seconds, options) {
  const o = options || {}
  const args = ['wait', '--endpoint', endpoint, '--seconds', String(seconds || 30)]
  if (o.user) args.push('--user', o.user)
  if (o.password) args.push('--password', o.password)
  return await runWorker(args, Math.ceil((seconds || 30) * 1000) + 15000)
}
