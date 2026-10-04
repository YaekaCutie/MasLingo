# 免信用卡方案：自己电脑 + Tailscale Funnel

> 如果你在问「有没有不用填信用卡的免费服务器」——**答案是没有**（下面第一节有核实过的清单）。但有一条**不用任何云服务器**的路能达到同样效果：把后端跑在你自己电脑上，用 Tailscale Funnel 免费暴露到公网。
>
> 一键脚本：`deploy/expose-local-backend.ps1`（已用 mock 跑通全流程与各失败分支）

---

## 1. 先说清楚：为什么没有「免信用卡的永久免费云服务器」

2026-10 逐个核对官方页面后的结论：**「永久免费 + 不要信用卡 + 能跑 2.5 GB 的 PyTorch 容器 + 一直在线」四个条件无法同时满足。**

| 方案 | 要卡？ | 永久？ | 关键限制 |
| --- | --- | --- | --- |
| **Oracle Always Free** | **要**（且明确**拒绝**虚拟卡/一次性卡/预付卡/带 PIN 的借记卡） | 是 | 唯一真正的永久在线 VM；但 7 天窗口内 CPU/网络/内存 95 分位都低于 20% 会被回收 |
| **Google Cloud** | **要**（"you must provide a credit card or other payment method"） | 免费层无期限，但试用 90 天 | e2-micro 只有 **1 GB 内存**，跑不动；Cloud Run 免费额度也远不够常驻 |
| **AWS** | **不要** | **不是**（额度 6 个月过期） | 新的免费计划只有 6 个月 |
| **Azure** | **要** + 手机号 | 不是（$200 只够 30 天） | — |
| **Hugging Face Spaces** | **要** | 静态页免费，**Gradio/Docker 现在需要付费订阅 PRO** | 曾经的首选免费方案，2026 已改 |
| **Render** | 不要 | 是 | **512 MB 内存**，跑不动 torch；闲置 15 分钟休眠 |
| **Koyeb** | **要**（$29 预授权） | 免费服务存在 | 512 MB 内存，跑不动 |
| **Fly.io** | 要 | 不是（试用 7 天） | — |
| **Railway / Replit** | 不要 | 不是（30 天） | — |
| **Cloudflare Workers** | 不要 | 是 | 128 MB / 10 ms CPU，跑不了 PyTorch |
| **Cloudflare Containers** | 付费 | 不是 | 免费档写着 "N/A" |
| **GitHub Codespaces** | 不要 | 额度按月 | **服务条款明确禁止**"host any kind of production-facing application"，且最长 12 小时 |
| Glitch / Deta Space | — | **已关停** | — |

**所以只有两条路：**

- **有真实信用卡** → Oracle Always Free（见 [deploy/README.md](../README.md)），容量问题用 `provision-oci.sh` 自动重试。
- **没有信用卡** → 本文件：自己的电脑 + Tailscale Funnel。

---

## 2. 这套方案是什么

```
用户的浏览器扩展  ──HTTPS──>  Tailscale Funnel 中继  ──加密隧道──>  你电脑上的 FastAPI + MangaOCR
                              https://<机器名>.<tailnet>.ts.net
```

- **Tailscale 个人版 $0、注册不需要任何支付方式**；官方文档明确写着 *"Tailscale Funnel is available for all plans"*。
- 公网地址形如 `https://<机器名>.<tailnet>.ts.net`，**重启后不变**（绑定在设备上），扩展可以直接把它设为默认后端。
- TLS 证书由 Tailscale 自动签发。
- 你的 IP 不会暴露给公网。

### 代价（必须接受）

| 项 | 说明 |
| --- | --- |
| **电脑必须开着** | 关机 / 休眠 / 退出 Tailscale = 所有用户都用不了。这是这套方案唯一真正的硬伤。 |
| 带宽 | 官方说明"subject to non-configurable bandwidth limits"，但没给具体数字 |
| 稳定性 | 家庭宽带的可用性远不如机房；Funnel 目前仍是 **beta** |
| 域名 | 只能用 `<tailnet>.ts.net`，不能用你自己的域名（除非另配 Cloudflare Named Tunnel + 自有域名） |
| DNS 生效 | 官方说明公有 DNS 记录**最多需要 10 分钟**生效 |

### 官方要求与限制（2026-01 校验）

- 需要 Tailscale **v1.38.3+**、tailnet 启用 MagicDNS、启用 HTTPS 证书、策略文件里有 `funnel` 节点属性（用 CLI 启用时 Tailscale 会自动加）。
- **只能监听 443 / 8443 / 10000**，且**只走 TLS**。
- 同一端口不能同时用于 Serve（仅 tailnet 内）和 Funnel（公网）。

来源：<https://tailscale.com/docs/features/tailscale-funnel>

---

## 3. 怎么做

### 一次性准备

1. 安装 Tailscale 并登录：<https://tailscale.com/download>（**不需要信用卡**）
2. 确保后端在本机能跑起来：

   ```powershell
   .\start-backend.ps1
   ```

   看到 `Uvicorn running on http://127.0.0.1:8001` 就行。

### 一条命令

```powershell
.\deploy\expose-local-backend.ps1
```

脚本会：

1. 确认 `tailscale` 存在并且已登录，读出你的 tailnet 域名；
2. 检查本机后端是否在 `127.0.0.1:8001` 上响应（没起就会提示你先跑 `start-backend.ps1`）；
3. 执行 `tailscale funnel --bg 8001`——**首次会弹网页让你确认启用 Funnel**，Tailscale 会顺手申请 HTTPS 证书；
4. 轮询验证公网地址（连不上只警告不报错，因为 DNS 最多要 10 分钟）；
5. 打印下一步要跑的命令。

常用参数：

```powershell
.\deploy\expose-local-backend.ps1 -Port 8001      # 指定端口
.\deploy\expose-local-backend.ps1 -SkipBackend    # 只配 Funnel，不检查后端
.\deploy\expose-local-backend.ps1 -WhatIf         # 只演示，不真的执行
```

### 让扩展指向它

脚本最后会打印这条命令，直接照抄：

```powershell
python deploy/configure_hosted_backend.py https://<机器名>.<tailnet>.ts.net --version 1.0.3 --pack extension.pem
```

它会把地址写进 `extension/config.js`、把真实域名写进 `manifest.json` 的 `host_permissions`，并重新打包。之后把 1.0.3 作为 Release 发出去，新用户装完就是"即装即用"。

### 关闭

```powershell
tailscale funnel reset      # 关掉所有 Funnel
tailscale funnel status     # 看当前映射
```

---

## 4. 和 Oracle 方案的关系

| | Oracle Always Free | 自己电脑 + Funnel |
| --- | --- | --- |
| 信用卡 | 必须（真实卡） | **不需要** |
| 永久免费 | 是（但可能被回收） | 是 |
| 7×24 在线 | 是 | **取决于你电脑开不开** |
| 上手难度 | 注册 + 建实例 + 两次放行端口 | 装 Tailscale + 一条命令 |
| 适合 | 长期、要上商店审核 | 先跑起来 / 没卡 / 小圈子自用 |

两者可以并存：先用 Funnel 让用户马上能用，等 Oracle 容量到手后，再跑一次 `configure_hosted_backend.py` 换过去，扩展侧不需要改代码。

> ⚠️ 一个现实提醒：Chrome 应用商店把"审核时功能不可用"列为驳回原因。如果你的电脑不保证 7×24 开着，**别用这套方案去提审**，先用它验证功能、拉用户，等有了稳定的托管后端再上架。
