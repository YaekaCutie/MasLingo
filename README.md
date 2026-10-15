# MasLingo v1.1.7

日漫全平台 OCR 翻译器浏览器插件。根据 OCR 原理，可以自动检测当前可见页面中的文字区域翻译当前页面，或者框选翻译；翻译开启后，扩展在原图文字范围内修复背景并绘制中文。

由于原理决定，插件并不会像其它插件一样需要平台支持。

**开箱即用**：识别由官方托管的 MangaOCR 后端完成，普通用户不需要安装 Python、不需要下载模型，装完扩展就能用。想自己掌控数据、或者想离线使用的用户，也可以在本机跑后端（见下方「自建后端」），扩展会优先使用你自己配置的地址。

> 本 README 包含**完整的后端部署文档**：本机自建、Oracle Cloud Always Free 云服务器、免信用卡的自托管隧道，三条路线都能照着一步步做下来。更深的运维细节、决策记录与风险分析见 [deploy/README.md](deploy/README.md)。

## 安装与运行

### 普通用户（推荐）

1. 安装发布版扩展：Chrome 应用商店，或打包好的 `.crx`。
2. 直接使用。识别请求会发往官方托管后端，不需要 API Key、不需要 Python 环境。翻译默认关闭，因此默认流程不会把识别文本发给任何翻译服务。

Windows 用户也可以使用桌面安装包（自带后端与 OCR 模型，装完即用、无需任何环境，见 [packaging/README.md](packaging/README.md)）。

> **从源码加载扩展的开发者注意**：直接加载仓库里的 `extension/` 文件夹时，托管后端地址是空的（发布打包时才由部署脚本注入）。这种方式需要先按下面「自建后端」在本机起一个后端——扩展会自动回退到 `http://127.0.0.1:8001`——或者按「部署后端」部署自己的服务器后重新打包。

### 自建后端（本机运行，数据不出本机）

前置：Python 3.11.x 及以上。

1. 在项目目录创建 Python 环境并安装后端依赖：

	```powershell
	python -m venv .venv
	.\.venv\Scripts\Activate.ps1
	python -m pip install -r backend\requirements.txt
	```

2. 启动本机后端：

	```powershell
	.\start-backend.ps1
	```

3. 打开扩展的「识别设置」，把**后端地址**填成 `http://127.0.0.1:8001` 并保存。扩展会优先使用这个地址，连不上时才回退到托管后端（源码加载的扩展本来就会自动尝试这个地址）。

首次安装依赖和首次启动 OCR 时可能需要联网下载 Python 包及 OCR 模型文件；模型缓存完成后，日常识别可断网使用。

## 部署后端（完整部署文档）

目标：让**装完扩展就能用**发生在你自己的服务器上——用户不需要装 Python、torch，也不需要下载模型，页面截图直接发到这台机器上做 OCR。

```
Chrome 扩展 ──HTTPS──> Caddy(自动 TLS) ──> FastAPI + MangaOCR 容器
                          :443                    :8001（仅容器网络）
```

整套部署只有一台机器、两个容器，没有数据库、没有对象存储、没有负载均衡。

### 三条路线怎么选

| 路线 | 信用卡 | 7×24 在线 | 适合 |
| --- | --- | --- | --- |
| **A. Oracle Cloud Always Free**（本 README 详述） | 必须（真实卡，拒虚拟卡/预付卡） | 是 | 长期运营、要上架商店 |
| **B. 自己电脑 + Tailscale Funnel**（[alt-self-host-tunnel](deploy/alt-self-host-tunnel/README.md)） | 不需要 | 取决于你电脑开不开 | 先跑起来 / 没卡 / 小圈子自用 |
| **C. 任何一台云服务器 / VPS** | 按厂商 | 是 | 已有机器的用户（见文末方案 C） |

没有信用卡？直接看「方案 B」，别在「Hugging Face Spaces 免费 Docker」上浪费时间——那条路 2026 年已经改成付费订阅。

