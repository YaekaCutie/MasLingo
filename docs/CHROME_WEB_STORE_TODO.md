# Chrome 应用商店上架待办

> 结论先说：**代码还没到能提交的状态**。下面 P0 是"不做就一定被拒或根本提交不了"，P1 是"能过审但大概率被拖审/反复驳回"，P2 是需要你本人准备的素材和账号事项。
>
> 依据：Chrome Web Store 官方政策与文档（developer.chrome.com / Chrome Web Store Program Policies），检索于 2026 年。逐条都附了出处链接。

---

## P0 — 阻断项

### P0-1 完全没有图标

`extension/manifest.json` 里**没有 `icons` 字段**，包里也没有任何图片文件。商店要求详情页图标 **128×128 PNG**（底图 96×96 + 每边 16 px 透明留白），并建议同时提供 48×48 与 16×16。**缺图标是直接驳回项。**

- [ ] 设计图标，导出 `extension/icons/icon16.png`、`icon48.png`、`icon128.png`
- [ ] 在 manifest 里声明 `icons` 与 `action.default_icon`
- 注意：**不支持 WebP 和 SVG**，JPEG/BMP/GIF/ICO 可用但推荐 PNG。

参考：<https://developer.chrome.com/docs/webstore/images>、<https://developer.chrome.com/docs/extensions/reference/manifest/icons>

### P0-2 去掉静态 `<all_urls>` 内容脚本，改用 `activeTab`

现在 manifest 声明了 `content_scripts.matches: ["<all_urls>"]`，用户安装时会看到**"读取和更改您在所有网站上的数据"**。这是审核判断"权限过大（Purple Potassium）"和**明确延长审核时间**的首要信号。

而 `tabs.captureVisibleTab()` 官方文档写得很清楚：只需要 `<all_urls>` **或 `activeTab`** 二者之一即可。改用 `activeTab` 的好处：

- 安装时**没有吓人的权限警告**；
- 只在你点击扩展时对当前标签页授权，符合"最小权限"；
- 反而能作用于 `chrome://`、其它扩展页面、`data:` URL 等 `<all_urls>` 够不到的地方。

现有代码其实**已经准备好了**：`popup.js` 里的 `prepareContentScript()` 会在 `PING` 失败时用 `chrome.scripting.insertCSS/executeScript` 动态注入。所以要做的是"删掉静态声明，把动态注入变成唯一路径"。

- [ ] 删除 `manifest.json` 的整个 `content_scripts` 段
- [ ] 确认 `content.js` 通过 `chrome.scripting.executeScript` 注入后功能完整（框选、结果渲染、`styles.css` 也已 `insertCSS`）
- [ ] 确认 `activeTab` 授权在 popup 关闭后仍然有效（同一次用户手势内完成注入即可）
- [ ] **真机回归测试**：普通网页框选 / 自动识别 / 翻译渲染三条路径

参考：<https://developer.chrome.com/docs/extensions/reference/api/tabs>、<https://developer.chrome.com/docs/webstore/review-process>

> **实测补充（2026-10，本轮端到端测试意外证实）：** `content_scripts.matches` 里的
> `<all_urls>` **并不能**满足 `captureVisibleTab` 的权限要求。把扩展装进 Chrome 并在
> 页面上真实拖框时，服务端报的是：
>
> ```
> Either the '<all_urls>' or 'activeTab' permission is required.
> ```
>
> 也就是说：**静态 `<all_urls>` 内容脚本对截图权限毫无贡献**，真正起作用的是用户点扩展
> 图标时授予的 `activeTab`。
>
> 这反过来让 P0-2 变得**更安全**：删掉静态内容脚本（改为一律按需注入）**不会**影响截图，
> 因为在真实使用流程里永远是"用户点了图标 → activeTab 已授权 → 截图可用"。唯一的差别
> 是自动化测试无法伪造这个手势，所以 `deploy/check-region-flow.mjs` 会对扩展做一份临时
> 副本、只补上 `<all_urls>` 再跑（该权限与所测逻辑无关）。

### P0-3 `tabs` 权限大概可以删掉

现在声明了 `permissions: ["activeTab","scripting","storage","tabs"]`。官方说明：`tabs` 权限只用来读取 `url` / `pendingUrl` / `title` / `favIconUrl`；**有了宽泛 host 权限或 activeTab 时它根本不需要**。

