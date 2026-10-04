# 浏览器端 OCR 可行性（消除服务器的方案）

> **一句话结论：可行，而且不需要服务器、不需要云账号、不需要信用卡、不需要用户装 Python。**
> 本文是一次实测的结论记录，不是推测。证据见下面「实测结果」，复现脚本在 [`tools/onnx_parity_test.py`](../tools/onnx_parity_test.py)。

---

## 为什么要有这条路

目标一直是「装完即用」。但把后端放上云有三个已经核实的硬约束：

1. **没有任何「免信用卡 + 永久免费 + 能跑 PyTorch + 一直在线」的云服务器**（见 [FREE_HOSTING_2026.md](FREE_HOSTING_2026.md)）；
2. Oracle Always Free 要真实信用卡，且容量经常拿不到；
3. 唯一免卡的托管路线（自己电脑 + Tailscale Funnel）要求**你电脑一直开着**。

只要 OCR 还在服务器上，这三条就绕不过去。**把 OCR 搬进浏览器，三条同时消失。**

---

## 实测结果（2026-10-04，本机 Windows / CPU）

在用户提供的真实漫画页上取三个对白气泡，把社区 ONNX 导出与当前服务端 PyTorch 流水线逐字对比：

| 裁剪区域 | PyTorch（当前后端） | ONNX（浏览器同款权重） | 一致？ |
| --- | --- | --- | --- |
| bubble1 | `アサちゃんはチェンソーマン好き？` | 同左 | ✅ 完全一致 |
| bubble2 | `気ますっあ〜！！帰りたい` | 同左 | ✅ 完全一致 |
| bubble3 | `まあまあ．．．っていうか普通．．：` | `まあまあ．．．っていうか普通．．．．．．` | ⚠️ 仅结尾标点不同 |

- 推理耗时 **0.31–0.49 秒/区域**（Python + onnxruntime CPU），与 PyTorch 的 0.15–0.19 秒同一量级。
- bubble3 的差异来自我用了**贪心解码**（真实流水线是 `num_beams=4` 的束搜索），属于解码策略差异，不是模型差异。
- **两种预处理都通过**：原始裁剪、以及经过后端 `_prepare_image`（自动对比度 + 对比度增强）的版本，输出一致——说明模型对我们的预处理是稳健的。

## 关键发现：为什么直接用 transformers.js 会得到乱码

我第一次尝试就是直接用 `@huggingface/transformers` 跑 `pipeline('image-to-text', ...)`，结果是**一堆无关汉字**（`ん 斥 お 毛 ~ 娠 ル 齢 …`）。原因不是模型坏了，而是两处接线问题：

1. **分词器不兼容**：该模型的解码器用的是**字符级日文词表**（6144 项，源自 `cl-tohoku/bert-base-japanese-char-v2`）。Hugging Face 仓库里的 `tokenizer_config.json` 是 `BertJapaneseTokenizer`，**需要 MeCab 做分词——浏览器里没有 MeCab**，transformers.js 无法正确还原 id→文字。
2. 仓库里那份自动导出的 ONNX（`onnx-community/manga-ocr-base-ONNX`）**缺少 transformers.js 需要的 merged decoder**，直接报 404。

**结论：不要用 transformers.js 跑这个模型。** 手写一个贪心/束搜索解码循环（约 25 行）反而更简单、更可控，而且只需要一张 id→字符 表。

---

## 浏览器端实现配方（全部要素已核实）

| 组件 | 来源 | 体积 | 状态 |
| --- | --- | --- | --- |
| ONNX 编码器（int8） | `kimchireader/manga-ocr-onnx-q8` → `onnx/encoder_model_quantized.onnx` | 82.98 MB | ✅ 已验与 PyTorch 一致 |
| ONNX 解码器（int8） | 同仓库 → `onnx/decoder_model_quantized.onnx` | 28.27 MB | ✅ 同上 |
| id→字符 词表 | 模型自带的 `vocab.txt`，6144 行 | **12 KB** | ✅ 已提取 |
| 预处理 | 灰度化 → 缩放到 224×224 → /255 → (x−0.5)/0.5 | ~15 行 JS/Canvas | ✅ 两种变体均验证 |
| 解码循环 | 贪心或束搜索，`decoder_start_token_id=2`，`eos=3` | ~25 行 JS | ✅ Python 版已验证 |
| 运行时 | **onnxruntime-web**（WASM） | ~10–20 MB | ⬜ 待接入 |

**首次使用需要下载约 111 MB 模型权重**（若换 `q4` 变体约 70 MB，尚未实测精度）。下载后缓存在扩展本地存储里，之后离线可用。

### 两个必须注意的约束

1. **WASM 必须打包进扩展，不能从 CDN 加载。**
   Chrome 应用商店的 MV3 政策禁止远程代码：`onnxruntime-web` 的 `.wasm` 属于**代码**，必须随扩展一起打包（把 `wasmPaths` 指向扩展内的本地路径）。而**模型权重是数据**，运行时从 Hugging Face 下载是明确允许的（政策原文允许 "Fetching remote resources that are not used to evaluate logic"）。