---

### 方案 A：Oracle Cloud Always Free

#### A0. 先看清楚免费额度的真实情况（2026）

网上大量教程写的还是旧数字，**Oracle 已把 Always Free 的 ARM 额度砍半**：

| 项目 | 现状 | 说明 |
| --- | --- | --- |
| ARM 计算（`VM.Standard.A1.Flex`） | **2 OCPU / 12 GB** | 旧教程会写 4 OCPU / 24 GB，已作废 |
| AMD 微型（`VM.Standard.E2.1.Micro`） | 2 台，各 1/8 OCPU / 1 GB | **跑不动**本项目，别选 |
| 块存储 | 200 GB（启动卷 + 块卷合计） | 默认 50 GB 启动卷够用 |
| 出网流量 | 10 TB / 月 | 本项目用不到零头 |
| 区域 | 必须在 **home region** | 注册后不可更改 |

够不够用？够。后端常驻内存约 **1.2 GB**，加 Docker、Caddy 和系统开销整机大约 1.8–2.5 GB。2 OCPU 跑 OCR 是「一个人等几秒、几个人排队」的水平，个人/小圈子分享没问题。

#### A1. 注册 Oracle Cloud 账号（需要你本人操作）

- **必须提供信用卡或“像信用卡一样”的借记卡**用于身份验证。**不接受**虚拟卡、一次性卡、预付卡、带 PIN 的借记卡。
- 验证时可能有一笔临时预授权，银行通常 3–5 天内释放。
- **一个人只能有一个免费账号**，多开会被判定违规并可能封号。
- 30 天试用期结束后**不会停机**，自动继续使用 Always Free 资源。
- 注册时选**离你近、且 A1 容量没那么紧张**的 home region；home region 之后**无法更改**。

注册入口：<https://www.oracle.com/cloud/free/>

#### A2. 创建实例

1. **Compute → Instances → Create instance**
2. **Image**：`Canonical Ubuntu` 22.04 或 24.04（ARM 版）
3. **Shape**：`Ampere` → `VM.Standard.A1.Flex`，**OCPU 填 2、内存填 12 GB**（把额度一次用完，别留）
4. **Networking**：选 Create new virtual cloud network，勾选 **Assign a public IPv4 address**
5. **Add SSH keys**：上传你的公钥（或让它生成并**立刻下载私钥**）
6. 创建，记下**公网 IP**

**报 “Out of host capacity” 怎么办**：这是免费账号的**预期失败**，不是配置错了。换一个 Availability Domain 再试、过几小时再试，或者**升级为 Pay as You Go**（官方说明升级后 Always Free 资源依然免费，只有超出部分计费，且 ARM 容量优先级更高）。

**让脚本替你重试**：在 **OCI Cloud Shell**（控制台右上角 `>_` 图标，`oci` CLI 已预认证）里跑：

```bash
# 先用控制台向导建好 VCN + 公网子网，把子网 OCID 复制过来
git clone --depth 1 https://github.com/YaekaCutie/MasLingo.git
cd MasLingo
bash deploy/provision-oci.sh --subnet-id ocid1.subnet.oc1.<region>.<...>
```

它会在所有可用域之间轮换重试直到拿到容量，拿到后打印公网 IP 和后续步骤。注意：它只做「启动实例」；VCN/子网仍用控制台建；`--dry-run` 只打印命令；Ctrl-C 中断是安全的；加 `--rounds N` 可以跑 N 轮后退出。

#### A3. 放行 80 / 443（**两层**，缺一层都不通）

这是最容易卡住的地方。Oracle 的 Ubuntu 镜像里 `ufw status` 显示 `inactive`，**这是假象**——它用的是裸 iptables，默认只放行 SSH。

第 1 层，**VCN 安全列表**（控制台）：Networking → Virtual Cloud Networks → 你的 VCN → Security Lists → Default Security List → Add Ingress Rules，加两条：

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

