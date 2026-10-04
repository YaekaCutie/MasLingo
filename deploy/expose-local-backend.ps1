<#
.SYNOPSIS
    把本机运行的 OCR 后端通过 Tailscale Funnel 暴露到公网。

.DESCRIPTION
    这是「不填信用卡」的托管方案。Tailscale 个人版 $0、注册不需要支付方式，
    Funnel 官方说明「available for all plans」，公网地址形如
    https://<机器名>.<tailnet>.ts.net，重启后不变。

    代价只有一个：你的电脑要开着，tailscaled 要在跑。

    一次性准备：
      1. 安装 Tailscale 并登录  https://tailscale.com/download
      2. 首次执行本脚本时，tailscale funnel 会弹出一个网页让你确认启用 Funnel；
         Tailscale 会自动申请 HTTPS 证书并把 funnel 属性写进 tailnet 策略文件。

.PARAMETER Port
    本机后端端口，默认 8001。

.PARAMETER SkipBackend
    不检查（也不提示启动）本机后端，只配置 Funnel。

.PARAMETER ExtensionRepo
    项目路径，用于打印 configure_hosted_backend.py 的完整命令。

.EXAMPLE
    .\deploy\expose-local-backend.ps1
    .\deploy\expose-local-backend.ps1 -Port 8001 -WhatIf

.NOTES
    官方文档（2026-01 校验）：
      https://tailscale.com/docs/features/tailscale-funnel
    限制：只能用 <tailnet>.ts.net 域名；只能监听 443 / 8443 / 10000；
    只走 TLS；带宽有不可配置的上限；DNS 生效最多需要 10 分钟。
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [int]$Port = 8001,
    [switch]$SkipBackend,
    [string]$ExtensionRepo = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Info($text) { Write-Host "    $text" }
function Fail($text) {
    Write-Host "`n!! $text" -ForegroundColor Red
    exit 1
}

# --- 1. Tailscale 装了吗 ----------------------------------------------------
Write-Step '检查 Tailscale'
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) {
    Fail @'
没有找到 tailscale 命令。
先安装并登录（免费、不需要信用卡）：https://tailscale.com/download
装好后重开一个终端再跑本脚本。
'@
}
Write-Info "tailscale: $($tailscale.Source)"

# --- 2. 拿到 tailnet 域名 ---------------------------------------------------
Write-Step '读取 tailnet 域名'
try {
    $status = (& tailscale status --json 2>$null | Out-String) | ConvertFrom-Json
} catch {
    Fail "tailscale status 失败，通常是还没登录。先执行：tailscale up"
}

$dnsName = $status.Self.DNSName
if ([string]::IsNullOrWhiteSpace($dnsName)) {
    Fail '拿不到 tailnet 域名（Self.DNSName 为空）。先执行 tailscale up 完成登录。'
}
$dnsName = $dnsName.TrimEnd('.')
$publicUrl = "https://$dnsName"
Write-Info "公网地址将是: $publicUrl"

# --- 3. 本机后端在跑吗 ------------------------------------------------------
$localHealth = "http://127.0.0.1:$Port/health"
if (-not $SkipBackend) {
    Write-Step "检查本机后端 127.0.0.1:$Port"
    $healthy = $false
    try {
        $health = Invoke-RestMethod -Uri $localHealth -TimeoutSec 5
        if ($health.ok) { $healthy = $true }
    } catch {
        $healthy = $false
    }
    if (-not $healthy) {
        Fail @"
本机后端没有在 $localHealth 上响应。
先在另一个窗口启动它：

    .\start-backend.ps1

等它打印出 Uvicorn running 之后再跑本脚本。
"@
    }
    Write-Info "后端正常: ocr=$($health.ocr) concurrency=$($health.concurrency)"
} else {
    Write-Info '按要求跳过后端检查'
}

# --- 4. 开 Funnel -----------------------------------------------------------
Write-Step "启用 Funnel 指向 127.0.0.1:$Port"
if ($PSCmdlet.ShouldProcess($publicUrl, 'tailscale funnel --bg')) {
    & tailscale funnel --bg $Port
    if ($LASTEXITCODE -ne 0) {
        Fail @'
tailscale funnel 执行失败。
常见原因：tailnet 没启用 HTTPS 证书，或当前用户没有 funnel 节点属性。
在 https://console.tailscale.com/admin/acls 的 Funnel 一节点
「Add Funnel to policy」，然后重试。
'@
    }
}

# --- 5. 验证（DNS 最多要 10 分钟，所以只警告不失败） ------------------------
Write-Step '验证公网地址'
$verified = $false
for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $remote = Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 10
        if ($remote.ok) { $verified = $true; break }
    } catch {
        Write-Info "第 $attempt 次还连不上（证书签发 / DNS 传播中）"
    }
    Start-Sleep -Seconds 10
}

if ($verified) {
    Write-Host "`n公网后端可用: $publicUrl" -ForegroundColor Green
} else {
    Write-Host "`n还连不上 $publicUrl" -ForegroundColor Yellow
    Write-Info 'Tailscale 官方说明公有 DNS 记录最多需要 10 分钟生效，稍后用浏览器或 curl 再试：'
    Write-Info "  curl $publicUrl/health"
    Write-Info '仍然不通就检查 tailscale funnel status 与 https 证书设置。'
}

# --- 6. 下一步 --------------------------------------------------------------
Write-Host @"

接下来把扩展指向它（改 config.js、收窄 host_permissions、重新打包）：

    python deploy/configure_hosted_backend.py $publicUrl --version 1.0.3 --pack extension.pem

常用命令：
    tailscale funnel status     # 看当前映射
    tailscale funnel reset      # 关掉所有 Funnel

注意：这是「你的电脑当服务器」的方案——电脑关机 / 休眠 / 退出 Tailscale，
所有用户就都用不了了。想让扩展在连不上时回退，用户仍可在扩展设置里
把后端地址填成本机 127.0.0.1:8001。
"@ -ForegroundColor Gray
