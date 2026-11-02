[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8001,
    [switch]$Speech
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
if ($Speech) {
    & $VenvPython -c "import faster_whisper" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Install speech support first: .venv\Scripts\python.exe -m pip install -r backend/requirements-speech.txt"
        exit 1
    }
    $env:MAS_ENABLE_SPEECH = "1"
    Write-Host "Video speech recognition enabled. The first request may download the local speech model."
}
Push-Location $Root
try {
    & $VenvPython -m uvicorn backend.app:app --host 127.0.0.1 --port $Port --no-access-log
    $BackendExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $BackendExitCode