（80 是必须的：Let's Encrypt 的 HTTP-01 验证要走它。）

第 2 层，**实例内 iptables**（`bootstrap-vm.sh` 会自动做；手工执行）：

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save          # 不 save 的话重启就丢
sudo iptables -L INPUT -n --line-numbers
```

#### A4. 一键部署

SSH 登录实例（`ssh ubuntu@<公网IP>`），然后：

```bash
git clone --depth 1 https://github.com/YaekaCutie/MasLingo.git
cd MasLingo
bash deploy/bootstrap-vm.sh
```

脚本会：装基础包 → 放行端口 → 装 Docker → 拉代码 → 写 `deploy/.env`（域名默认用 `<公网IP>.sslip.io`）→ `docker compose up -d --build`。

**首次构建要 5–15 分钟**（要下 torch 和 OCR 模型，镜像约 2–3 GB）。ARM 上所有依赖都有 aarch64 wheel，不需要编译器。

想用自己的域名：

```bash
bash deploy/bootstrap-vm.sh ocr.example.com
```

（记得把域名 A 记录指向这台机器的公网 IP。）

#### A5. 验证

在**你自己的电脑**上执行（不是服务器上）：

```bash
curl -s https://<你的域名>/health
# {"ok":true,"backend":"ready","ocr":"mangaocr","busy":0,"concurrency":2,"free_translate":true}
```

第一次请求会触发模型调用，慢一点是正常的。证书签发通常几秒到一分钟。

#### A6. 让扩展指向这台服务器

```bash
python deploy/configure_hosted_backend.py https://<你的域名> --pack extension.pem
```

它会改 `extension/config.js` 的托管地址、把真实域名写进 `manifest.json` 的 `host_permissions`，然后重新打包出 `.crx`。去掉 `--pack` 则只改配置、不打包；重复执行是**替换**而不是追加，并保留 `127.0.0.1` / `localhost` 回退。打包器不依赖 Chrome 且是确定性的（同样的源码 + 同一个 `extension.pem` 得到逐字节相同的 CRX）。

**发布前**：① 把 `extension/manifest.json` 的 `version` 加一（商店要求每次上传的版本号必须更大）；② 确认 `host_permissions` 里已经没有 `https://*.sslip.io/*` 这类临时域名（上面的命令会自动换掉），详见 `docs/CHROME_WEB_STORE_TODO.md` 的 P0-7。

#### A7. 日常运维

```bash
cd ~/MasLingo/deploy
sudo docker compose logs -f api        # OCR 日志
sudo docker compose logs -f caddy      # TLS / 访问日志
sudo docker compose restart api
sudo docker compose down                # 停

# 更新代码
cd ~/MasLingo && git pull
cd deploy && sudo docker compose up -d --build
```

