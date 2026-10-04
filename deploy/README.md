# 把后端部署到 Oracle Cloud Always Free

目标是让**装完扩展就能用**：用户不需要装 Python、torch、也不需要下载模型，页面截图直接发到这台免费服务器上做 OCR。

```
Chrome 扩展 ──HTTPS──> Caddy(自动 TLS) ──> FastAPI + MangaOCR 容器
                          :443                    :8001（仅容器网络）
```

整个部署只跑一台机器、两个容器，没有数据库、没有对象存储、没有负载均衡。

---

## 0. 先看清楚免费额度的真实情况（2026）

网上大量教程写的还是旧数字，**Oracle 在 2026-06-15 悄悄把 Always Free 的 ARM 额度砍了一半**：

| 项目 | 现状 | 说明 |
| --- | --- | --- |
| ARM 计算（`VM.Standard.A1.Flex`） | **2 OCPU / 12 GB** | 旧教程会写 4 OCPU / 24 GB，已作废 |
| AMD 微型（`VM.Standard.E2.1.Micro`） | 2 台，各 1/8 OCPU / 1 GB | **跑不动**本项目，别选 |
| 块存储 | 200 GB（启动卷 + 块卷合计） | 默认 50 GB 启动卷够用 |
| 出网流量 | 10 TB / 月 | 本项目用不到零头 |
| 区域 | 必须在 **home region** | A1 在韩国春川（Chuncheon）不可用 |

