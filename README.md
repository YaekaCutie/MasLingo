# Manga Translator — PaddleOCR + Ollama 视觉翻译

方案一：本地 PaddleOCR 识别日文，再让 Ollama 视觉模型结合原图和 OCR 文本进行批量翻译。无需云端 API 或按次付费。

默认翻译模型为 `qwen2.5vl:7b`。运行需要能够加载该模型的本机内存或显存；首次拉取需要网络。

## 安装

在 VS Code 终端进入项目目录：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
```

安装并启动 Ollama，然后下载视觉模型：

```powershell
ollama pull qwen2.5vl:7b
```

Ollama 默认监听 `http://127.0.0.1:11434`。如使用其他本机地址，编辑 `backend\.env` 中的 `OLLAMA_BASE_URL`。

启动后端：

```powershell
.\start-backend.ps1
```

然后 Chrome：
扩展程序 → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension` 文件夹。

Chrome 加载 `extension` 文件夹后，打开扩展设置，填写已下载的 Ollama 模型名称，点击“测试本机模型”确认 Ollama 正在运行且视觉模型已安装。默认设置无需 API Key。

流程为：区域截图 → 本地 PaddleOCR → 本机 Ollama 视觉翻译 → 扩展显示逐条译文。图片和 OCR 文本都只发往本机 Ollama；PaddleOCR 首次运行可能需要联网下载模型文件。

## 当前功能边界

现在仍然是 V1：用户选择一块漫画区域，本地 OCR 后批量调用本机视觉模型。
还没有做到：
1. 自动识别每个气泡的独立坐标；
2. 精确擦除原日文并按气泡位置回填中文；
3. 自动选择最合适本地视觉模型；
4. 全页自动翻译、缓存和配额管理。

这些可以在下一版继续加入。
