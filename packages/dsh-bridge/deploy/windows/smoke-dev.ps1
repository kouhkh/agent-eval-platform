param([int]$Port = 4319)

$ErrorActionPreference = 'Stop'
$health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/api/health"
if (-not $health.ok) { throw 'Health endpoint did not report ok=true' }
$health | ConvertTo-Json -Depth 5
