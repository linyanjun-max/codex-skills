# Phase 7: open the generated .docx in Word, report its statistics, and render a
# PDF so the layout can be eyeballed.
#
# IMPORTANT: run this with danger-full-access. Under the normal workspace-write
# sandbox Word cannot reach its own profile or %TEMP% and fails with
#   "Word 未能引发事件"  (Word failed to raise event)
#   "文件可能已经损坏"  (the file may be corrupted)   <- also reported for VALID files
# so a sandboxed failure here does NOT mean the document is broken.
#
#   scripts\check_docx.ps1 -Path "book.docx"
#   scripts\check_docx.ps1 -Path "book.docx" -NoPdf

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$NoPdf
)

$ErrorActionPreference = 'Continue'
$Path = (Resolve-Path -LiteralPath $Path).Path

# A stale WINWORD holding a previous document makes COM activation flaky.
Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# Word writes scratch files; point it at the real user temp, not the sandbox one.
$env:TEMP = Join-Path $env:USERPROFILE 'AppData\Local\Temp'
$env:TMP = $env:TEMP

$word = $null
try {
    $word = New-Object -ComObject Word.Application
    Start-Sleep -Seconds 3
    $doc = $word.Documents.Open($Path, $false, $true)

    Write-Output "OPENED OK"
    Write-Output ("pages       = {0}" -f $doc.ComputeStatistics(2))
    Write-Output ("characters  = {0}" -f $doc.ComputeStatistics(3))
    Write-Output ("words       = {0}" -f $doc.ComputeStatistics(0))
    Write-Output ("paragraphs  = {0}" -f $doc.Paragraphs.Count)
    Write-Output ("images      = {0}" -f $doc.InlineShapes.Count)
    Write-Output ("equations   = {0}" -f $doc.OMaths.Count)
    Write-Output ("tables      = {0}" -f $doc.Tables.Count)
    Write-Output ("sections    = {0}" -f $doc.Sections.Count)

    if (-not $NoPdf) {
        $pdf = [System.IO.Path]::ChangeExtension($Path, '.pdf')
        if (Test-Path -LiteralPath $pdf) { Remove-Item -LiteralPath $pdf -Force }
        $doc.ExportAsFixedFormat($pdf, 17)
        Write-Output ("PDF         = {0} ({1:N0} bytes)" -f $pdf, (Get-Item -LiteralPath $pdf).Length)
        Write-Output ""
        Write-Output "Now render a few pages and LOOK at them, e.g.:"
        Write-Output ("  pdftoppm -png -r 130 -f 11 -l 11 `"{0}`" out" -f $pdf)
    }

    $doc.Close(0)
    Write-Output "VALIDATION PASSED"
}
catch {
    Write-Output "WORD ERROR: $($_.Exception.Message)"
    Write-Output ""
    Write-Output "If this run was NOT under danger-full-access the failure is a sandbox"
    Write-Output "artifact - re-run with full access before suspecting the document."
    Write-Output "If it still fails, bisect with the recipe in references/ooxml-pitfalls.md."
    exit 1
}
finally {
    if ($word) { try { $word.Quit() } catch { } }
}