调整容量（改 `deploy/.env` 后 `docker compose up -d`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAS_TORCH_THREADS` | 1 | 每个 OCR 任务用几个线程；2 OCPU 就填 1–2 |
| `MAS_OCR_CONCURRENCY` | 2 | 同时处理几个任务；调大 = 更多人并行但每人更慢 |
| `MAS_RATE_LIMIT_REQUESTS` | 40 | 每 IP 每窗口请求数上限，0 = 关闭 |
| `MAS_ENABLE_FREE_TRANSLATE` | 1 | 置 0 可禁用 Google 翻译（见下） |
| `MAS_PRELOAD_MODEL` | 1 | 启动即加载模型并常驻内存，**建议保持开启** |

#### A8. 你必须知道的风险

- **实例可能被回收**：Oracle 的规则是——7 天内 95 分位 CPU **低于 20%** 且网络 **低于 20%** 且内存 **低于 20%**（内存这条只针对 A1）→ 判定为空闲，可能被回收。后端常驻内存约 1.2 GB + 系统开销 1.8–2.5 GB，而 12 GB 的 20% = 2.4 GB，**正好卡在线附近**。但三个条件必须同时满足、且看的是 95 分位：只要 5% 的时间（一天约 1.2 小时）有真实流量就安全。「每天 ping 一下」没用；完全没人用一星期才有风险。最省心的办法是升级 Pay as You Go（Always Free 资源依然免费，且不受空闲回收影响）。另外账号连续 30 天完全不活动也可能被判定废弃。
- **免费额度随时可能变**：之前那次砍半没有任何公告，别当长期承诺。
- **隐私模型变了**：用户的页面截图会经过**你的**服务器。你成为数据控制者——访问日志、内存里的截图都算。`deploy/Caddyfile` 默认不做请求体日志、`uvicorn` 关了 access log，建议保持；面向商店发布时，隐私政策必须点名「你的 OCR 服务器」这个数据接收方。
- **公网接口会被滥用**：这是无需认证的 OCR 接口。已内置：每 IP 限流（默认 40 次/60 秒）、OCR 并发上限（默认 2，超出排队）、单图 15 MB 上限。还不够就加 Cloudflare 免费代理，或给扩展发共享 token。
- **Google 翻译会拖累你的服务器 IP**：`free-translate` 按服务器 IP 计费限流，用户一多会先被限。要上量就设 `MAS_ENABLE_FREE_TRANSLATE=0`，让用户用自己的 API Key（Key 随请求走、服务端不存储）。

#### A9. 故障排查与性能预期

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 证书一直签不下来 | VCN 安全列表没放行 80/443 | 回 A3 第 1 层 |
| 外面 `curl` 连不上、服务器内正常 | 实例 iptables 没放行 | 回 A3 第 2 层 |
| `502` | api 容器没起来或还在加载模型 | `docker compose logs api` |
| 第一次识别特别慢 | 模型在下载/首次加载 | 确认 `MAS_PRELOAD_MODEL=1`，看日志有没有「已预加载」 |
| 构建时 pip 报找不到包 | 网络/DNS 抖动 | 重跑 `docker compose build` |
| 磁盘满 | 旧镜像堆积 | `docker system prune -a` |

性能预期（跟用户说清楚）：本机基准（i7-14700KF）单区域 OCR 约 0.2 秒；2 OCPU ARM 大约慢 4–8 倍。所以**手动框选一个区域 1–3 秒**，**整页自动识别（检测 + 逐区域识别，最多 80 个区域）40–90 秒**，密集双页更久。扩展里整页模式的超时是 360 秒，够用。嫌慢最有效的优化是在扩展侧先把整页缩放再上传，或把服务端的 `MAX_TEXT_REGIONS` 调小。

#### A10. 附录：不用 Docker 的裸机部署

```bash
sudo apt-get update && sudo apt-get install -y python3-venv python3-pip git
cd ~ && git clone --depth 1 https://github.com/YaekaCutie/MasLingo.git
cd MasLingo
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# 预下载模型
HF_HOME=$PWD/.hf .venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base')"
```

把 `deploy/maslingo-backend.service` 拷到 `/etc/systemd/system/`，按注释改路径和用户，然后：

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now maslingo-backend
```

TLS 用系统 Caddy（`sudo apt install caddy`），Caddyfile 把 `reverse_proxy api:8001` 改成 `reverse_proxy 127.0.0.1:8001`。

---

### 方案 B：没有信用卡 —— 自己电脑 + Tailscale Funnel

把后端跑在你自己电脑上，用 Tailscale Funnel 免费暴露到公网，公网地址稳定不变：

```
用户的浏览器扩展 ──HTTPS──> Tailscale Funnel 中继 ──加密隧道──> 你电脑上的 FastAPI + MangaOCR
                              https://<机器名>.<tailnet>.ts.net
```

一键脚本：`deploy/expose-local-backend.ps1`（Windows PowerShell，已对全流程与各失败分支做过 mock 验证）。完整步骤、免费服务器横向对比、常见坑见 [deploy/alt-self-host-tunnel/README.md](deploy/alt-self-host-tunnel/README.md)。

