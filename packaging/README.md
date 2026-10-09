# MasLingo 桌面版打包与安装

面向普通 Windows 用户：下载一个 `MasLingo-Setup.exe`，装完即用，不需要 Python、终端、虚拟环境，也不需要每次手动启动后端。

---

## 1. 选型与理由

### 安装器：Inno Setup 6

| 候选 | 结论 |
|---|---|
| **Inno Setup 6** | **选用**。载荷接近 2 GB，NSIS 的 2 GB 上限太紧；Inno 原生支持免管理员安装、完整卸载器、Pascal 脚本可做真实的健康检查与 Chrome 检测。 |
| NSIS | 体积上限风险，脚本能力弱于 Inno 的 Pascal 层。 |
| WiX | 功能足够，但 XML 样板量与本项目的规模不匹配，改一版成本高。 |

### Python 运行时：官方 embeddable 发行版，不是 PyInstaller，也不是 venv

这是整个方案里最关键的一个决定，三条路都实测过：

- **venv 不可用。** venv 的 `pyvenv.cfg` 记录的是构建机上基础 Python 的**绝对路径**，`Scripts\*.exe` 里也嵌了路径。拷到用户机器上目标目录不存在，直接废掉。
- **PyInstaller 风险高。** torch 在 PyInstaller 下的 hidden import 与 DLL 收集是长期痛点，且产物是单文件时每次启动要解压约 1 GB 到临时目录。
- **embeddable 发行版可用**，它就是为"可拷贝分发"设计的。实测在 `C:\Users\NFGas\Downloads\测试 目录\MasLingo Engine\`（**含中文和空格**、无 venv、无任何环境变量）下完整跑通导入、检测、识别。

需要改动的地方只有一处：`python312._pth` 必须加上 `Lib\site-packages` 并启用 `import site`，否则第三方包根本不在 `sys.path` 上，而依赖 `.pth` 文件的包也不会生效。

### 托盘：pystray，不额外引入 exe

托盘图标是 pystray + Pillow，跑在同一个进程里。这样**不需要为启动器再打一个 exe**，也避免了子进程持有 8001 端口变成孤儿——父进程死了它还活着，下次登录就发现端口被一个够不着的引擎占着。

---

## 2. 依赖裁剪：1770 MB → 1104 MB

开发用的 `.venv` 有 **1770 MB**，但后端从没 import 过其中一大半。追依赖图发现一整条挂在不存在的需求上的链：

```
paddlex → modelscope → opencv-contrib-python, pandas → paddle
```

`backend/` 一个都没用到。实测体积：paddle 372 MB、cv2 121 MB、pandas 60 MB、modelscope 47 MB——**约 600 MB 纯属白带**。

真正需要的（从源码读出来的 `import`，不是猜的）：

```
fastapi, starlette, pydantic, huggingface_hub, manga_ocr, PIL, numpy, torch
```

`packaging/runtime-requirements.txt` 把版本全部钉死，包含 torch——它是安装包里最大的单个组件，一次不锁的升级就是几百 MB 的意外。

**实测结果：**

| 运行时 | 体积 |
|---|---|
| 开发 `.venv` | 1770 MB |
| **发布运行时** | **1104 MB** |

其中 torch 502 MB（确认是 CPU 版，CUDA DLL 为 0）、unidic_lite 248 MB、transformers 98 MB。

`unidic_lite` 那 248 MB **不能省**：manga-ocr 的 `BertJapaneseTokenizer` 走 `MecabTokenizer`，需要 fugashi 和一个 mecab 词典。移除后报 `ModuleNotFoundError: You need to install fugashi to use MecabTokenizer`，识别直接失败。

---

## 3. 目录结构

### 构建产物

```
build/
  runtime/                 可迁移的 Python 3.12.10 + 全部依赖（1104 MB）
  stage/                   发布载荷
    runtime/               → 装到 {app}\runtime
    backend/               FastAPI 应用（去掉 tests 与 __pycache__）
    packaging/
      engine/maslingo_engine.py
      verify_runtime.py
    models/hub/            MangaOCR 权重（847 MB）
  output/
    MasLingo-Setup-1.1.5.exe
```

### 用户机器上

```
%LOCALAPPDATA%\Programs\MasLingo\        程序（免管理员，全在当前用户下）
  runtime\python.exe / pythonw.exe
  runtime\Lib\site-packages\
  backend\app.py
  packaging\engine\maslingo_engine.py
  models\hub\                             OCR 权重，随安装包分发

