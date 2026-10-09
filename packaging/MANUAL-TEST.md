# MasLingo 手动测试手册

按顺序做，每一步都写清了**做什么**、**期望看到什么**、**不对时看哪里**。

总时长：阶段 1–4 约 15 分钟，阶段 5–7 各 5 分钟。

---

## 准备

**1. 确认 8001 端口空闲。** 开发用的后端如果还开着，装好的引擎会拒绝启动（这是设计如此，不是 bug）。

```powershell
try { Invoke-RestMethod http://127.0.0.1:8001/health -TimeoutSec 3 } catch { "空闲" }
```

有输出说明有后端在跑，先停掉它。

**2. 确认安装包在。**

```powershell
Get-Item build\output\MasLingo-Setup-1.1.5.exe
```

---

## 阶段 1：安装

双击 `build\output\MasLingo-Setup-1.1.5.exe`。

| 向导页 | 你要做的 | 期望看到 |
|---|---|---|
| 选择任务 | — | 「登录 Windows 时自动启动本地引擎」**默认勾选** |
| 检测浏览器 | 只读 | 显示检测到的 Chrome 路径，或说明未检测到 |
| （安装中） | 等待 | 约 1500 MB，**需要几分钟**。这是正常的，不是卡住 |
| 安装 Chrome 扩展 | **先别急着点下一步** | 这一段明确告诉你扩展需要你自己在 Chrome 里确认 |
| 完成 | 勾选「启动本地引擎」 | — |

**注意**：不要勾「创建桌面快捷方式」除非你想要，默认不勾。

### 不对时

- 报「端口 8001 被占用」→ 回到准备步骤 1
- 中途失败 → 看 `%LOCALAPPDATA%\MasLingo\logs\engine.log`

---

## 阶段 2：体检（最快发现问题的一步）

```powershell
pwsh packaging\selftest.ps1
```

它会逐项检查文件完整性、引擎进程、健康检查、是否只监听回环、开机启动项、遗留停止请求、日志有无错误。

**期望：`全部通过`，退出码 0。**

几个容易误判的点：

| 输出 | 含义 |
|---|---|
| `FAIL 引擎进程在运行` | 安装结束时的健康检查可能还在等模型加载。等 60 秒再跑一次 |
| `FAIL 健康检查通过` | 看日志。第一次启动要加载 424 MB 权重，需要几十秒 |
| `FAIL 只监听回环地址` | 真的有问题，引擎不该对局域网暴露 |
| `FAIL 日志里没有 ERROR` | 看它打印的具体行 |

---

## 阶段 3：安装浏览器扩展

**当前没有上架 Chrome Web Store**，所以走开发者模式加载。这是过渡方案，不是最终形态。

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择 `C:\Users\NFGas\Downloads\MasLingo\extension`

**期望**：列表里出现 MasLingo，**没有红色错误**。

> 如果你之前从 `OpenMangaTranslator` 目录加载过，那个条目已经失效（文件夹改名了），先删掉它。

**注意扩展 ID**：开发者模式加载的 ID 由路径决定，改名会变。打包分发用的 `extension.pem` 固定为 `fmlpeclkcmhnfefefnneejffmopcenbm`，两者不同是正常的。

---

## 阶段 4：端到端翻译

1. 打开一个漫画页面（本地的 `testdata\real` 里的图，或任意日文漫画网站）
2. 看右下角悬浮面板

| 检查项 | 期望 |
|---|---|
| 后端圆点 | **绿色**，提示「后端正常」 |
| 翻译圆点 | 取决于你有没有配 API Key；没配是正常的 |
| 框选翻译 | 点它，在画面上拖一个框 |
| 识别结果 | 框内出现日文原文，随后出现译文（若配了翻译） |
| 右下角状态窗 | 显示「正在识别…」→「翻译完成」，几秒后淡出 |

**这一项是真正的验收**：它同时验证了引擎、模型、端口、扩展、坐标映射五件事。

### 不对时

- 后端圆点红色 → `pwsh packaging\selftest.ps1`
- 圆点绿色但框选没反应 → F12 看 Console 有没有报错
- 识别出乱码 → 说明模型加载了但推理异常，看日志

---

## 阶段 5：重启测试（验收标准 5，**不能跳过**）

这是整个方案的核心承诺，只能靠真实重启验证。

1. **重启 Windows**
2. 登录后**什么都不要做**，等 30 秒
3. 打开 Chrome，看面板的后端圆点

**期望**：不需要任何手动操作，圆点直接是绿色。

### 更快的替代（不重启）

先手动结束引擎，再模拟登录时的启动：

