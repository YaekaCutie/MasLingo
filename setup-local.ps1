[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

Push-Location $Root
try {
    if (-not (Test-Path $VenvPython)) {
        $Launcher = $null
        $LauncherArgs = @()
        if (Get-Command py -ErrorAction SilentlyContinue) {
            foreach ($Version in @("3.12", "3.11")) {
                try {
                    & py "-$Version" -c "import sys; print(sys.version.split()[0])" 2>$null
                } catch {
                    continue
                }
                if ($LASTEXITCODE -eq 0) {
                    $Launcher = "py"
                    $LauncherArgs = @("-$Version")
                    break
                }
            }
        }
        if (-not $Launcher -and (Get-Command python -ErrorAction SilentlyContinue)) {
            & python -c "import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] <= (3, 12) else 1)"
            if ($LASTEXITCODE -eq 0) { $Launcher = "python" }
        }
        if (-not $Launcher) {
            throw "Install Python 3.12 from https://www.python.org/downloads/ and enable Add python.exe to PATH."
        }
        & $Launcher @LauncherArgs -m venv (Join-Path $Root ".venv")
        if ($LASTEXITCODE -ne 0) { throw "Could not create the Python environment." }
    }

    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "Could not update pip. Check your network." }
    # CPU wheels avoid downloading an unnecessary CUDA runtime.
    & $VenvPython -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    if ($LASTEXITCODE -ne 0) { throw "Could not install the CPU OCR runtime." }
    & $VenvPython -m pip install -r (Join-Path $Root "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Could not install backend dependencies." }

    Write-Host "Loading MangaOCR. The first run downloads the model; keep this window open."
    if (-not $env:MAS_TORCH_THREADS) { $env:MAS_TORCH_THREADS = "2" }
    & $VenvPython -c "from backend.ocr.manga_ocr_engine import get_engine; from backend.ocr.text_detector import get_detector; get_engine(); get_detector(); print('OCR ready')"
    if ($LASTEXITCODE -ne 0) { throw "OCR model initialization failed. Check your connection to huggingface.co and retry." }
    Write-Host "Setup complete. Start the backend with: .\start-backend.ps1"
} finally {
    Pop-Location
}
