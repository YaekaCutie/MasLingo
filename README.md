# Manga Translator 0.0.1

完全本地运行的漫画翻译 Chrome 扩展。用户框选单个文字区域后，扩展把截图发送到本机 FastAPI，由 MangaOCR 直接识别日文，再将识别文本发给本机 Ollama 文本模型翻译。图片不会发送给 Ollama，也不使用云端翻译 API、API Key 或收费服务。

默认模型为 `qwen2.5:7b`。资源较少的电脑可在扩展设置中选择较小的本地文本模型，例如 `qwen2.5:3b`。

## 安装与运行

1. 安装 [Ollama](https://ollama.com/download)，启动 Ollama，然后下载模型：

	```powershell
	ollama pull qwen2.5:7b
	```

2. 在项目目录创建 Python 环境并安装后端依赖：

	```powershell
	python -m venv .venv
	.\.venv\Scripts\Activate.ps1
	python -m pip install -r backend\requirements.txt
	```

3. 启动本机后端：

	```powershell
	.\start-backend.ps1
	```

	Ollama 默认地址为 `http://127.0.0.1:11434`。如需更改，在 `backend\.env` 设置 `OLLAMA_BASE_URL`。

4. 在 Chrome 打开“扩展程序 → 开发者模式 → 加载已解压的扩展程序”，选择项目的 `extension` 文件夹。打开扩展设置，输入本机已下载的模型名并点击“测试本机模型”。

不需要 API Key。翻译和 OCR 都在本机运行。首次安装依赖和首次启动 OCR 时可能需要联网下载 Python 包及 OCR 模型文件；Ollama 模型也需先拉取。所需依赖和模型均缓存完成后，日常翻译可断网使用。

## 数据流与限制

`单个区域截图 → 本地 FastAPI → MangaOCR 日文识别 → Ollama 文本翻译 → 扩展显示结果`

Ollama 请求仅包含 OCR 文本和翻译格式指令，不包含图像。文本模型看不到画面，因此角色语气、专名、拟声词和省略表达可能缺少上下文而误译；OCR 漏字也会传递到译文。当前版本不自动识别完整气泡边界，不会擦除原文或按原位置回填译文。

## 常见问题

- **无法连接本机 Ollama**：确认 Ollama 正在运行，并检查 `OLLAMA_BASE_URL`。默认服务地址为 `http://127.0.0.1:11434`。
- **模型未下载**：在终端执行 `ollama pull qwen2.5:7b`，或在扩展设置中填写已安装的模型名。可用 `ollama list` 查看模型。
- **Ollama 响应格式异常**：确认模型可正常响应；重试前可在终端运行 `ollama run qwen2.5:7b`。接口要求 JSON 数组数量与 OCR 条目数一致。
- **首次 OCR 慢或失败**：首次运行需初始化 MangaOCR 模型。确认安装依赖时网络可用，并为模型文件和运行时预留足够磁盘及内存。每次请框选一个文字区域；一次选中多个气泡时，MangaOCR 不会自动拆分。
- **翻译不符合画面或专名不稳定**：文本模型不接收图像。可在原文条目中核对 OCR 结果，或选择能力更强的本地文本模型；不要将图片上下文误认为模型可见。

## 验收建议

使用本地真实漫画样本检查 MangaOCR 识别准确度、专名/语气/省略语翻译质量，并记录每次翻译耗时和峰值内存。对比不同 Ollama 文本模型时使用相同样本和硬件。仓库当前未包含可分发的漫画样本，因此这些识别质量与硬件性能指标需要在目标机器上实测。
