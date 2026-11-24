param(
  [string]$Exe = '',
  [string]$Keys = '',
  [int]$WaitMs = 1200
)
# Prefer environment variables: paths with spaces, parentheses or Cyrillic
# survive command-line quoting much more reliably this way (see lib/editor.js).
if ($env:SCADA_EXE) { $Exe = $env:SCADA_EXE }
if ($env:SCADA_KEYS) { $Keys = $env:SCADA_KEYS }
if ($env:SCADA_WAIT_MS) { $WaitMs = [int]$env:SCADA_WAIT_MS }
# Focus the Simple-Scada Editor window and send one keystroke sequence.
# Called by lib/editor.js. Emits a single JSON line on stdout.
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

$started = $false
$procs = @(Get-Process Editor -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0 -and $Exe -and (Test-Path $Exe)) {
  Start-Process -FilePath $Exe | Out-Null
  $started = $true
  Start-Sleep -Seconds 8
  $procs = @(Get-Process Editor -ErrorAction SilentlyContinue)
}
if ($procs.Count -eq 0) {
  Write-Output '{"ok":false,"error":"Simple-Scada Editor is not running and could not be started","launched":false}'
  exit 0
}

$p = $procs[0]
[ScadaWin]::Find([uint32]$p.Id)
if ([ScadaWin]::Found -eq [IntPtr]::Zero) {
  Write-Output ('{"ok":false,"error":"the editor process has no visible window","pid":' + $p.Id + ',"launched":' + $started.ToString().ToLower() + '}')
  exit 0
}

[ScadaWin]::ShowWindow([ScadaWin]::Found, 9) | Out-Null
[ScadaWin]::SetForegroundWindow([ScadaWin]::Found) | Out-Null
Start-Sleep -Milliseconds 700
$fg = [ScadaWin]::GetForegroundWindow()
$same = ($fg -eq [ScadaWin]::Found)

if ($Keys -and $Keys.Trim().Length -gt 0) {
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $WaitMs
}

$payload = [pscustomobject]@{
  ok         = $true
  launched   = $started
  pid        = $p.Id
  hwnd       = [int64][ScadaWin]::Found
  title      = [ScadaWin]::FoundTitle
  className  = [ScadaWin]::FoundClass
  windows    = [ScadaWin]::All
  foreground = $same
  keysSent   = $Keys
}
$payload | ConvertTo-Json -Compress