代价：**你电脑得开着**；适合先跑起来、小圈子自用，或者发布前的过渡期。

---

### 方案 C：其他云服务器 / VPS

任何一台 2 GB+ 内存的 Linux 机器都一样：装好系统后

```bash
git clone --depth 1 https://github.com/YaekaCutie/MasLingo.git && cd MasLingo
bash deploy/bootstrap-vm.sh 你的域名        # 或直接回车用 sslip.io 域名
```

然后把域名 A 记录指过去即可。整套 `deploy/docker-compose.yml` 不含任何 Oracle 专属配置。

---

### 有没有“完全不用服务器”的办法？

没有。OCR 模型（约 400 MB）必须跑在某个地方，扩展硬编码的本机回退地址也要求后端真实存在。唯一的“零服务器”终局方案是**把 OCR 搬进浏览器**（ONNX Runtime Web / WebGPU + transformers.js）：零成本、零运维、隐私不落地，但需要把模型导出 ONNX、把文本检测重写为 JS/Canvas，是一次真正的移植工程——列为 v2 方向：到那时服务器就只剩翻译中转了，甚至可以完全去掉。

## 数据流与限制

`可见页面/手选区域截图 → 后端（默认为官方托管实例，可改为本机） → 文字区域分组 + MangaOCR 日文识别 → 扩展显示结果`

自动模式优先识别视口内最大的主要图片/画布/视频或带背景图的元素，先裁掉网页搜索栏、工具栏和缩略图，再用本地对比度与邻近墨迹分组检测文字，可检测深色或浅色的嵌图文字；亮字候选还需有足够暗色邻域，避免把白色气泡底纹当作文字。对紧凑形状、浅色连通区域且包含足够墨迹的对白气泡，会额外生成整气泡 OCR 框，避免多列文本被分段裁切；该类框最大为图像面积的 16%，普通墨迹分组框仍限制为 5%。候选按“字形似度”排序（画稿不容易挤掉文字），画格的整块背景框不会吞并格内气泡，描边相连的相邻气泡会按无字空白带拆分。深色背景上较大的亮字分组会有限扩展纵向上下文，帮助保留结尾字词。高窄竖排区域会优先保留横向上下文供 OCR 识别。找不到足够大的主媒体图片时，自动模式会明确报错并提示手动框选，不会退回扫描整个网页。检测仍是启发式，不推断精确气泡轮廓，复杂背景、网点或相邻对白可能漏检/合并，仍可手动框选。后端会比较两种明暗极性判断横排/竖排，并按日漫竖排从右至左识别文字列；识别结果要过一道置信度门槛：低于阈值或明显是画稿纹理的读数会被丢弃，不会被翻译后画到画面上。每次识别前会移除旧结果，避免旧结果进入新截图。翻译开启后，扩展在浏览器中从周边画面采样并估算文字区域底色，用原图裁片修复原字位置，再按横排或竖排绘制中文；不会添加窗口、卡片、边框或气泡底板。背景复杂或文字紧贴画框时，局部修复可能不完美。关闭翻译、请求失败或超时时会保留原始画面并显示状态提示。

翻译默认关闭，因此默认流程不会联系云端翻译服务。启用后，翻译方向为日文到简体中文：Google 翻译请求固定使用 `ja → zh-CN` 并整条提交 OCR 文本；OpenAI-compatible Chat Completions API 使用日漫本地化提示，结合当批条目的上下文翻译，并要求保留原意、编号及条目数量。可在扩展设置选择 OpenAI-compatible API 并填写 endpoint、模型以及可选 API Key，也可显式启用 Google 翻译。OpenAI-compatible 设置（包括 Key）仅存于 Chrome `storage.local`；Key 随本次翻译请求从扩展发往后端，再转发到所配置的接口，不写入后端配置或日志。选择在线服务会将识别文本发送给该服务。也可配置本地运行的 OpenAI-compatible 服务以避免云端。

