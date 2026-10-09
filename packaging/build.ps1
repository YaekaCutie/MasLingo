<#
.SYNOPSIS
    Build the MasLingo Windows installer, from an empty build/ to a Setup.exe.

.DESCRIPTION
    Re-runnable and idempotent: every step detects whether it has already been
    done and skips it, so a failed run resumes rather than starting over (the
    runtime alone is a ~1 GB download plus ~1.1 GB on disk).

    Steps, in order, each of which must actually succeed:

      1. Assemble the relocatable Python runtime (embeddable distribution).
      2. Install the pinned dependencies into it.
      3. Verify it — import, detect, recognise — with no environment variables.
      4. Stage the application payload (runtime + backend + engine + model).
      5. Compile the installer with Inno Setup.

    Step 3 exists because the failure that matters is not "the build script
    errored" but "the build succeeded and the user's first page fails". A runtime
    missing its model cache or its mecab dictionary imports fine and breaks on
    first use.

.PARAMETER SkipRuntime
    Reuse build/runtime as-is. Use while iterating on the installer or the
    engine, where the runtime cannot have changed.

.PARAMETER SkipVerify
    Skip step 3. Only for diagnosing a build; never for a release.
#>
[CmdletBinding()]
param(
    [switch]$SkipRuntime,
    [switch]$SkipVerify,
    [string]$PythonVersion = "3.12.10",
    [string]$Version = "1.1.5"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Build = Join-Path $Root "build"
$Runtime = Join-Path $Build "runtime"
$Stage = Join-Path $Build "stage"
$RuntimeReq = Join-Path $Root "packaging\runtime-requirements.txt"
$BootstrapPython = Join-Path $Root ".venv\Scripts\python.exe"

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ok   $text" -ForegroundColor Green }
function Info($text) { Write-Host "       $text" -ForegroundColor DarkGray }

# --- prerequisites ---------------------------------------------------------

Step "检查前置条件"

if (-not (Test-Path $BootstrapPython)) {
    throw "找不到 $BootstrapPython —— 打包用的引导解释器（仅用于把依赖装进目标目录）。"
}
Ok "引导解释器 $BootstrapPython"

$Iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Iscc) {
    throw "找不到 ISCC.exe。安装：winget install -e --id JRSoftware.InnoSetup"
}
Ok "Inno Setup 编译器 $Iscc"

# The model weights are the one input that cannot be regenerated from the repo.
$hfCache = Join-Path $env:USERPROFILE ".cache\huggingface"
if (-not (Test-Path $hfCache)) {
    throw "找不到 HuggingFace 模型缓存 $hfCache。先跑一次后端让权重下载完成。"
}
Ok "模型缓存 $hfCache"

# --- 1. runtime ------------------------------------------------------------

if ($SkipRuntime -and (Test-Path (Join-Path $Runtime "python.exe"))) {
    Step "1. 运行时（--SkipRuntime，复用现有）"
    Ok "复用 $Runtime"
} else {
    Step "1. 组装可迁移的 Python 运行时"
    Info "用官方的 embeddable 发行版，不是 venv：venv 的 pyvenv.cfg 指向构建机的"
    Info "基础 Python 目录，装到用户机器上就不存在了。"

    $zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
    if (-not (Test-Path $zip)) {
        $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
        Info "下载 $url"
        Invoke-WebRequest $url -OutFile $zip -TimeoutSec 600
    }
    Ok "embeddable 包 $([math]::Round((Get-Item $zip).Length/1MB,1)) MB"

    if (Test-Path $Runtime) {
        # A running engine holds its own DLLs open, and Windows refuses to delete
        # a loaded module. The first build failed here on a leftover process from
        # a manual test, with an error that named a .pyd file rather than the
        # process holding it — so the check is explicit rather than incidental.
        $holders = Get-Process python, pythonw -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -like "$Runtime*" } catch { $false }
        }
        foreach ($holder in $holders) {
            Info "结束仍在使用该运行时的进程 pid=$($holder.Id)"
            Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
        }
        if ($holders) { Start-Sleep -Seconds 2 }

        try {
            Remove-Item $Runtime -Recurse -Force -ErrorAction Stop
        } catch {
            throw "无法删除 $Runtime：$($_.Exception.Message)`n先结束占用它的进程（引擎可能还在运行），或用 -SkipRuntime 复用现有运行时。"
        }
    }
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    Expand-Archive $zip -DestinationPath $Runtime -Force

    # The ._pth file is what makes third-party imports work at all. Without
    # `Lib\site-packages` the distribution ignores everything we install, and
    # without `import site` the .pth files some packages rely on never run.
    $pth = Join-Path $Runtime "python312._pth"
    @(
        "python312.zip"
        "."
        "Lib\site-packages"
        "import site"
    ) | Set-Content $pth -Encoding ASCII
    Ok "已配置 python312._pth"

    Step "2. 安装固定版本的依赖"
    $sitePackages = Join-Path $Runtime "Lib\site-packages"
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    # --ignore-installed: without it pip sees the bootstrap venv's copies as
    # already satisfying the requirements and installs nothing into --target.
    & $BootstrapPython -m pip install --ignore-installed --target $sitePackages -r $RuntimeReq
    if ($LASTEXITCODE -ne 0) { throw "依赖安装失败（退出码 $LASTEXITCODE）" }
    # The tray icon is a runtime concern but not a backend one, so it is kept out
    # of runtime-requirements.txt and added here.
    & $BootstrapPython -m pip install --quiet --ignore-installed --target $sitePackages pystray
    if ($LASTEXITCODE -ne 0) { throw "pystray 安装失败" }
    Ok "依赖已装入 $sitePackages"
}

# --- 3. verify -------------------------------------------------------------

