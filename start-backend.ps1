$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$Python=Join-Path $Root ".venv\Scripts\python.exe"
if(!(Test-Path $Python)){Write-Host "未找到 .venv，请先创建虚拟环境并安装 requirements.txt"; exit 1}
& $Python -m uvicorn backend.app:app --host 127.0.0.1 --port 8001