代码里用到 `chrome.tabs.get/query/captureVisibleTab/sendMessage`，其中：

- `captureVisibleTab`、`sendMessage`、`query` 的基本字段（`id`）**不需要** `tabs` 权限；
- `service-worker.js` 里读了 `tab.width` / `tab.height` 作为视口回退——这两个是普通字段，不属于受限字段。

- [ ] 去掉 `"tabs"`，真机验证 `chrome.tabs.get(tabId)` 仍返回 `width`/`height`；若确实拿不到，改成从 content script 上报视口尺寸（`msg.viewport` 已经是首选路径）
- [ ] 在 dashboard 的权限说明里逐条解释 `activeTab`、`scripting`、`storage` 的用途

参考：<https://developer.chrome.com/docs/webstore/program-policies/permissions>

### P0-4 安装前的显著告知 + 用户同意

**现状：截图会离开用户的设备发到你的服务器，但扩展里没有任何告知，更没有任何同意步骤。** 这直接命中 `Purple Nickel`（未做显著披露/未取得同意）。

- [ ] 首次使用（或安装后打开 popup）时弹出**显著告知**：会截取当前页面画面并发送到 `<你的后端域名>` 做文字识别；说明不用于其它用途、不长期保存
- [ ] 提供**明确的同意按钮**，未同意前不发起任何截图/上传
- [ ] 提供**退出选项**：在设置里可切换到"仅本机后端"或直接停用
- [ ] 把这个告知同时写进商店详情页描述里（官方两个页面对"披露位置"说法矛盾，**两边都做最安全**）

参考：<https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements>、<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>

### P0-5 隐私政策（必填字段）

只要扩展"处理"用户数据就必须有隐私政策 URL——官方明确把**"截取用户访问网站的截图"**列为处理行为，**即使只在本地处理也需要**。而且必须填在 dashboard 的**指定字段**里（写进描述里不算，这是常见驳回原因 `Purple Lithium`）。

隐私政策里**必须点名所有数据接收方**：

- [ ] 你的 OCR 托管后端（域名 + 用途 + 保留策略）
- [ ] Google 翻译（仅在用户显式启用 `free-translate` 时）
- [ ] 用户自己配置的 OpenAI-compatible 接口（域名由用户决定）
- [ ] 写明：截图不写入服务器日志、不用于训练、不做广告用途
- [ ] 加入 Limited Use 声明原文：*"The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements."*
- [ ] 托管到一个公开 URL（GitHub Pages 免费且够用）
- [ ] 同步更新仓库里的 `README.md` / `ARCHITECTURE.md`：现在写的是"截图只发往本机"，与托管后端后的实际行为**不一致**

参考：<https://developer.chrome.com/docs/webstore/program-policies/privacy>、<https://developer.chrome.com/docs/webstore/program-policies/limited-use>

### P0-6 `alert()` 与死开关

- [ ] `content.js` 的 `failRecognition()` 用了 `alert()`——审核和人机交互体验都差，改成页面内提示条
- [ ] `debugMode`（"显示 OCR 识别结果"）现在是**死开关**：`service-worker.js` 读了它、写进 `json.debug_mode`，但 `content.js` 从未消费该字段。要么实现，要么从设置页删掉（商店要求元数据与行为一致）

### P0-7 收窄 `host_permissions`

为了让托管后端开箱可用，现在声明了通配的 `https://*.sslip.io/*`。

- [ ] 部署完成后替换成**你的真实域名**（例如 `https://ocr.example.com/*`）
- [ ] 只保留本机回退所需的 `http://127.0.0.1:8001/*` 与 `http://localhost:8001/*`
- [ ] 注意：**修改 host_permissions 会触发用户权限重新确认**，所以尽量在首次上架前定好

参考：<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>

---

## P1 — 影响过审速度与通过率

### P1-1 审核期间后端必须活着

官方明确把"审核时服务端故障导致功能不可用"列为驳回原因（`Yellow Magnesium`）。审核员会真的去用你的扩展。

- [ ] 提交前确认 `https://<域名>/health` 返回 200
- [ ] 在 dashboard 的 **Test instructions** 里写清楚：不需要账号，点扩展图标 → "选择漫画区域并识别" 即可，并给一个可测试的漫画页面
- [ ] 后端准备好限流与排队，防止审核流量打满（见 `deploy/README.md` 第 8.4 节）