if ($SkipVerify) {
    Step "3. 验证运行时（--SkipVerify，已跳过）"
    Write-Host "  警告：跳过了验证。发布构建不要这么做。" -ForegroundColor Yellow
} else {
    Step "3. 验证运行时真的能工作"
    Info '不是「能不能 import」，而是「能不能识别」。'
    $env:PYTHONIOENCODING = "utf-8"
    Push-Location $Root
    try {
        & (Join-Path $Runtime "python.exe") "packaging\verify_runtime.py"
        if ($LASTEXITCODE -ne 0) { throw "运行时验证失败 —— 不要发布这个构建。" }
    } finally { Pop-Location }
    Ok "运行时可用"
}

# --- 4. stage --------------------------------------------------------------

Step "4. 组装发布载荷"

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Info "运行时 → runtime\"
Copy-Item $Runtime (Join-Path $Stage "runtime") -Recurse

Info "后端 → backend\"
Copy-Item (Join-Path $Root "backend") (Join-Path $Stage "backend") -Recurse
# Test fixtures and bytecode are not part of a product.
Get-ChildItem (Join-Path $Stage "backend") -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Remove-Item (Join-Path $Stage "backend\tests") -Recurse -Force -ErrorAction SilentlyContinue

Info "引擎与安装脚本 → packaging\"
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "packaging\engine") | Out-Null
Copy-Item (Join-Path $Root "packaging\engine\maslingo_engine.py") (Join-Path $Stage "packaging\engine")
Copy-Item (Join-Path $Root "packaging\verify_runtime.py") (Join-Path $Stage "packaging")

# The weights travel inside the installer. Downloading them on first run would
# make the engine look broken on a machine without internet, and the spec is
# explicit that a packaging omission must not be what breaks OCR.
#
# Staged as a plain directory, not as the HuggingFace cache. The cache keeps every
# file twice — `blobs/` plus a `snapshots/` copy, because Windows only makes
# symlinks with Developer Mode on — and the first build shipped 2541 MB of model
# for 847 MB of weights. The backend loads a bundled directory directly.
Info "OCR 模型 → models\"
$modelDir = Join-Path $Stage "models\manga-ocr-base"
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

# Pick a snapshot that is actually complete, not the first one listed.
#
# The cache held two: an incomplete download whose only entry was a dangling
# symlink, and the good one. Taking the first produced a model directory with no
# config.json, whereupon the backend silently falls back to downloading from
# HuggingFace — which works on a build machine with internet and fails on a
# user's machine, at first OCR, with a connection timeout. A snapshot qualifies
# only if it has both the config and a real weights file.
$snapshotRoot = Join-Path $hfCache "hub"
$candidates = Get-ChildItem $snapshotRoot -Directory -Filter "models--kha-white--*" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "snapshots" } |
    Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue }

$snapshot = $null
foreach ($candidate in $candidates) {
    $hasConfig = Test-Path (Join-Path $candidate.FullName "config.json")
    # Matched by name, not by size. The cache stores the weights as symlinks and
    # a symlink reports Length 0, so a size test here rejects the one snapshot that
    # is actually complete. Whether the target is real is decided after the copy,
    # where the files are real files.
    $hasWeights = Get-ChildItem $candidate.FullName -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @("model.safetensors", "pytorch_model.bin") }
    if ($hasConfig -and $hasWeights) {
        $snapshot = $candidate
        break
    }
    Info "跳过不完整的快照 $($candidate.Name)"
}
if (-not $snapshot) {
    throw "在 $snapshotRoot 里找不到完整的 manga-ocr 快照（需要 config.json 与权重文件）。先跑一次后端让下载完成。"
}
Ok "使用快照 $($snapshot.Name)"

Copy-Item (Join-Path $snapshot.FullName "*") $modelDir -Recurse -Force
# Follow the links ourselves: the cache stores weights as symlinks into blobs/,
# and Copy-Item -Recurse is inconsistent about materialising them. Copying the
# target explicitly is what makes the staged directory self-contained.
foreach ($link in Get-ChildItem $snapshot.FullName -File -Force |
        Where-Object { $_.LinkType -and $_.Target }) {
    $target = $link.Target | Select-Object -First 1
    if ($target -and (Test-Path $target)) {
        Copy-Item $target (Join-Path $modelDir $link.Name) -Force
    }
}

# The backend refuses a directory without this, and falling back to the network
# is the failure mode this whole block exists to prevent.
if (-not (Test-Path (Join-Path $modelDir "config.json"))) {
    throw "模型目录里没有 config.json —— 后端会拒绝加载这个目录并改为联网下载"
}
$weightFiles = Get-ChildItem $modelDir -File | Where-Object { $_.Length -gt 1MB }
if (-not $weightFiles) { throw "模型目录里没有权重文件（$modelDir）" }

$modelSize = (Get-ChildItem $modelDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Ok "模型 $([math]::Round($modelSize/1MB)) MB（一份，不是三份）"
Get-ChildItem $modelDir -File | ForEach-Object { Info "  $($_.Name)" }

$stageSize = (Get-ChildItem $Stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
Ok "载荷 $([math]::Round($stageSize/1MB)) MB"

# --- 5. installer ----------------------------------------------------------

Step "5. 编译安装包"
$iss = Join-Path $Root "packaging\maslingo.iss"
& $Iscc "/DStageDir=$Stage" "/DAppVersion=$Version" $iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败（退出代码 $LASTEXITCODE）" }

$setup = Join-Path $Root "build\output\MasLingo-Setup-$Version.exe"
if (-not (Test-Path $setup)) { throw "没有生成 $setup" }
Ok "安装包 $([math]::Round((Get-Item $setup).Length/1MB)) MB"
Write-Host "`n$setup" -ForegroundColor Green