```powershell
# 结束引擎
Get-Process pythonw | Where-Object { $_.Path -like "*MasLingo*" } | Stop-Process -Force

# 用启动项里的原样命令启动（这就是登录时 Windows 会做的事）
$cmd = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name MasLingo).MasLingo
& cmd /c $cmd
```

等 60 秒后跑 `selftest.ps1`。

### 不对时

```powershell
# 启动项在不在
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name MasLingo).MasLingo
```

没有输出 → 重新运行安装包并勾选自启动，或从托盘的「开机自动启动」打开。

---

## 阶段 6：故障场景（验收标准 6 和 7）

### 6a. 杀掉引擎，扩展应当如实报红

```powershell
Get-Process pythonw | Where-Object { $_.Path -like "*MasLingo*" } | Stop-Process -Force
```

**期望**：扩展在约 60 秒内（退避上限）把圆点变红，提示「本地引擎未连接」——**不是**一直显示绿色。

### 6b. 引擎应当自动重启吗？

这里有个设计取舍要说清楚：**引擎被杀掉后不会自己回来**，因为重启逻辑管的是「uvicorn 线程崩了」，不是「进程被杀」。进程没了就没人监督了——下次登录才会重新启动。

如果你杀的是线程级别的故障（难以手动模拟），它会按 3 次/10 分钟、退避 2s→8s→30s 重启，超出后**停下来并保留日志**，不会无限重启。

### 6c. 端口被占用（验收标准 7）

```powershell
# 占住 8001
$lock = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 8001)
$lock.Start()
# 另开一个窗口，尝试启动引擎
& "$env:LOCALAPPDATA\Programs\MasLingo\runtime\pythonw.exe" `
  "$env:LOCALAPPDATA\Programs\MasLingo\packaging\engine\maslingo_engine.py" --no-tray
```

**期望**：打印「MasLingo 引擎已在运行，未启动第二个实例。（端口 8001 已被占用…）」并以退出码 **0** 结束——不是崩溃，也不是默默启动第二个。

记得释放：

```powershell
$lock.Stop()
```

### 6d. 引擎应该只监听回环

```powershell
netstat -ano | Select-String ":8001"
```

**期望**：只有 `127.0.0.1:8001`。出现 `0.0.0.0:8001` 是安全问题（任意网页都能调用你的 OCR）。

---

## 阶段 7：卸载（验收标准 8 和 9）

### 7a. 重复安装不重复建启动项

**先跑一次 `selftest.ps1` 记下通过项数**，然后**再运行一次同一个安装包**。

```powershell
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name MasLingo).MasLingo
```

**期望**：启动项只有一条，内容不变（不是两条，也不是叠加的路径）。

### 7b. 卸载

设置 → 应用 → MasLingo → 卸载。

**期望顺序**：
1. 引擎被停止（进程消失，8001 释放）
2. 开机启动项被移除
3. 程序文件被删除
4. **弹出对话框问你是否保留配置与日志，默认「否」**

先选**「否」**（保留），然后检查：

```powershell
Test-Path "$env:LOCALAPPDATA\MasLingo\logs\engine.log"   # 应当 True
Test-Path "$env:LOCALAPPDATA\Programs\MasLingo"          # 应当 False
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name MasLingo -ErrorAction SilentlyContinue)
```

启动项应当查不到。

### 7c. 卸载后不复活

**卸载后重启一次 Windows**，再登录，确认 8001 是空的、没有 pythonw 进程。这一条容易漏——启动项没清干净的话，下次登录会把半卸载的引擎拉起来。

---

## 干净环境（验收标准 1、2、3）

上面全程在**你这台机器**上做，它**不算干净环境**——不过比预想的好：本机没有真正的 Python（只有 WindowsApps 的商店占位符），所以「用户没装 Python 也能用」这一点在本机基本成立，只是不够严格。

要真正满足验收标准 1，需要一个**全新 Windows 虚拟机**（Hyper-V 或 VirtualBox，Windows 11 评估版即可）：

1. 装好系统，**不要装** Python、Git、VS Code、Node
2. 把 `MasLingo-Setup-1.1.5.exe` 拷进去（576 MB，用共享文件夹或 U 盘）
3. 跑安装包 → 跑 `selftest.ps1`（需要 PowerShell，系统自带）
4. 按阶段 3–7 走一遍

**磁盘空间**：装完约 1.5 GB，加上安装包本身，留 4 GB 以上。

要我现在就按这个流程在本机跑一遍阶段 1–4 吗？阶段 5–7 需要你重启机器，我做不到。
