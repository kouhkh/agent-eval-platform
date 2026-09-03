param(
  [string]$DshRoot = (Join-Path $PSScriptRoot '..\..\..\deepseek-harness'),
  [Parameter(Mandatory = $true)][string]$WorkspaceRoots,
  [int]$Port = 4319
)

$ErrorActionPreference = 'Stop'
$serviceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$DshRoot = [System.IO.Path]::GetFullPath($DshRoot)

if (-not $env:DEEPSEEK_API_KEY -and -not (Test-Path (Join-Path $DshRoot '.env'))) {
  throw 'DEEPSEEK_API_KEY is not configured. Set it in this PowerShell session or create the DSH root .env on Windows.'
}

$env:DSH_ROOT = $DshRoot
$env:DSH_AGENT_WORKSPACE_ROOTS = $WorkspaceRoots
$env:PORT = [string]$Port

Set-Location $serviceRoot
& node .\server.mjs
