# MangaOCR Local Reader 0.0.1

完全本地运行的日文漫画 OCR Chrome 扩展。用户框选单个文字区域后，扩展把截图发送到本机 FastAPI，由 MangaOCR 直接识别日文并显示识别结果。不使用云端 API、API Key 或收费服务。

识别模型由 MangaOCR 管理，首次运行时会初始化本地 OCR 模型。

## 安装与运行

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


3. 在 Chrome 打开“扩展程序 → 开发者模式 → 加载已解压的扩展程序”，选择项目的 `extension` 文件夹。

不需要 API Key。OCR 在本机运行。首次安装依赖和首次启动 OCR 时可能需要联网下载 Python 包及 OCR 模型文件；模型缓存完成后，日常识别可断网使用。

## 数据流与限制

`单个区域截图 → 本地 FastAPI → MangaOCR 日文识别 → 扩展显示结果`

当前版本不自动识别完整气泡边界，不会翻译、擦除原文或按原位置回填译文。
后端通过灰度阈值建立正方形密度网格，比较横向和纵向的有效像素邻接关系来判断排版方向；方向明确且列间距清晰时，竖排文本会逐列识别并从右向左拼接。方向不明显时会回退为整图识别。复杂背景、装饰线或列间距不明显时，建议一次框选一个文字区域。

## 常见问题

- **首次 OCR 慢或失败**：首次运行需初始化 MangaOCR 模型。确认安装依赖时网络可用，并为模型文件和运行时预留足够磁盘及内存。每次请框选一个文字区域；一次选中多个气泡时，MangaOCR 不会自动拆分。
- **识别结果为空**：放大框选区域并确保文字清晰；一次请框选一个文字区域。
