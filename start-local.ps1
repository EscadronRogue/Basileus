param(
  [int]$Port = 8123
)

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $projectRoot 'multiplayer\server.js'

function Test-CommandExists {
  param([string]$Command)
  return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists 'node')) {
  Write-Error 'Node.js is required for the local server. Install Node.js, then run this script again.'
  exit 1
}

Write-Host "Starting Basileus local server on http://127.0.0.1:$Port/"
Write-Host "Main game: http://127.0.0.1:$Port/index.html"
Write-Host 'This PowerShell window is the local backend. Keep it open.'
Write-Host 'Press Ctrl+C here to stop the local server.'
Write-Host ''

Push-Location $projectRoot
try {
  $previousPort = $env:PORT
  $previousHost = $env:HOST
  $env:PORT = [string]$Port
  $env:HOST = '127.0.0.1'
  & node $serverScript
} finally {
  $env:PORT = $previousPort
  $env:HOST = $previousHost
  Pop-Location
}
