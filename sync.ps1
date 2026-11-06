<#
.SYNOPSIS
  Sync the latest snapshot of social-media-hacker-list to a local folder.

.DESCRIPTION
  On this machine github.com:443 is unreachable (git clone/fetch times out), while
  codeload.github.com and api.github.com do respond. So this script pulls the
  official zip endpoint and mirrors it with robocopy.

  Use -Commit to record each sync as a local git commit, so upstream changes stay
  visible in local history even without a working git pull.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes .ps1 files using
  the system ANSI codepage (cp936 here), which corrupts non-ASCII source.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\sync.ps1
  powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Parse
  powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Commit -Parse
#>
[CmdletBinding()]
param(
  [string]$Repo = 'MobileFirstLLC/social-media-hacker-list',
  [string]$Branch,
  [string]$Dest,
  [switch]$Parse,
  [switch]$Commit
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Dest) { $Dest = Join-Path (Split-Path -Parent $here) 'social-media-hacker-list' }

$headers = @{
  'User-Agent' = 'smhl-kit-sync'
  'Accept'     = 'application/vnd.github+json'
}

Write-Host "[1/4] Query upstream $Repo"
$info = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $headers -TimeoutSec 60
if (-not $Branch) { $Branch = $info.default_branch }
$commitInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $headers -TimeoutSec 60
$sha = $commitInfo.sha
$short = $sha.Substring(0, 7)
Write-Host "      branch=$Branch  latest=$short  ($($commitInfo.commit.author.date))"

Write-Host "[2/4] Download snapshot zip"
$zip = Join-Path $env:TEMP "smhl-$short.zip"
Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -TimeoutSec 180 -UseBasicParsing
Write-Host "      $([math]::Round((Get-Item $zip).Length / 1KB, 1)) KB -> $zip"

Write-Host "[3/4] Extract and mirror into $Dest"
$stage = Join-Path $env:TEMP "smhl-stage-$short"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $stage -Force
$inner = (Get-ChildItem $stage -Directory | Select-Object -First 1).FullName
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }

# /MIR makes the destination match upstream; /XD .git keeps local repo history.
robocopy $inner $Dest /MIR /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }

$dataDir = Join-Path $here 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
$meta = [ordered]@{
  repo        = $Repo
  branch      = $Branch
  commit      = $sha
  commitDate  = $commitInfo.commit.author.date
  commitTitle = ($commitInfo.commit.message -split "`n")[0]
  fetchedAt   = (Get-Date).ToUniversalTime().ToString('o')
  destination = $Dest
}
# WriteAllText instead of Set-Content: PS 5.1 -Encoding utf8 emits a BOM, and a
# BOM makes Node's JSON.parse throw.
$metaPath = Join-Path $dataDir 'upstream.json'
[System.IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "      upstream info -> data/upstream.json"

if ($Commit) {
  Write-Host "[4/4] Record as local git commit"
  Push-Location $Dest
  try {
    if (-not (Test-Path (Join-Path $Dest '.git'))) { git init -q; git branch -M main }
    git add -A
    $dirty = git status --porcelain
    if ($dirty) {
      git -c user.name='smhl-kit' -c user.email='smhl-kit@local' commit -q -m "snapshot upstream $short" -m "repo: $Repo`nbranch: $Branch`ncommit: $sha`n$($commitInfo.commit.message)"
      Write-Host "      committed snapshot upstream $short"
    } else {
      Write-Host "      no changes, skipped commit"
    }
  } finally { Pop-Location }
} else {
  Write-Host "[4/4] Skipped git commit (pass -Commit to enable)"
}

if ($Parse) {
  Write-Host "Re-parse README"
  Push-Location $here
  try { node (Join-Path $here 'parse.mjs') } finally { Pop-Location }
}

Write-Host "Done: upstream $short"
