import json
import os

import requests

DEFAULT_MODEL = "qwen2.5:7b"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")


class OllamaError(RuntimeError):
    pass


def _request(method, path, **kwargs):
    try:
        response = requests.request(
            method,
            f"{OLLAMA_BASE_URL}{path}",
            timeout=kwargs.pop("timeout", 180),
            **kwargs,
        )
    except requests.RequestException as error:
        raise OllamaError(
            "无法连接本机 Ollama。请启动 Ollama，并确认服务地址为 "
            f"{OLLAMA_BASE_URL}。"
        ) from error

    if not response.ok:
        try:
            detail = response.json().get("error", "")
        except (ValueError, AttributeError):
            detail = ""
        if "model" in detail.lower() and "not found" in detail.lower():
            raise OllamaError("Ollama 模型未下载。请检查模型名称并运行 `ollama pull <模型名>`。")
        raise OllamaError(detail or f"Ollama 返回 HTTP {response.status_code}")
    return response


def test_connection(model=DEFAULT_MODEL):
    response = _request("GET", "/api/tags", timeout=10)
    try:
        models = [item.get("name", "") for item in response.json().get("models", [])]
    except (ValueError, AttributeError, TypeError) as error:
        raise OllamaError("Ollama 返回格式异常，无法读取本机模型列表。") from error
    if model not in models:
        available = ", ".join(models) or "无"
        raise OllamaError(
            f"本机未找到模型 {model}。请运行 `ollama pull {model}`。"
            f"当前已安装模型：{available}。"
        )
    return {"model": model, "installed_models": models}


def translate_batch(items, model=DEFAULT_MODEL):
    if not items:
        return []

    payload = {
        "model": model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是专业的日中漫画翻译器。将给定的日文 OCR 条目逐条翻译为自然简体中文。"
                    "你只能依据文本，不会看到漫画图片；不得猜测画面信息。"
                    "保留条目顺序，不合并、不遗漏、不解释。严格返回 JSON 对象，"
                    "格式为 {\"translations\":[\"译文1\",\"译文2\"]}，"
                    "数组长度必须与 OCR 条目数完全相同。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"ocr_items": items}, ensure_ascii=False),
            },
        ],
    }
    response = _request("POST", "/api/chat", json=payload)
    try:
        content = response.json()["message"]["content"]
        parsed = json.loads(content)
        translations = parsed["translations"]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise OllamaError("Ollama 返回格式异常，无法读取翻译结果。") from error

    if (
        not isinstance(translations, list)
        or len(translations) != len(items)
        or any(not isinstance(value, str) or not value.strip() for value in translations)
    ):
        raise OllamaError("Ollama 返回条目数量或译文格式与 OCR 结果不一致。")

    return [
        {"source_text": source, "translated_text": translated.strip()}
        for source, translated in zip(items, translations)
    ]