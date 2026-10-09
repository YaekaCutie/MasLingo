<#
.SYNOPSIS
    安装后体检：逐项验证 MasLingo 是否真的装好了。

.DESCRIPTION
    跑一次就知道哪一项过、哪一项没过，以及没过时该看哪里。

    这是给"手动测试"用的，不是给 CI 用的：它只读不写，不改任何状态，所以可以
    反复跑。每一步都打印它实际测到的东西，而不是只说 ok —— 一条只说"通过"的
    体检没有任何诊断价值。

    用法（装完安装包之后）：
        pwsh packaging\selftest.ps1

    卸载之后再跑一次，应当报告"未安装"而不是一堆失败。
#>
[CmdletBinding()]
param(
    [int]$Port = 8001,
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\MasLingo"
)

$pass = 0
$fail = 0
$skip = 0

function Check($name, $ok, $detail) {
    if ($ok) {
        Write-Host "  ok    $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL  $name" -ForegroundColor Red
        $script:fail++
    }
    if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
}

function Info($text) { Write-Host "        $text" -ForegroundColor DarkGray }
function Section($text) { Write-Host "`n$text" -ForegroundColor Cyan }

Write-Host "MasLingo 安装体检" -ForegroundColor White
Info "安装目录 $InstallDir"
Info "端口     $Port"

# --- 1. 文件 ---------------------------------------------------------------

Section "1. 程序文件"

if (-not (Test-Path $InstallDir)) {
    Check "安装目录存在" $false $InstallDir
    Write-Host "`n未检测到安装。如果你还没运行安装包，这是正常的。" -ForegroundColor Yellow
    Write-Host "安装包：build\output\MasLingo-Setup-1.1.5.exe"
    exit 2
}
Check "安装目录存在" $true $InstallDir

$expected = @(
    "runtime\python.exe",
    "runtime\pythonw.exe",
    "runtime\Lib\site-packages\torch\__init__.py",
    "runtime\Lib\site-packages\manga_ocr\__init__.py",
    "backend\app.py",
    "backend\ocr\manga_ocr_engine.py",
    "packaging\engine\maslingo_engine.py",
    "models\manga-ocr-base\config.json"
)
$missing = @()
foreach ($rel in $expected) {
    if (-not (Test-Path (Join-Path $InstallDir $rel))) { $missing += $rel }
}
Check "关键文件齐全（$($expected.Count) 项）" ($missing.Count -eq 0) $(if ($missing) { "缺失：" + ($missing -join ", ") } else { "全部存在" })

# The weights are the one thing a packaging slip silently omits, and the backend
# then falls back to a network download rather than failing loudly.
$weights = @()
if (Test-Path (Join-Path $InstallDir "models\manga-ocr-base")) {
    $weights = Get-ChildItem (Join-Path $InstallDir "models\manga-ocr-base") -File |
        Where-Object { $_.Length -gt 100MB }
}
Check "OCR 权重已随包分发（不是靠首次联网下载）" ($weights.Count -gt 0) `
    $(if ($weights) { "$($weights[0].Name)  $([math]::Round($weights[0].Length/1MB)) MB" } else { "models\manga-ocr-base 下没有大于 100MB 的权重文件" })

$size = (Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
Info "安装体积 $([math]::Round($size/1MB)) MB（预期约 1500 MB）"

# --- 2. 引擎 ---------------------------------------------------------------

Section "2. 本地引擎"

$procs = Get-Process pythonw, python -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -like "$InstallDir*" } catch { $false }
}
Check "引擎进程在运行" ($procs.Count -gt 0) `
    $(if ($procs) { "pid " + ($procs.Id -join ", ") + "  $($procs[0].Path)" } else { "没有来自 $InstallDir 的 pythonw.exe 进程" })

if ($procs.Count -gt 1) {
    Check "只有一个引擎实例" $false "发现 $($procs.Count) 个 —— 多实例会争抢端口和模型"
}

