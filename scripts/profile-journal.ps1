<#
.SYNOPSIS
  Measure journal event frequency and per-field presence rates.

.DESCRIPTION
  This is the tool that produced the figures in docs/JOURNAL.md. Re-run it after
  every Elite Dangerous update: a build change is the expected trigger for
  re-validating which fields are actually present, and at what rate.

  Any field below 100% must be modelled as optional in the parser.

.EXAMPLE
  pwsh scripts/profile-journal.ps1
  pwsh scripts/profile-journal.ps1 -Events Docked,MissionAccepted
  pwsh scripts/profile-journal.ps1 -Directory 'D:\Journals'
#>
[CmdletBinding()]
param(
  # Events to profile field-by-field. Omit for a frequency census of everything.
  [string[]]$Events,
  # Journal directory. Defaults to the Saved Games known folder.
  [string]$Directory
)

function Resolve-JournalDirectory {
  param([string]$Override)

  if ($Override) { return $Override }

  # Resolve the Saved Games known folder rather than assembling a path by hand:
  # the folder can be relocated, so the user profile is not authoritative.
  try {
    Add-Type -Namespace Edfm -Name Shell -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern int SHGetKnownFolderPath(
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPStruct)] System.Guid rfid,
    uint dwFlags, System.IntPtr hToken,
    out System.IntPtr pszPath);
'@ -ErrorAction Stop
    $guid = [Guid]'4C5C32FF-BB9D-43b0-B5B4-2D72E54EAAA4'  # FOLDERID_SavedGames
    $ptr = [IntPtr]::Zero
    if ([Edfm.Shell]::SHGetKnownFolderPath($guid, 0, [IntPtr]::Zero, [ref]$ptr) -eq 0) {
      $saved = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
      [Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr)
      if ($saved) { return Join-Path $saved 'Frontier Developments\Elite Dangerous' }
    }
  } catch {
    Write-Verbose "Known-folder lookup unavailable: $_"
  }

  return Join-Path $env:USERPROFILE 'Saved Games\Frontier Developments\Elite Dangerous'
}

$dir = Resolve-JournalDirectory -Override $Directory
if (-not (Test-Path $dir)) { throw "Journal directory not found: $dir" }

$files = Get-ChildItem $dir -Filter 'Journal.*.log'
Write-Host "Directory: $dir"
Write-Host "Files: $($files.Count)  Total MB: $('{0:N1}' -f (($files | Measure-Object Length -Sum).Sum / 1MB))"
Write-Host ''

if (-not $Events) {
  # Frequency census across every event type.
  $counts = @{}; $lines = 0; $noEvent = 0
  foreach ($f in $files) {
    foreach ($line in [IO.File]::ReadLines($f.FullName)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $lines++
      $m = [regex]::Match($line, '"event":"([^"]+)"')
      if ($m.Success) { $counts[$m.Groups[1].Value] = 1 + $counts[$m.Groups[1].Value] } else { $noEvent++ }
    }
  }
  Write-Host "Lines: $lines   Without an event field: $noEvent   Distinct events: $($counts.Count)"
  Write-Host ''
  $counts.GetEnumerator() | Sort-Object Value -Descending |
    ForEach-Object { '{0,-42} {1}' -f $_.Key, $_.Value }
  return
}

# Per-field presence for the named events.
$stats = @{}
foreach ($e in $Events) { $stats[$e] = @{ count = 0; fields = @{} } }

foreach ($f in $files) {
  foreach ($line in [IO.File]::ReadLines($f.FullName)) {
    $m = [regex]::Match($line, '"event":"([^"]+)"')
    if (-not $m.Success) { continue }
    $ev = $m.Groups[1].Value
    if (-not $stats.ContainsKey($ev)) { continue }
    try { $doc = [System.Text.Json.JsonDocument]::Parse($line) } catch { continue }
    $stats[$ev].count++
    foreach ($p in $doc.RootElement.EnumerateObject()) {
      $stats[$ev].fields[$p.Name] = 1 + $stats[$ev].fields[$p.Name]
    }
    $doc.Dispose()
  }
}

foreach ($e in $Events) {
  $c = $stats[$e].count
  Write-Host "===== $e  (n=$c) ====="
  if ($c -eq 0) { Write-Host '  (not observed)'; Write-Host ''; continue }
  $stats[$e].fields.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    $pct = 100.0 * $_.Value / $c
    $flag = if ($pct -lt 99.95) { '   <-- OPTIONAL' } else { '' }
    '  {0,-32} {1,7} {2,6:N1}%{3}' -f $_.Key, $_.Value, $pct, $flag
  }
  Write-Host ''
}