来源：[Always Free Resources（官方）](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。

**够不够用？** 够。后端常驻内存实测约 **800 MB**（模型预加载后 Python 进程 RSS，本机实测 798 MB），加 Docker、Caddy 和系统开销整机大约 1.5–2 GB。2 OCPU 跑 OCR 是"一个人等几秒、几个人排队"的水平，个人/小圈子分享完全没问题。

---

## 1. 注册 Oracle Cloud 账号（需要你本人操作）

我做不了这一步：需要信用卡和身份信息。

- **必须提供信用卡或"像信用卡一样"的借记卡**用于身份验证。**不接受**带 PIN 的借记卡、**虚拟卡、一次性卡、预付卡**。
- 验证时可能有一笔临时预授权，银行通常 3–5 天内释放。
- **一个人只能有一个免费账号**，多开会被判定违规并可能封号。
- 30 天试用期结束后**不会停机**，自动继续使用 Always Free 资源；但超出免费额度的数据（例如对象存储超过 20 GB）会被删除。
- 建议：注册时选**离你近、且 A1 容量没那么紧张**的 home region。home region 之后**无法更改**。

注册入口：<https://www.oracle.com/cloud/free/>

> 注册过程中如果被拒绝，常见原因就是卡类型不符合要求，换一张真实的信用卡再试。

---

## 2. 创建实例

在 OCI 控制台里：

1. **Compute → Instances → Create instance**
2. **Image**：`Canonical Ubuntu` 22.04 或 24.04（ARM 版）
3. **Shape**：`Ampere` → `VM.Standard.A1.Flex`，**OCPU 填 2，内存填 12 GB**（把额度一次用完，别留）
4. **Networking**：选"Create new virtual cloud network"，勾选 **Assign a public IPv4 address**
5. **Add SSH keys**：上传你的公钥（或者让它生成并**立刻下载私钥**）
6. 创建，记下**公网 IP**

### 如果报 "Out of host capacity"

这是免费账号的**预期失败**，不是你的配置错了。官方给出的办法：

- 换一个 **Availability Domain** 再建（3 个 AD 的区域成功率高很多）；
- 过一会儿/过几个小时再试；
- 或者**升级为 Pay as You Go**——官方明确说明升级后 Always Free 资源依然免费，只有超出部分才计费，而且升级后 ARM 容量优先级更高。

想要自动化重试可以看社区工具 <https://github.com/alexpua/oci-arm-catcher>。

---

## 3. 放行 80 / 443（**两层**，缺一层都不通）

这是最容易卡住的地方。Oracle 的 Ubuntu 镜像里 `ufw status` 显示 `inactive`，**这是假象**——它用的是裸 iptables，默认只放行 SSH。

### 第 1 层：VCN 安全列表（控制台操作）

**Networking → Virtual Cloud Networks → 你的 VCN → Security Lists → Default Security List → Add Ingress Rules**，加两条：

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

> 80 端口是必须的：Let's Encrypt 的 HTTP-01 验证要走它。443/udp 可选（HTTP/3）。

### 第 2 层：实例内的 iptables

`bootstrap-vm.sh` 会自动做，手工的话是：

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save          # 不 save 的话重启就丢
sudo iptables -L INPUT -n --line-numbers
```

> Oracle 官方教程用的是 `-I INPUT 6`（因为默认规则里第 6 条是 catch-all REJECT）。插到第 1 条效果一样且更不容易插错位置。

---

## 4. 一键部署

SSH 登录实例（`ssh ubuntu@<公网IP>`），然后：

```bash
git clone --depth 1 https://github.com/YaekaCutie/OpenMangaTranslator.git
cd OpenMangaTranslator
bash deploy/bootstrap-vm.sh
```

脚本会：装基础包 → 放行端口 → 装 Docker → 拉代码 → 写 `deploy/.env`（域名默认用 `<公网IP>.sslip.io`）→ `docker compose up -d --build`。

**首次构建要 5–15 分钟**（要下 torch 和 OCR 模型，镜像约 2–3 GB）。ARM 上所有依赖都有 aarch64 wheel，不需要编译器。

想用自己的域名：

```bash
bash deploy/bootstrap-vm.sh ocr.example.com
```

（记得把域名 A 记录指向这台机器的公网 IP。）

---

## 5. 验证

在**你自己的电脑**上执行（不是服务器上）：

```bash
curl -s https://<你的域名>/health
# {"ok":true,"backend":"ready","ocr":"mangaocr","busy":0,"concurrency":2,"free_translate":true}
```

第一次请求会触发模型调用，慢一点是正常的。证书签发通常几秒到一分钟。

---

## 6. 让扩展指向这台服务器

改两个文件（改完重新打包，用户装上就是开箱即用）：

1. `extension/config.js`

```js
globalThis.OMT_BACKEND_URL = "https://<你的域名>";
```

2. `extension/manifest.json` → `host_permissions`：把 `https://*.sslip.io/*` 换成你的真实域名（上架前必须收窄，见 `docs/CHROME_WEB_STORE_TODO.md`）。

```json
"host_permissions": [
  "http://127.0.0.1:8001/*",
  "http://localhost:8001/*",
  "https://ocr.example.com/*"
]
```

然后重新打包发布。用户装完直接可用；想自己跑后端的用户可以在扩展设置里把"后端地址"填成 `http://127.0.0.1:8001`，扩展会优先用它。

---

## 7. 日常运维

```bash
cd ~/OpenMangaTranslator/deploy
sudo docker compose logs -f api        # OCR 日志
sudo docker compose logs -f caddy      # TLS / 访问日志
sudo docker compose restart api
sudo docker compose down                # 停

# 更新代码
cd ~/OpenMangaTranslator && git pull
cd deploy && sudo docker compose up -d --build
```

调整容量（改 `deploy/.env` 后 `docker compose up -d`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OMT_TORCH_THREADS` | 1 | 每个 OCR 任务用几个线程；2 OCPU 就填 1–2 |
| `OMT_OCR_CONCURRENCY` | 2 | 同时处理几个任务；调大 = 更多人并行但每人更慢 |
| `OMT_RATE_LIMIT_REQUESTS` | 40 | 每 IP 每窗口请求数上限，0 = 关闭 |
| `OMT_ENABLE_FREE_TRANSLATE` | 1 | 置 0 可禁用 Google 翻译（见下） |
| `OMT_PRELOAD_MODEL` | 1 | 启动即加载模型并常驻内存，**建议保持开启** |

---

## 8. 你必须知道的风险

### 8.1 实例可能被回收

Oracle 的规则（官方原文）：**7 天内** 95 分位 CPU **低于 20%** 且 网络 **低于 20%** 且 **内存低于 20%**（内存这条只针对 A1）→ 判定为空闲，可能被回收。

**"每天定时 ping 一下"没用**，一次 HTTP 请求撼动不了 95 分位统计。

实测数据与判断：

- 本项目常驻内存约 **1.5–2 GB**（Python 800 MB + Docker/Caddy/系统），而 12 GB 的 20% = **2.4 GB**——**单靠内存不一定压得住这条线**，别把 2025 年那些"模型占好几 G 所以很安全"的说法当结论。
- 但**三个条件必须同时满足**才回收，而且看的是 **95 分位**：只要 **5% 的时间**CPU 或网络超过 20%（一天里累计约 1.2 小时）就达标。**有真实用户在用就不会被回收**；完全没人用一个星期，才有风险。

建议：

- [ ] 保持 `OMT_PRELOAD_MODEL=1`，**不要**做"没人用就缩容到 0"的改造；
- [ ] 上线初期自己多用几次，或者跑个低频任务（例如每 30 分钟用满 1–2 分钟 CPU）把分位抬起来；
- [ ] 想彻底免除这个心智负担，就把账号**升级为 Pay as You Go**——官方明确说明 Always Free 资源升级后依然免费，只有超出部分计费，而且不受空闲回收影响、ARM 容量优先级更高。

另外还有一条更严的：**账号连续 30 天完全不活动，可能被判定为废弃并停用**。所以别建完就彻底不管。

### 8.2 免费额度是"随时可能变"的

2026-06 的那次腰斩没有任何公告。别把免费额度当作长期承诺。

### 8.3 隐私模型变了（重要）

改之前：截图只在本机 `127.0.0.1` 处理，README 里写的是"本地优先"。
改之后：**用户的页面截图会经过你的服务器**。这带来三个后果：

1. README / ARCHITECTURE 里"只发往本机"的描述必须改；
2. Chrome 应用商店要求**在安装前显著告知并取得同意**，隐私政策里必须点名"你的 OCR 服务器"这个数据接收方；
3. 你本人变成了数据控制者——服务器上的访问日志、内存里的截图都算。

`deploy/Caddyfile` 目前**不做请求体日志**，`uvicorn` 也关了 access log，就是为了少留数据。建议保持。

### 8.4 公网接口会被滥用

这是一个**无需认证**的 OCR 接口。已做的防护：

- 每 IP 限流（默认 40 次/60 秒）；
- OCR 并发上限（默认 2），超出的请求排队而不是把机器打死；
- 单图 15 MB 上限；
- 推理跑在线程池里，不会阻塞 `/health`。

还不够的话，下一步可以加：Cloudflare 免费代理挡在前面、或给扩展发一个共享 token。

### 8.5 Google 翻译会拖累你的服务器 IP

`free-translate` 模式走的是 Google 的免费接口，**按服务器 IP 计**。用户一多，这台机器的 IP 会先被限流甚至封掉。真要上量就设 `OMT_ENABLE_FREE_TRANSLATE=0`，让用户用自己的 OpenAI-compatible Key（扩展已经把 Key 设计成随请求走、服务端不存储）。

---

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 证书一直签不下来 | VCN 安全列表没放行 80/443 | 回第 3 步 |
| `curl` 从外面连不上，服务器内正常 | 实例 iptables 没放行 | 回第 3 步第 2 层 |
| `502` | api 容器没起来或还在加载模型 | `docker compose logs api` |
| 第一次识别特别慢 | 模型在下载/首次加载 | 确认 `OMT_PRELOAD_MODEL=1`，看日志有没有"已预加载" |
| 整页识别要几十秒 | 2 OCPU ARM 的正常水平 | 见下 |
| 构建时 pip 报找不到包 | 网络/DNS 抖动 | 重跑 `docker compose build` |
| 磁盘满 | 旧镜像堆积 | `docker system prune -a` |

### 性能预期（要跟用户说清楚）

本机基准（i7-14700KF，20 线程）：**单区域 OCR 0.17 秒，整页 5 个区域 5.5 秒**。

2 OCPU ARM 大约慢 4–8 倍，所以：

- **手动框选一个区域**：1–3 秒，体验不错；
- **整页自动识别**（检测 + 最多 24 个区域）：**20–45 秒**，能接受但要有 loading 提示。

扩展里整页模式的超时是 360 秒，够用。如果嫌慢，最有效的优化是**在扩展侧先把整页缩放再上传**，或把服务端的 `MAX_TEXT_REGIONS` 调小。

---

## 10. 附录 A：不用 Docker 的裸机部署

如果你不想装 Docker（或者容器在 ARM 上遇到怪问题）：

```bash
sudo apt-get update && sudo apt-get install -y python3-venv python3-pip git
cd ~ && git clone --depth 1 https://github.com/YaekaCutie/OpenMangaTranslator.git
cd OpenMangaTranslator
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# 预下载模型
HF_HOME=$PWD/.hf .venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base')"
```

把 `deploy/omt-backend.service` 拷到 `/etc/systemd/system/`，按里面注释改路径和用户，然后：

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now omt-backend
```

TLS 用系统 Caddy（`sudo apt install caddy`），Caddyfile 把 `reverse_proxy api:8001` 改成 `reverse_proxy 127.0.0.1:8001`。

---

## 11. 附录 B：关于"完全不用服务器"的方案

你问过有没有不改代码又不用服务器的办法。答案是：**没有**。原因很直接——

- 扩展硬编码了 `http://127.0.0.1:8001`，任何远程后端都必须改代码；
- OCR 模型（manga-ocr，约 400 MB）必须跑在某个地方。

唯一的"零服务器"终局方案是**把 OCR 搬到浏览器里**（ONNX Runtime Web / WebGPU + transformers.js）。它的好处非常契合你的目标：零成本、零运维、隐私不落地、装上就能用。代价是：

- manga-ocr 是 ViT 编码器 + 自回归解码器，要导出 ONNX 并处理自定义 tokenizer，是一次真正的移植工程；
- 文本区域检测（现在 327 行 NumPy/Pillow 代码）要用 JS/Canvas 重写或放到 Worker 里；
- 用户首次使用要下载 100–400 MB 模型（缓存一次）；
- WebGPU 在老设备和部分浏览器上不可用，需要 CPU 回退。

**建议路线**：先用托管后端把"即装即用"跑起来（本文件），把浏览器端 OCR 作为 v2 目标——到那时服务器就只剩翻译中转了，甚至可以完全去掉。
