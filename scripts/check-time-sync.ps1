$ErrorActionPreference = 'Stop'
$status = w32tm /query /status
$status
if ($LASTEXITCODE -ne 0) {
  throw 'Windows Time Service is not healthy.'
}
