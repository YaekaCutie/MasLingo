# 备选方案：Hugging Face Spaces（不需要信用卡）

> **这是备用路线，不是替代 Oracle 的推荐路线。** 我用不了它自己的账号，所以这份指南**没有被我端到端跑通过**——里面的步骤来自 Hugging Face 的 Docker SDK 约定，标了 ⚠️ 的地方是我无法验证的细节。

## 为什么需要它

主方案 Oracle Cloud Always Free 有两个你控制不了的失败点：

1. **注册被拒**：必须用真实信用卡（不接受虚拟卡/预付卡/带 PIN 的借记卡），且一人一号。
2. **"Out of host capacity"**：这是 Oracle 官方承认的**预期现象**——免费 ARM 容量经常没有，得换 Availability Domain 反复重试，可能持续几天。

而 HF Spaces 只要一个邮箱就能注册，**不需要任何支付方式**，免费 CPU 档给 **2 vCPU / 16 GB 内存**，跑这个后端绰绰有余。它可以让你**今天就把托管后端跑起来**，不用等 Oracle 的容量。

## 代价（先看清楚再决定）

| 项 | HF Spaces 免费档 |
| --- | --- |
| 冷启动 | **闲置约 48 小时后休眠**，下次请求要等容器重新启动 + 模型加载，约 1–2 分钟 ⚠️（休眠时长以 HF 当前政策为准） |
| 资源 | 2 vCPU / 16 GB，比 Oracle 的 12 GB 还宽裕 |
| 费用 | 0，无信用卡 |
| 域名 | 自带 HTTPS 域名 `https://<user>-<space>.hf.space`，**不用自己搞证书** |
| 源代码 | **公开可见**（本仓库本来就是公开的，无额外影响） |

冷启动这一条是实打实的体验退步：用户偶尔会遇到"第一次识别等两分钟"。对"即装即用"来说不理想，但比"用户要自己装 Python"好得多，也比后端根本没上线好。

## 部署步骤

### 1. 建 Space

- 打开 <https://huggingface.co/new-space>
- **SDK 选 `Docker`** → **Blank**
- 硬件选 **CPU basic（free）**
- Visibility 选 **Public**

### 2. 把后端塞进去

HF Space 的 Docker SDK 要求 **`Dockerfile` 在仓库根目录**，所以不能直接用 `deploy/Dockerfile`（它在子目录）。本目录提供了一个 Space 专用变体。

```bash
# 拉项目
git clone --depth 1 https://github.com/YaekaCutie/OpenMangaTranslator.git omt

# 拉你的 Space
git clone https://huggingface.co/spaces/<你的用户名>/<space 名> space
cd space

# 组装：Space 专用 Dockerfile + 后端代码 + 带 front-matter 的 README
cp ../omt/deploy/alt-huggingface-space/Dockerfile ./Dockerfile
cp -r ../omt/backend ./backend
cp ../omt/deploy/alt-huggingface-space/space-README.md ./README.md

git add -A
git commit -m "deploy OpenMangaTranslator OCR backend"
git push
```

推送后 HF 会自动开始构建，**首次构建 10–20 分钟**（要装 torch 并把模型烤进镜像）。在 Space 页面的 Logs 里能看到进度。

### 3. 确认它活着

```bash
curl -s https://<user>-<space>.hf.space/health
# {"ok":true,"backend":"ready","ocr":"mangaocr","busy":0,"concurrency":2,"free_translate":true}
```

第一次请求可能触发冷启动，耐心等 1–2 分钟。

### 4. 打开限流（强烈建议）

Space 是**公网无鉴权**的，而免费额度是共享的。在 Space 页面 **Settings → Variables and secrets** 里加：

| 名称 | 值 | 作用 |
| --- | --- | --- |
| `OMT_RATE_LIMIT_REQUESTS` | `40` | 每 IP 每窗口请求上限 |
| `OMT_RATE_LIMIT_WINDOW` | `60` | 窗口秒数 |
| `OMT_OCR_CONCURRENCY` | `2` | 同时处理的任务数 |
| `OMT_TORCH_THREADS` | `1` | 每个任务用的线程数 |

加完变量需要 **Restart Space** 才生效。

### 5. 让扩展指向它

```bash
python deploy/configure_hosted_backend.py https://<user>-<space>.hf.space --pack extension.pem
```

## ⚠️ 我无法验证的点

1. **容器用户 ID**：HF Spaces 对运行用户有额外约束（常见说法是强制 UID 1000）。所以 Space 版 Dockerfile **没有**沿用主 Dockerfile 的 `USER omt`，而是在构建时把目录授权给 UID 1000。如果构建或启动时报权限错误，看 Logs 里的 uid 提示再调。
2. **`app_port`**：Space 版 README 的 front-matter 里写了 `app_port: 8001`，与容器监听端口一致。若 HF 改了默认行为，以官方文档为准。
3. **休眠时长与唤醒延迟**：文中写的 48 小时来自 HF 的历史政策，2026 年的实际值请以 Space 设置页面为准。
4. **构建时长限制**：免费档的构建时长/磁盘配额可能有限制，本镜像约 2–3 GB。

## 两条路线怎么选

- **只是想让功能先跑起来 / Oracle 一直没容量** → 用 Spaces，十分钟能上线。
- **长期、稳定、要被 Chrome 应用商店审核** → 仍然推荐 Oracle：不会休眠、完全可控。HF Spaces 的冷启动会让审核员遇到"点了没反应"，商店明确把"审核时功能不可用"列为驳回原因。

两者并不冲突：可以先用 Spaces 顶着，Oracle 容量到手后再切过去——扩展换后端只需要重跑一次 `configure_hosted_backend.py`。
