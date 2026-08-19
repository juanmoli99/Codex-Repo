param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDatabaseUrl,
  [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
  [string]$DrillDatabase = 'aegis_restore_drill'
)

$ErrorActionPreference = 'Stop'
if ($DrillDatabase -notmatch '^[a-z0-9_]*restore_drill[a-z0-9_]*$') {
  throw 'DrillDatabase must be a simple isolated name containing restore_drill'
}

$taskRoot = Split-Path -Parent $PSScriptRoot
$artifactDirectory = Join-Path $taskRoot 'work\backup-drill'
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$backupFile = Join-Path $artifactDirectory "aegis-$timestamp.dump"
$checksumFile = "$backupFile.sha256"

$pgDump = Join-Path $PostgresBin 'pg_dump.exe'
$pgRestore = Join-Path $PostgresBin 'pg_restore.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
$createdb = Join-Path $PostgresBin 'createdb.exe'
$dropdb = Join-Path $PostgresBin 'dropdb.exe'

& $pgDump --dbname=$SourceDatabaseUrl --format=custom --compress=9 --no-owner --no-acl --file=$backupFile
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
& $pgRestore --list $backupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'pg_restore could not read the backup catalog' }

$hash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $checksumFile -Value "$hash  $(Split-Path -Leaf $backupFile)" -Encoding ascii
if ((Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
  throw 'Backup checksum verification failed'
}

$uri = [Uri]$SourceDatabaseUrl
$adminUrl = "postgresql://$($uri.UserInfo)@$($uri.Host):$($uri.Port)/postgres"
& $dropdb --if-exists --force --maintenance-db=$adminUrl $DrillDatabase
if ($LASTEXITCODE -ne 0) { throw 'Could not clear the isolated drill database' }
& $createdb --maintenance-db=$adminUrl $DrillDatabase
if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated drill database' }

$drillUrl = "postgresql://$($uri.UserInfo)@$($uri.Host):$($uri.Port)/$DrillDatabase"
try {
  & $pgRestore --exit-on-error --no-owner --no-acl --dbname=$drillUrl $backupFile
  if ($LASTEXITCODE -ne 0) { throw 'Restore failed' }
  $verification = & $psql $drillUrl -v ON_ERROR_STOP=1 -tAc "select (select count(*) from _prisma_migrations where finished_at is not null)::text || '|' || (select count(*) from information_schema.tables where table_schema='public')::text"
  if ($LASTEXITCODE -ne 0 -or $verification -notmatch '^\d+\|\d+$') {
    throw 'Restored database verification failed'
  }
  $parts = $verification.Trim().Split('|')
  if ([int]$parts[0] -lt 1 -or [int]$parts[1] -lt 1) { throw 'Restore contains no migrations or tables' }
  [pscustomobject]@{
    Status = 'PASS'
    Backup = $backupFile
    Sha256 = $hash
    AppliedMigrations = [int]$parts[0]
    PublicTables = [int]$parts[1]
  } | ConvertTo-Json
}
finally {
  & $dropdb --if-exists --force --maintenance-db=$adminUrl $DrillDatabase | Out-Null
}