%LOCALAPPDATA%\MasLingo\                 用户数据（卸载时询问是否保留）
  logs\engine.log
  settings.json                          含翻译 API Key
  engine-stopped.flag
  shutdown.request
```

---

## 4. 构建

```powershell
winget install -e --id JRSoftware.InnoSetup
pwsh packaging\build.ps1
```

脚本幂等，可重复运行，每一步都检测是否已完成：

| 步骤 | 内容 |
|---|---|
| 1 | 下载 embeddable Python 并配置 `._pth` |
| 2 | 把钉死版本的依赖装进 `Lib\site-packages` |
| 3 | **验证运行时真的能识别**（不是"能 import"） |
| 4 | 组装载荷并报告体积 |
| 5 | 用 ISCC 编译安装包 |

参数：`-SkipRuntime`（复用现有运行时，改安装器/引擎时用）、`-SkipVerify`（**发布不要用**）、`-Version`。

发布构建用最高压缩：

```powershell
& "ISCC.exe" "/DCompression=lzma2/max" packaging\maslingo.iss
```

默认用 `lzma2/normal`：载荷基本都是已压缩数据（safetensors、DLL、pyc），`max` 花的时间远多于它省下的体积。

### 第 3 步为什么必须存在

打包真正的风险不是"脚本报错"，而是**构建成功但用户第一次识别就失败**。缺模型缓存、缺 mecab 词典的运行时都能正常 import。所以验证脚本走完整路径——解码、检测、识别——并按真实结果退出。

它同时区分了两件事：**运行时能不能读出日文**（打包问题），与**生产置信度过滤器是否采纳**（质量问题，由后端测试覆盖）。第一版把后者也断言进来，结果检测器给出一个整页大小的区域、置信度 0.25 被丢弃时，一个完全正常的运行时报了 FAIL。

---

## 5. 生产环境的启动流程

```
Windows 登录
  └─ HKCU\...\Run 里的 MasLingo
       └─ pythonw.exe packaging\engine\maslingo_engine.py
            ├─ 探测 8001：已占用 → 打印说明并退出 0（不启第二个实例）
            ├─ 清理遗留的 shutdown.request
            ├─ 在后台线程里启动 uvicorn（127.0.0.1:8001）
            ├─ 托盘图标（绿=正常 / 黄=启动中 / 红=故障 / 灰=已停止）
            └─ 监听 shutdown.request，收到就退出
```

Chrome 扩展启动时主动探测 `http://127.0.0.1:8001/health`，只有拿到真实响应才显示绿色。

### 崩溃与重启

最多 **3 次 / 10 分钟**，退避 2s → 8s → 30s。超出后**停止自动重启**，托盘保持红色并写明原因，日志记录完整错误。规格明确禁止无限重启，也禁止静默吞错——一个静默的崩溃循环比一个停下来的引擎更难诊断。

用户从托盘点"退出引擎"会写 `engine-stopped.flag`，且**不会**被自启动立刻拉回来。

---

## 6. Chrome 扩展：能做什么，不能做什么

**必须先说清楚：桌面安装程序无法把扩展静默装进普通消费者的 Chrome。** 这不是本项目的疏漏，是 Chrome 的分发机制决定的。三条官方渠道：

| 渠道 | 适用 | 本项目 |
|---|---|---|
| Chrome Web Store | 所有用户，**需用户点"添加至 Chrome"并确认** | **当前未上架** |
| Enterprise Policy / force-install | **仅受组织策略管理的设备** | 不适用，且规格禁止默认改普通消费者设备的策略 |
| 开发者模式加载已解压扩展 | 仅开发调试 | 不作为消费者方案 |

因此当前走的是**过渡方案**：安装向导检测 Chrome → 装好引擎并通过健康检查 → 引导用户到扩展获取页 → **明确告知需要用户自己确认安装** → 装完扩展自动检测引擎并连接。

向导里的原文：

> 本地引擎已经安装完成。浏览器扩展需要单独安装，而且必须由你在 Chrome 里确认一次——桌面安装程序无法替你把扩展静默装进普通 Chrome，这是 Chrome 本身的限制，不是本程序的遗漏。

**从开发阶段到上架的迁移**：`extension.pem` 固定了扩展 ID `fmlpeclkcmhnfefefnneejffmopcenbm`，上架后 ID 不变，所以 Native Messaging 注册、存储键、任何按 ID 绑定的逻辑都不用改。上架后只需把 `maslingo.iss` 里 `CHROME_STORE_URL` 换成真实的商店详情页，引导页文案改成"点击添加至 Chrome"。

---

## 7. 开机自启动

