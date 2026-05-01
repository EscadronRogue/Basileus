param(
  [int]$Port = 8123
)

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $projectRoot 'simulation\training-server.js'

function Test-CommandExists {
  param([string]$Command)
  return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists 'node')) {
  Write-Error 'Node.js is required for the fast local trainer. Install Node.js, then run this script again.'
  exit 1
}

Write-Host "Starting Basileus local server on http://127.0.0.1:$Port/"
Write-Host "Main game: http://127.0.0.1:$Port/index.html"
Write-Host "Simulation Lab: http://127.0.0.1:$Port/simulator.html"
Write-Host 'This PowerShell window is the local backend. Keep it open.'
Write-Host 'When a training job starts, this window will print job and progress logs.'
Write-Host 'Press Ctrl+C here to stop the local server.'
Write-Host ''

Push-Location $projectRoot
try {
  & node $serverScript "--port=$Port" '--open'
} finally {
  Pop-Location
}