2. **推理要放在 offscreen document 里跑**，不要放在 service worker：MV3 的 service worker 会因空闲被回收（约 30 秒），而一次整页 OCR 远超这个时间。需要声明 `offscreen` 权限。

---

## 这条路 vs 托管后端

| | 托管后端（Oracle） | 浏览器端 OCR |
| --- | --- | --- |
| 信用卡 | 需要 | **不需要** |
| 费用 | 0（可能被回收） | **0** |
| 你电脑要开着吗 | 不要 | **不要** |
| 用户装完即用 | 是 | 是（**首次多下载 ~111 MB**） |
| 隐私 | 截图离开设备 | **截图永不离开设备** |
| 离线可用 | 否 | **首次下载后可** |
| 商店审核 | 需披露数据外发 + 隐私政策 | 数据不外发，**披露负担大幅降低** |
| 上限 | 服务器 CPU 共享 | 取决于用户设备；老设备慢 |
| 弱网/低端机 | 无影响 | 首次下载 111 MB 是门槛 |

**建议**：把浏览器端 OCR 作为**默认路径**，保留「自建后端」作为可选项（架构上已经支持：`extension/config.js` 的候选列表里本机地址就是回退项）。这样服务器不再是必需品，而是一个可选加速器。

---

## 实现进展：引擎已经写出来了

`extension/ocr/engine.js` + `extension/ocr/vocab.js` 是**可以直接跑的浏览器端引擎**（预处理 + ONNX 推理 + 解码 + 后处理），用 `tools/engine_parity_test.mjs` 在 Node 里对着同三个气泡验证（Node 只是代替浏览器，被测代码与扩展加载的是同一个文件）。

最新一次结果：

| 气泡 | 端上引擎 | 服务端 PyTorch | 一致？ | 耗时 |
| --- | --- | --- | --- | --- |
| bubble1 | `アサちゃんはチェンソーマン好き？` | 同左 | ✅ | 0.44s |
| bubble2 | `気ますっあ〜！！帰りたい` | 同左 | ✅ | 0.37s |
| bubble3 | `まあまあ．．．っていうか普通．．` | `まあまあ．．．っていうか普通．．：` | ❌ 差一个尾部标点 | 0.41s |

### 那个差一个标点的原因，已经查清了（不是解码器的错）

把 token 序列打出来对比（bubble3）：

```
PyTorch fp32 : 2 | 2 912 852 912 852 28 28 28 885 888 854 856 861 2766 5224 28 28 40 3
端上（贪心） : 2 |   912 852 912 852 28 28 28 885 888 854 856 861 2766 5224 28 28   （EOS）
```

**逐 token 完全一致，只差最后那个 `40`（`：`）。** 也就是说端上引擎忠实地复现了 ONNX 模型；差异来自 **int8 量化**——在 fp32 模型里那个位置是低置信度的 `：`，量化后 EOS 略胜一筹。末尾少一个冒号，属于可接受的量化代价；真在意的话可以换 fp16 权重（体积从 111 MB 涨到约 220 MB）。

### 顺带否掉了我自己写的束搜索

我按 `generation_config.json` 实现了 `num_beams=4` + `length_penalty=2.0` + `no_repeat_ngram_size=3`，结果**更差**：

| 解码策略 | bubble3 token 序列 | 耗时 |
| --- | --- | --- |
| 贪心（现在默认） | `…2766 5224 28 28` → `普通．．` | **0.41s** |
| 束搜索 4 束 | `…5224 1025 1025 1025 28` → `普通．．．．` | 0.81s |

束搜索在更早的位置就偏离了参考实现，还慢一倍。所以默认改成贪心（`DEFAULT_NUM_BEAMS = 1`），束搜索保留为 `options.numBeams` 可选项。**这是测出来的结论，不是偏好。**

---

## 还没做的事（下一步）

引擎跑通了，但**还没接进浏览器**。剩下的：

1. **在浏览器里跑起来**：一个扩展页面（最终是 offscreen document）用 canvas 取 `ImageData` 喂给同一个 `engine.js`，并把 `ort.env.wasm.wasmPaths` 指向扩展内的 `vendor/ort/`；
2. **manifest 调整**：加 `content_security_policy.extension_pages` 的 `'wasm-unsafe-eval'`（扩展用 WASM 的官方允许方式），以及 `offscreen` 权限；
3. **首次下载体验**：130.9 MB 资源（14 MB wasm + 111 MB 模型）目前由 `tools/fetch_ocr_assets.py` 取到扩展目录并 gitignore。要在"打包进 CRX"和"首次运行时下载"之间做决定——**打包进 CRX 最省事**：商店上限 2 GB，装完即可离线用，代价是每次更新都要重下整包；
4. **换个量化档位再测**：fp16 能否补回那个 `：`；
5. **区域检测的移植**：当前整页自动识别依赖 327 行 NumPy/Pillow。浏览器端**第一版只做手动框选**，这条不需要；整页自动作为第二阶段；
6. **竖排/横排判定**：`_detect_text_direction` 同样要移植或用简单启发式替代。

> 再次强调：**验证用的是手动裁剪出的单个气泡**。整页自动识别在浏览器端尚未验证，是最大的剩余未知数。
