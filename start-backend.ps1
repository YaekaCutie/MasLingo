[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8001
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Error "Run setup-local.ps1 first to install the local OCR backend."
    exit 1
}

if (-not $env:MAS_TORCH_THREADS) { $env:MAS_TORCH_THREADS = "2" }
if (-not $env:MAS_OCR_CONCURRENCY) { $env:MAS_OCR_CONCURRENCY = "1" }
Push-Location $Root
try {
    & $VenvPython -m uvicorn backend.app:app --host 127.0.0.1 --port $Port --no-access-log
    $BackendExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $BackendExitCode
