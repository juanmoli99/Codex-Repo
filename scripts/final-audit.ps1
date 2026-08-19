param(
  [Parameter(Mandatory = $false)]
  [string]$DatabaseUrl = $env:DATABASE_URL
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $workspace
try {
  if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    $env:DATABASE_URL = $DatabaseUrl
  }

  & pnpm verify
  if ($LASTEXITCODE -ne 0) { throw "pnpm verify failed with exit code $LASTEXITCODE" }
  & pnpm test:coverage
  if ($LASTEXITCODE -ne 0) { throw "coverage gates failed with exit code $LASTEXITCODE" }
  & pnpm audit --audit-level high
  if ($LASTEXITCODE -ne 0) { throw "dependency audit failed with exit code $LASTEXITCODE" }

  if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    & pnpm --filter '@aegis/backend' db:validate
    if ($LASTEXITCODE -ne 0) { throw "Prisma validation failed with exit code $LASTEXITCODE" }
    & pnpm --filter '@aegis/backend' db:deploy
    if ($LASTEXITCODE -ne 0) { throw "Migration deployment failed with exit code $LASTEXITCODE" }
  }

  [pscustomobject]@{
    Status = 'PASS'
    DatabaseChecked = -not [string]::IsNullOrWhiteSpace($DatabaseUrl)
    CompletedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}
finally {
  Pop-Location
}