参考：<https://developer.chrome.com/docs/webstore/troubleshooting>

### P1-2 隐私实践表单（dashboard 必填）

"Privacy practices" 标签页每一项都要填，否则无法发布/更新：

- [ ] **单一用途描述**：建议写成"把用户选中的漫画画面文字识别为日文，并在原图位置叠加简体中文翻译"
- [ ] **权限逐条说明**（每个 manifest 权限一个输入框）
- [ ] **远程代码声明**：选 **"No, I am not using remote code"**——这是真的，后端只返回 JSON 文本，扩展里没有 `eval`/`new Function`/远程脚本
- [ ] **数据用途勾选**：至少要勾"网站内容（Website content）"，很可能还要勾"网页浏览活动（Web browsing activity）"
- [ ] **Limited Use 认证勾选**全部勾上
- [ ] 隐私政策 URL

> ⚠️ 官方警告：**dashboard 的披露、隐私政策、实际行为三者不一致**会导致账号下所有扩展被下架甚至封禁发布者。填之前先确保代码行为一致。

参考：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>

### P1-3 不要把数据放进 URL 或请求头

政策要求用户数据必须走现代加密传输，并且**即使 HTTPS 也不能放在 query 参数或请求头里**（会进服务器日志）。目前实现是 POST multipart body，JSON 也在 body 里，**已经合规**。

- [ ] 后续加 token 时注意：**不要把 token 和截图放同一个 URL**；也顺手确认 `deploy/Caddyfile` 的访问日志不要记录请求体
- [ ] 保持 `uvicorn --no-access-log`（已配置）

参考：<https://developer.chrome.com/docs/webstore/program-policies/data-handling>

### P1-4 元数据与文案

- [ ] manifest `name` ≤ 75 字符（当前 `OpenMangaTranslator` 没问题）
- [ ] manifest `description` ≤ 132 字符（当前中文描述没问题，但要在详情页里说明需要联网访问你的服务器）
- [ ] 版本号格式：1–4 段点分整数，每段 0–65535（`1.0.2` 合规），每次上传必须比上一版大
- [ ] 商店分类：建议 `Tools` 或 `Workflow & Planning`（`Art & Design` 也涵盖截图类工具）
- [ ] 商店语言：简体中文（可按需再加英文）
- [ ] 详情描述里**不要关键词堆砌**（同一关键词出现不超过 5 次即"自然"），不要放无法证实的用户评价

参考：<https://developer.chrome.com/docs/webstore/program-policies/listing-requirements>、<https://developer.chrome.com/docs/extensions/reference/manifest/version>

### P1-5 关于签名与分发的认知纠正

现在的做法是在仓库 Release 里发自签名的 `.crx`（用 `extension.pem`）。**这对应用商店版本没有意义**：

- 商店要求上传的是**未打包扩展的 ZIP**（`manifest.json` 在根目录），**商店会自己签名生成 CRX**；
- 商店版本的**扩展 ID 由商店持有的密钥决定**，你本地那个 `.pem` 不影响它；
- 所以已装 Release 版 CRX 的用户和装商店版的用户，会是**两个不同的扩展 ID**，设置不互通。

- [ ] 决定商店版与 Release 版的关系：要么商店版成为唯一正式渠道（Release 只留源码 zip），要么明确说明两者独立
- [ ] 如果你想用同一 ID，官方做法是：上传 ZIP **但不发布** → Package 标签页 → **View public key** → 把公钥写进 manifest 的 `"key"` 字段
- [ ] `extension.pem` 千万不要提交进 Git（见下）

参考：<https://developer.chrome.com/docs/webstore/update>、<https://developer.chrome.com/docs/extensions/reference/manifest/key>

### P1-6 仓库卫生（顺手但重要）

- [ ] `.gitignore` 加入 `*.pem`、`*.crx`、`*.zip`——目前 `extension.pem`（扩展签名私钥）就在项目目录里且**未被忽略**，一次 `git add .` 就会把它推上 GitHub
- [ ] 清理工作区里的 `Image from URL`、`Image from URL 2` 等临时文件

---

## P2 — 需要你本人准备/操作

### P2-1 开发者账号