$health = $null
try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5 } catch {}
Check "健康检查通过（127.0.0.1:$Port）" ($null -ne $health -and $health.ok) `
    $(if ($health) { $health | ConvertTo-Json -Compress } else { "无响应。看日志：$env:LOCALAPPDATA\MasLingo\logs\engine.log" })

if ($health) {
    Check "OCR 后端已就绪" ($health.backend -eq "ready") "backend=$($health.backend) ocr=$($health.ocr)"
}

# Listening on loopback only. The spec requires the port not be exposed to the
# LAN; a `0.0.0.0` bind would be invisible in every functional test.
$lan = $false
try {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port }
    $lan = ($listeners | Where-Object { $_.Address.ToString() -notin @("127.0.0.1", "::1") }).Count -gt 0
} catch {}
Check "只监听回环地址（不对局域网暴露）" (-not $lan) `
    $(if ($lan) { "端口 $Port 在非回环地址上也有监听" } else { "仅 127.0.0.1" })

# --- 3. 开机自启动 ---------------------------------------------------------

Section "3. 开机自启动"

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$value = $null
try { $value = (Get-ItemProperty $runKey -Name MasLingo -ErrorAction Stop).MasLingo } catch {}
Check "已注册开机自启动（HKCU，免管理员）" ($null -ne $value) `
    $(if ($value) { $value } else { "未注册。可在托盘里打开，或：pythonw.exe packaging\engine\maslingo_engine.py --autostart on" })

if ($value) {
    Check "启动项指向本次安装（不是旧路径）" ($value -like "*$InstallDir*") `
        "如果指向别处，说明是上一次安装留下的残留"
    Check "用 pythonw.exe 启动（不会弹控制台窗口）" ($value -like "*pythonw.exe*") $value
}

# The uninstaller's cross-process stop. A stale file here kills the next engine a
# second after it becomes healthy, which is close to undiagnosable.
$stale = Join-Path "$env:LOCALAPPDATA\MasLingo" "shutdown.request"
Check "没有遗留的停止请求" (-not (Test-Path $stale)) `
    $(if (Test-Path $stale) { "存在 $stale —— 下次启动引擎会被它杀掉（当前版本会自动清理，但先删掉更稳妥）" } else { "干净" })

# --- 4. 日志 ---------------------------------------------------------------

Section "4. 日志"

$log = "$env:LOCALAPPDATA\MasLingo\logs\engine.log"
if (Test-Path $log) {
    $content = Get-Content $log -ErrorAction SilentlyContinue
    $errors = $content | Select-String -Pattern "ERROR|Traceback" | Select-Object -Last 5
    Check "日志文件存在" $true "$log（$($content.Count) 行）"
    Check "日志里没有 ERROR" ($errors.Count -eq 0) `
        $(if ($errors) { "最近 5 条：" + (($errors | ForEach-Object { $_.Line.Trim() }) -join " | ") } else { "无错误" })
    $restarts = $content | Select-String -Pattern "准备按退避策略重启" | Measure-Object
    if ($restarts.Count -gt 0) {
        Info "日志里有 $($restarts.Count) 次重启记录（上限 3 次/10 分钟）"
    }
} else {
    Check "日志文件存在" $false "$log 不存在 —— 引擎可能从未成功启动过"
}

# --- 5. 扩展 ---------------------------------------------------------------

Section "5. 浏览器扩展"

$extId = "fmlpeclkcmhnfefefnneejffmopcenbm"
$extPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "extension"
if (Test-Path $extPath) {
    Info "扩展源码：$extPath"
    Info "已上架商店时用商店安装；未上架时在 chrome://extensions 打开开发者模式 →"
    Info "「加载已解压的扩展程序」→ 选择上面这个目录。"
} else {
    Info "没找到扩展目录（$extPath），跳过。"
}

Check "扩展无需本体检脚本验证" $true "在浏览器里手动确认：面板右上角后端圆点是否为绿色"

# --- 汇总 -----------------------------------------------------------------

Write-Host ""
if ($fail -eq 0) {
    Write-Host "全部通过（$pass 项）" -ForegroundColor Green
    Write-Host "`n下一步：在浏览器里确认扩展能连上引擎，然后做一次真实的框选翻译。"
    exit 0
} else {
    Write-Host "$fail 项失败，$pass 项通过" -ForegroundColor Red
    Write-Host "`n按上面每条 FAIL 后面给出的路径排查。日志：$log"
    exit 1
}