## 隐私与数据

这是使用前必须知道的部分：

- **默认情况下，你框选或自动检测到的页面画面会离开你的设备**，发送到官方托管的 OCR 后端做文字识别。这是“装完即用”的代价——识别模型必须跑在某台机器上。
- 托管后端**只做 OCR**：不写入请求体日志、不做训练、不做广告用途、不长期保存截图。进程只保存模型，不保存用户图像。
- 想让数据完全不出本机：按上面“自建后端”把后端跑在自己电脑上，并在扩展设置里把后端地址填成 `http://127.0.0.1:8001`。
- **翻译是另一个独立选择**，默认关闭。启用 Google 翻译会把识别文本发给 Google；启用 OpenAI-compatible 会把文本发给你自己配置的接口。不启用就只做 OCR。
- 相关信息：扩展只在你点击扩展图标后才对当前标签页截图，不会后台持续采集。
- **自己部署服务器的人注意**：见「A8 风险」——用户的截图会经过你的服务器，你成为数据控制者；面向商店发布时隐私政策必须点名这个数据接收方。

## 常见问题

- **识别很慢或失败**：使用托管后端时，第一次请求要等模型加载（托管实例已开启预加载，通常不会遇到）。自建后端时首次运行需初始化 MangaOCR 模型，确认安装依赖时网络可用，并为模型文件和运行时预留足够磁盘及内存。
- **自动识别要等几十秒**：整页模式要检测并逐个识别最多 80 个区域（普通单页几秒到十几秒，密集双页可能二十多秒到一分钟），在低配服务器上是正常耗时；手动框选单个区域通常 1–3 秒。嫌慢就用框选。
- **自动识别结果为空或区域不准**：自动检测是轻量图像启发式，适用于清晰墨迹文字，不保证气泡分割质量；尝试调整页面缩放或手动框选单个文字区域。
- **从源码加载的扩展识别一直失败**：仓库里的 `extension/` 没有注入托管后端地址，先在本机跑后端（`.\start-backend.ps1`），或在扩展设置里填入你部署好的服务器地址；发布用的 `.crx` 不受影响。
- **结果只有日文、没有中文**：翻译默认关闭以避免未经允许发送漫画文本。打开扩展的“识别设置”，将“翻译模式”从“关闭翻译”改为“Google 翻译”或配置好的“OpenAI-compatible API”，然后保存；Google 翻译需要联网。翻译未启用或服务报错时，页面会提示原因并保留日文原文。
- **翻译报“无法连接「XX」（域名）：Failed to fetch”**：说明这个翻译服务从你的网络**无法直连**，与扩展本身无关。国内网络访问 Google 翻译、OpenAI、Anthropic 等通常需要代理；Google 翻译是最顺手的免密钥来源，也最容易连不上。到“识别设置”里把翻译来源换成「必应翻译」或「MyMemory」（免密钥、国内可直连），或 DeepSeek、通义千问、智谱等（需要各自的 API Key），或本机运行 Ollama。
- **提示“请求过于频繁”**：托管后端对每个 IP 做了限流，稍等几十秒再试即可。

## 相关文档

- [deploy/README.md](deploy/README.md) —— 部署的完整决策记录与运维细节（Oracle 路线、风险分析、性能实测）
- [deploy/alt-self-host-tunnel/README.md](deploy/alt-self-host-tunnel/README.md) —— 免信用卡方案：自己电脑 + Tailscale Funnel
- [packaging/README.md](packaging/README.md) —— Windows 桌面安装包（内嵌后端与模型）
- [docs/CHROME_WEB_STORE_TODO.md](docs/CHROME_WEB_STORE_TODO.md) —— 上传 Chrome 应用商店的待办清单（政策要求、素材规格、必改项）
- [ARCHITECTURE.md](ARCHITECTURE.md) —— 识别流程与设计取舍