- [ ] 注册 Chrome Web Store 开发者账号（**一次性注册费，普遍为 5 美元**，官方现行文档只写"一次性费用，金额由 Google 全权决定"）
- [ ] 账号邮箱**注册后不可更改**，选一个长期用的
- [ ] 完成邮箱验证
- [ ] **强制开启两步验证（2SV）**，否则无法发布或更新
- [ ] 完成 **Trader / Non-Trader 声明**（欧盟 DSA 要求）。选 Trader 需要 Google Payments 资料并**公开姓名、电话、地址**；个人开发者通常选 Non-Trader
- [ ] 注意：**新发布者最多同时发布 2 个扩展**，更多需要申请

参考：<https://developer.chrome.com/docs/webstore/register>、<https://developer.chrome.com/docs/webstore/program-policies/two-step-verification>

### P2-2 商店素材

| 素材 | 规格 | 是否必需 |
| --- | --- | --- |
| 扩展图标 | 128×128 PNG（96×96 + 16 px 留白） | **必需** |
| 截图 | 1280×800 或 640×400，1–5 张 | **必需**（至少 1 张） |
| 小宣传图 | 440×280 PNG/JPEG | **必需** |
| 大型宣传图 | 1400×560 PNG/JPEG | 可选（想被推荐位收录才需要） |
| 演示视频 | YouTube 链接 | 官方两处说法矛盾，建议准备 |

- [ ] 截图建议拍：①框选识别中 ②译文嵌回原图的效果 ③设置页（说明可切本机后端）
- [ ] 宣传图**不能本地化**，截图可以

参考：<https://developer.chrome.com/docs/webstore/images>

### P2-3 提交与审核

- [ ] 先把 ZIP 上传为**草稿**（不发布）——这是官方推荐的锁定扩展 ID 的方式，也方便反复改
- [ ] 也可以用"延迟发布"：审核通过后手动点发布；审核完成后 **30 天内**不发布会退回草稿
- [ ] 审核时长：多数几天，可能长达几周。**超过 3 周**可以联系开发者支持
- [ ] 若被驳回：先修再传，**驳回不影响已上架版本**；注意 **2025 年起每种违规只能申诉一次，二次申诉不再受理**
- [ ] 已上架后仍会被**定期复审**，合规是持续义务（例如后端行为变化要同步改隐私政策）

参考：<https://developer.chrome.com/docs/webstore/review-process>、<https://developer.chrome.com/docs/webstore/publish>

---

## 明确的红线（别踩）

1. **任何形式的远程代码执行**：不能从服务器拉脚本/WASM 来跑 OCR 或翻译。**目前设计是合规的**——后端只返回 JSON 文本。以后若要做"浏览器端 OCR"，模型和推理代码**必须打包进扩展或走 `chrome.storage` 里的本地资源**，从 CDN 拉 `.wasm` 并执行是明确违规。
2. **混淆代码**：包括打包进去的第三方依赖，以及扩展请求到的任何外部资源。压缩（去空格、改短变量名）可以。
3. **数据实践与披露不一致**：最严重的后果是**整个发布者账号被封**。
4. **绕过 AI 服务或网站的限制**：2026-08-01 生效的新规明确禁止"规避 AI 服务的安全护栏、使用限制或其它保护措施"的扩展。抓取需要登录/付费的漫画站内容、或绕过翻译服务的限流，都可能命中。**建议在 README 里明确写出"仅用于用户有权访问的页面"。**
5. **诱导用户关闭安全设置**、**把功能伪装成跳转到外部网站**（Minimum Functionality）——后者意味着 OCR 必须是扩展流程的一部分，不能只是"点一下打开某个网页"。

参考：<https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code>、<https://developer.chrome.com/docs/webstore/program-policies/code-readability>、<https://developer.chrome.com/blog/cws-policy-updates-2026>

---

## 建议的执行顺序

1. **先做 P0-1 ~ P0-3**（图标 + 权限最小化），这三项决定了审核难度，而且改动会互相影响，一起改一起测。
2. **再做 P0-4 ~ P0-7**（告知同意 + 隐私政策 + 行为一致性），这部分要等后端域名定下来。
3. 同步准备 P2 的账号与素材（不依赖代码）。
4. 全部就绪后：上传草稿 → 填 Privacy practices → 提交审核。
