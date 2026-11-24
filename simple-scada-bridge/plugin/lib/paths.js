// Discovery of the local Simple-Scada 2 installation, data directories,
// running processes and listening ports.
//
// Verified on this machine:
//   HKLM\SOFTWARE\WOW6432Node\Simple-Scada
//     Language       = english
//     DataPathDemo64 = D:\simpleScada\document\Simple-Scada 2 (demo64)
//   HKCU\Software\Simple-Scada
//     Types      = full
//     Components = base,server,client
// The data directory holds Projects\, Logs\, Pictures\, Sounds\, Import\.
// A licensed install uses "DataPath" instead of "DataPathDemo64".

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const pexec = promisify(execFile)

export const EXE_NAMES = {
  server: 'Server.exe',
  client: 'Client.exe',
  editor: 'Editor.exe',
  options: 'Options.exe',
  pictures: 'Pictures.exe',
  reports: 'Reports.exe',
  monitor: 'sscmonitor.exe',
}

export const DEFAULT_ADMIN_PORT = 8758
export const DEFAULT_CLIENT_PORT = 8750
export const DEFAULT_WEB_PORT = 8755

async function regQuery(key) {
  try {
    const { stdout } = await pexec('reg', ['query', key], { windowsHide: true, timeout: 15000 })
    const out = {}
    for (const raw of String(stdout).split(/\r?\n/)) {
      const line = raw.trim()
      const m = /^(\S(?:.*?\S)?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line)
      if (m) out[m[1]] = m[3].trim()
    }
    return out
  } catch (e) {
    return null
  }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch (e) { return false }
}

async function taskList() {
  try {
    const { stdout } = await pexec('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 20000 })
    const rows = []
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.trim()) continue
      const cols = line.split('","').map(function (s) { return s.replace(/^"|"$/g, '') })
      if (cols.length < 5) continue
      rows.push({ image: cols[0], pid: Number(cols[1]), session: cols[2], mem: cols[4] })
    }
    return rows
  } catch (e) {
    return []
  }
}

async function netstat() {
  try {
    const { stdout } = await pexec('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 20000 })
    const rows = []
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
      if (!m) continue
      rows.push({
        localAddr: m[1], localPort: Number(m[2]),
        remoteAddr: m[3], remotePort: Number(m[4]),
        state: m[5], pid: Number(m[6]),
      })
    }
    return rows
  } catch (e) {
    return []
  }
}

// Find the install directory: the folder that contains Server.exe + Editor.exe.
export async function detectInstallDir(reg) {
  const candidates = []
  if (reg && reg.install) candidates.push(reg.install)
  const roots = [
    'C:\\Program Files (x86)',
    'C:\\Program Files',
    'C:\\Simple-Scada 2',
    'D:\\Simple-Scada 2',
    'D:\\simpleScada',
    'D:\\Program Files',
  ]
  for (const r of roots) {
    if (!isDir(r)) continue
    // A root may itself be the app folder or contain one.
    candidates.push(r)
    let entries = []
    try { entries = readdirSync(r, { withFileTypes: true }) } catch (e) { entries = [] }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (/simple-?scada/i.test(e.name) || /^Simple-Scada/i.test(e.name)) candidates.push(path.join(r, e.name))
    }
  }
  for (const c of candidates) {
    if (existsSync(path.join(c, EXE_NAMES.server)) && existsSync(path.join(c, EXE_NAMES.editor))) return c
  }
  return null
}

export async function status() {
  const hklm = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Simple-Scada')
  const hklm64 = await regQuery('HKLM\\SOFTWARE\\Simple-Scada')
  const hkcu = await regQuery('HKCU\\Software\\Simple-Scada')
  const reg = Object.assign({}, hklm64 || {}, hklm || {})
  const dataDir = reg.DataPathDemo64 || reg.DataPath || null
  const installDir = await detectInstallDir({ install: reg.InstallPath || reg.AppPath })
  const effectiveDataDir = dataDir || (installDir ? path.join(path.dirname(installDir), 'document', path.basename(installDir)) : null)
  const projectsDir = effectiveDataDir ? path.join(effectiveDataDir, 'Projects') : null

  const procs = await taskList()
  const ports = await netstat()
  const apps = {}
  for (const key of Object.keys(EXE_NAMES)) {
    const image = EXE_NAMES[key].toLowerCase()
    const hits = procs.filter(function (p) { return p.image.toLowerCase() === image })
    if (hits.length) {
      const pid = hits[0].pid
      apps[key] = {
        running: true,
        pid: pid,
        listening: ports.filter(function (p) { return p.pid === pid && p.state === 'LISTENING' })
          .map(function (p) { return p.localPort })
          .sort(function (a, b) { return a - b }),
      }
    } else {
      apps[key] = { running: false }
    }
  }

  const webPort = (apps.server && apps.server.listening || []).find(function (p) { return p >= 8700 && p <= 8799 && p !== 8750 && p !== 8755 })
  const adminPort = 8758
  return {
    registry: { hklm, hklm64, hkcu },
    reg,
    language: reg.Language || null,
    types: (hkcu && hkcu.Types) || null,
    components: (hkcu && hkcu.Components) || null,
    installDir,
    dataDir: effectiveDataDir,
    projectsDir: projectsDir && isDir(projectsDir) ? projectsDir : null,
    ports: { admin: adminPort, client: DEFAULT_CLIENT_PORT, web: DEFAULT_WEB_PORT, serverListening: apps.server.listening || [] },
    apps,
  }
}

export function projectFolders(projectsDir) {
  if (!projectsDir || !isDir(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter(function (e) { return e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') })
    .map(function (e) { return path.join(projectsDir, e.name) })
}

export function resolveProject(projectsDir, nameOrPath) {
  if (!nameOrPath) throw new Error('project name is required')
  if (isDir(nameOrPath) && existsSync(path.join(nameOrPath, 'Project.spr'))) return nameOrPath
  const folders = projectFolders(projectsDir)
  const hit = folders.find(function (p) { return path.basename(p).toLowerCase() === String(nameOrPath).toLowerCase() })
  if (!hit) {
    throw new Error('project not found: ' + nameOrPath + ' (known: ' + folders.map(function (p) { return path.basename(p) }).join(', ') + ')')
  }
  return hit
}

export async function listeningPortOwner(port) {
  const rows = await netstat()
  const hit = rows.find(function (r) { return r.state === 'LISTENING' && r.localPort === port })
  return hit ? hit.pid : null
}
