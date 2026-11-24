// Script compilation for Simple-Scada 2.
//
// Facts (verified):
//  * Actually compiling scripts is done by Editor.exe, which embeds PaxCompiler
//    ("Start compile all" / "Create bytecode" lines appear in Logs\Editor-log.txt).
//    The server only loads Scripts\Compiled\program.exs, so a source edit stays
//    invisible to a running project until the editor recompiles it.
//  * Editor.exe ignores command-line arguments (tested with the project folder,
//    the Project.spr path, -project and --project- forms): it always shows its
//    ZenGL start screen, which has no Win32/UIA controls (window class "ZenGL",
//    a single opaque pane), so the project cannot be opened headlessly.
//  * Hot keys from the manual: Ctrl+Shift+S = "Save and compile", F9 = compile,
//    Shift+F9 = compile all, F5 = debug run.
//
// Therefore this module drives the editor by hot key and proves the result by
// bytecode timestamp + editor log, instead of pretending a headless build exists.

import { spawn } from 'node:child_process'
import { statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_ROOT } from './values.js'

export const HOTKEYS = {
  saveAndCompile: '^+s', // Ctrl+Shift+S
  compile: '{F9}',
  compileAll: '+{F9}', // Shift+F9
  debugRun: '{F5}',
}

const PS_SCRIPT = String.raw`
param([string]$Exe, [string]$Keys, [int]$WaitMs = 1200)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ScadaWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr Found = IntPtr.Zero;
  public static string FoundTitle = "";
  public static string FoundClass = "";
  public static List<string> All = new List<string>();
  public static void Find(uint target) {
    Found = IntPtr.Zero; All.Clear();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        if (t.Length > 0) {
          All.Add(t.ToString() + " [" + c.ToString() + "]");
          if (Found == IntPtr.Zero) { Found = h; FoundTitle = t.ToString(); FoundClass = c.ToString(); }
        }
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@
$procs = @(Get-Process Editor -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  if ($Exe -and (Test-Path $Exe)) {
    Start-Process -FilePath $Exe | Out-Null
    Start-Sleep -Seconds 6
    $procs = @(Get-Process Editor -ErrorAction SilentlyContinue)
  }
}
if ($procs.Count -eq 0) { Write-Output '{"ok":false,"error":"Simple-Scada Editor is not running and could not be started"}'; exit 0 }
$p = $procs[0]
[ScadaWin]::Find([uint32]$p.Id)
if ([ScadaWin]::Found -eq [IntPtr]::Zero) { Write-Output ('{"ok":false,"error":"no visible editor window","pid":' + $p.Id + '}'); exit 0 }
[ScadaWin]::ShowWindow([ScadaWin]::Found, 9) | Out-Null
[ScadaWin]::SetForegroundWindow([ScadaWin]::Found) | Out-Null
Start-Sleep -Milliseconds 600
$fg = [ScadaWin]::GetForegroundWindow()
$same = ($fg -eq [ScadaWin]::Found)
if ($Keys) {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $WaitMs
}
$payload = [pscustomobject]@{
  ok = $true
  pid = $p.Id
  hwnd = [int64][ScadaWin]::Found
  title = [ScadaWin]::FoundTitle
  className = [ScadaWin]::FoundClass
  windows = [ScadaWin]::All
  foreground = $same
  keysSent = $Keys
}
$payload | ConvertTo-Json -Compress
`

function runPowershell(args, timeoutMs, env) {
  return new Promise(function (resolve) {
    const child = spawn('powershell.exe', args, { windowsHide: true, env: Object.assign({}, process.env, env || {}) })
    let out = ''
    let err = ''
    const timer = setTimeout(function () {
      try { child.kill() } catch (e) { }
      resolve({ ok: false, error: 'powershell timed out', stdout: out, stderr: err })
    }, timeoutMs || 60000)
    child.stdout.on('data', function (d) { out += d.toString('utf8') })
    child.stderr.on('data', function (d) { err += d.toString('utf8') })
    child.on('error', function (e) { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on('close', function (code) {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const parsed = JSON.parse(line)
        parsed.exitCode = code
        if (err.trim()) parsed.stderr = err.slice(-1500)
        resolve(parsed)
      } catch (e) {
        resolve({ ok: false, error: 'unexpected powershell output', exitCode: code, stdout: out.slice(-2000), stderr: err.slice(-2000) })
      }
    })
  })
}

function psScriptPath() {
  return path.join(PLUGIN_ROOT, 'scripts', 'editor_hotkey.ps1')
}

export async function sendHotkey(exePath, keys, waitMs) {
  return await runPowershell([
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath(),
  ], 90000, {
    SCADA_EXE: exePath || '',
    SCADA_KEYS: keys || '',
    SCADA_WAIT_MS: String(waitMs || 1200),
  })
}

export async function editorWindowInfo() {
  return await runPowershell([
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath(),
  ], 60000, { SCADA_EXE: '', SCADA_KEYS: '', SCADA_WAIT_MS: '0' })
}

export function fileInfo(p) {
  if (!p || !existsSync(p)) return null
  const s = statSync(p)
  return { path: p, size: s.size, mtimeMs: s.mtimeMs, mtime: new Date(s.mtimeMs).toISOString() }
}

export function compiledInfo(projectDir) {
  return {
    program: fileInfo(path.join(projectDir, 'Scripts', 'Compiled', 'program.exs')),
    words: fileInfo(path.join(projectDir, 'Scripts', 'Compiled', 'words.exs')),
    source: fileInfo(path.join(projectDir, 'Scripts', 'Scripts.ssc')),
  }
}

export function bytecodeStale(projectDir) {
  const info = compiledInfo(projectDir)
  if (!info.source) return { stale: false, reason: 'no Scripts.ssc' }
  if (!info.program) return { stale: true, reason: 'program.exs is missing: the project has never been compiled' }
  const stale = info.source.mtimeMs > info.program.mtimeMs + 1000
  return {
    stale: stale,
    reason: stale
      ? 'Scripts.ssc is newer than the compiled bytecode; the server will keep running the previous scripts until the editor recompiles'
      : 'compiled bytecode is up to date with Scripts.ssc',
    sourceMtime: info.source.mtime,
    programMtime: info.program.mtime,
  }
}

// Read the last N bytes of a log file as UTF-8 text.
export function tailFile(file, maxBytes) {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  const start = Math.max(0, size - (maxBytes || 20000))
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// Lines the editor writes while compiling (see Logs\Editor-log.txt).
export function compileLogSince(logText) {
  const lines = String(logText || '').split(/\r?\n/)
  const start = lines.map(function (l) { return /Start compile all|Create bytecode begin/.test(l) }).lastIndexOf(true)
  if (start < 0) return null
  const chunk = lines.slice(start)
  return {
    started: chunk[0] || '',
    finished: chunk.filter(function (l) { return /End compile all/.test(l) }).pop() || null,
    errors: chunk.filter(function (l) { return /\b(error|ошибк|failed|cannot|undeclared)\b/i.test(l) }).slice(0, 40),
    lines: chunk.slice(-60),
  }
}
