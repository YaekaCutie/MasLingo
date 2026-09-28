# Manga Translator — Gemini API + 批量翻译 + UI

当前版本提供：
- Chrome 扩展设置页面
- 用户自行输入 Gemini API Key
- API Key 保存在 Chrome 扩展的 local storage
- 可以显示/隐藏 Key
- 可以测试 Key + 所选模型
- 当前支持手动选择 Gemini 模型
- 默认模型：gemini-3.8-flash
- 一个选区尽量只产生一次 Gemini 翻译请求，批量翻译多条 OCR 文本
- Gemini Key 不写进代码，也不放进 `.env`

## 安装

在 VS Code 终端进入项目目录：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
```

启动后端：

```powershell
.\start-backend.ps1
```

然后 Chrome：
扩展程序 → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension` 文件夹。

第一次使用：
点击扩展右上角齿轮 → 填入自己的 Gemini API Key → 选择模型 → 保存 → 测试 API Key。

Gemini API Key 不会写入项目文件。浏览器只把它放在扩展自己的 local storage 中；真正翻译时，扩展把 Key 放到发往本机 `127.0.0.1:8001` 的请求 Header 中，再由本机后端请求 Gemini。

## 当前功能边界

现在仍然是 V1：用户选择一块漫画区域，本地 OCR 后批量提交 Gemini。
还没有做到：
1. 自动识别每个气泡的独立坐标；
2. 精确擦除原日文并按气泡位置回填中文；
3. 自动选择最合适 Gemini 模型；
4. 全页自动翻译、缓存和配额管理。

这些可以在下一版继续加入。
