param(
  [string]$DshRoot = (Join-Path $PSScriptRoot '..\..\..\deepseek-harness')
)

$ErrorActionPreference = 'Stop'
$DshRoot = [System.IO.Path]::GetFullPath($DshRoot)

if (-not (Test-Path (Join-Path $DshRoot 'pnpm-lock.yaml'))) {
  throw "DeepSeek Harness source was not found at $DshRoot"
}

$nodeVersion = [version]((& node --version).TrimStart('v'))
$supportedNode = (($nodeVersion.Major -eq 22) -and ($nodeVersion -ge [version]'22.19.0')) -or ($nodeVersion.Major -ge 24)
if (-not $supportedNode) {
  throw "DSH requires Node 22.19+ in the Node 22 line, or Node 24+. Found $nodeVersion"
}

$revisionPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\DSH_REVISION.txt'))
$env:DSH_CLIENT_COMMIT_HASH = (Get-Content -Raw $revisionPath).Trim()

& corepack pnpm@11.7.0 --dir $DshRoot install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }

& corepack pnpm@11.7.0 --dir $DshRoot run 'build:lib:host'
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }

$entry = Join-Path $DshRoot 'apps\cli\lib\bin.js'
if (-not (Test-Path $entry)) { throw "DSH build did not produce $entry" }

Write-Host "DSH build ready at $DshRoot"
Write-Host 'No API key was copied. Set DEEPSEEK_API_KEY in the Windows service environment or create the DSH root .env locally.'