**实现**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `MasLingo` 值，写的是

```
"{app}\runtime\pythonw.exe" "{app}\packaging\engine\maslingo_engine.py"
```

选 `pythonw.exe` 而不是 `python.exe`：**不能弹控制台窗口**。

选 HKCU 而不是 HKLM、选启动项而不是 Windows 服务：规格要求不默认需要管理员权限。用户级启动项不需要，卸载时清理也简单。

**写入者是引擎自己**（`--autostart on`），不是安装器。这样托盘上的开关和卸载时的清理不可能对"当前是什么状态"产生分歧——只有一个写入者。

**关闭方式**（三种，等价）：
- 安装向导里取消勾选"登录 Windows 时自动启动本地引擎"
- 托盘右键 → "开机自动启动"（勾选状态即真实状态）
- 命令行 `pythonw.exe maslingo_engine.py --autostart off`

---

## 8. 日志、修复、升级、卸载

### 日志

`%LOCALAPPDATA%\MasLingo\logs\engine.log`，托盘"打开日志"直接开这个目录。

### 修复与重试

重新运行同一个安装包即可。`AppId` 是固定 GUID，Inno 认得出已有安装，走升级流程而不是装第二份。启动项是**覆盖写**，不会重复。

### 升级保留

`%LOCALAPPDATA%\MasLingo\` 不在 `{app}` 下，升级不碰它：用户配置、API Key、自启动设定、日志全部保留。

### 卸载

1. `--autostart off` —— 先摘启动项，否则下次登录会把半卸载的引擎拉起来
2. `--shutdown` —— 通过请求文件让运行中的引擎退出（跨进程、对早先登录启动的实例同样有效）
3. 删除程序文件
4. **询问**是否删除配置与日志，默认选"否"

不删除用户从商店安装的扩展，也不会替用户决定——这不在安装器的权限范围内。

---

## 9. 验证状态（**如实标注**）

### 已实测通过

| 项目 | 证据 |
|---|---|
| 运行时能 import / 检测 / 识别 | `verify_runtime.py` 全绿 |
| **可迁移性** | 复制到 `...\测试 目录\MasLingo Engine\`（中文+空格），无 venv、无环境变量，完整跑通 |
| 单实例保护 | 第二个实例打印明确原因并以 0 退出；端口不被抢占 |
| 健康检查 | `/health` 返回 `{"ok":true,"backend":"ready",...}`；`--check` 正确报告可达/不可达 |
| 开机启动项读写 | on → on → off → off（HKCU，无管理员） |
| 停止请求 | 运行中收到请求后进程退出、端口释放 |
| **遗留请求不再误杀** | 预置遗留 `shutdown.request` 后启动，引擎存活 |

### 未测试（**不要当成通过**）

| 项目 | 为什么没测 |
|---|---|
| 安装包端到端（运行 `MasLingo-Setup.exe` 走完向导） | 需要一台干净虚拟机；本轮只到"编译出安装包" |
| **干净 Windows、无 Python/Git/VS Code** | 同上。已通过可迁移性测试间接支持，但不等于验收标准 1 |
| 重启登录后自动启动 | 需要真实重启 |
| 卸载后清理 | 需要先完成一次真实安装 |
| 端口被占用时的用户可见提示 | 引擎层已测；安装向导内的表现未测 |
| Chrome 检测（三种安装位置） | 代码覆盖三处路径 + 注册表，未在真实环境验证 |
| 中文 Windows 用户目录下的完整安装 | 可迁移性测试用了含中文的路径，但没走安装器 |

### 仍需用户完成

**一次 Chrome 里的扩展安装确认。** 这是唯一无法自动化的一步，且不应假装可以。

---

## 10. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 扩展显示"未连接"，托盘是红的 | 看 `%LOCALAPPDATA%\MasLingo\logs\engine.log` |
| 装完立刻能用但重启后不行 | 检查启动项：`pythonw.exe ...\maslingo_engine.py --autostart status` |
| 装完等了一会儿扩展才连上 | 正常：首次启动要加载 OCR 权重，安装向导的健康检查最多等 120 秒 |
| 提示端口 8001 被占用 | 多半已有一个引擎在跑。任务管理器结束多余的 `pythonw.exe`，或用托盘退出 |
| 引擎反复重启后停下来 | 已达 3 次/10 分钟上限，说明后端本身启动不了。日志里有真实错误 |
| 引擎启动一秒后就没了 | 检查是否有遗留的 `%LOCALAPPDATA%\MasLingo\shutdown.request`（当前版本会自动清理并记日志） |
