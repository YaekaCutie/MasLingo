import base64
import json
import time
from io import BytesIO

import requests
from PIL import Image

DEFAULT_MODEL = "gemini-3.8-flash"
BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
FALLBACK_MODELS = (
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
)
RETIRED_MODEL_REPLACEMENTS = {
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
}

class GeminiError(RuntimeError):
    def __init__(self, message, fallback_allowed=False):
        super().__init__(message)
        self.fallback_allowed = fallback_allowed

def _image_part(image):
    context_image = image.copy()
    context_image.thumbnail((2048, 2048))
    buffer = BytesIO()
    context_image.save(buffer, format="JPEG", quality=90, optimize=True)
    return {
        "inline_data": {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(buffer.getvalue()).decode("ascii")
        }
    }

def _translate_with_model(items, api_key, model, image):
    numbered = "\n".join(f"{i+1}. {x}" for i, x in enumerate(items))
    if image is not None:
        prompt = (
            "你是专业日中翻译器。请直接检查附图的全部区域，识别并翻译其中每一条独立可见的日文短语；不要只看第一条或只看本地 OCR 识别结果。"
            "从上到下阅读，同一行先左后右。列表可能混有中文释义、英文、分类标题、按钮和图标，这些都不是日文待翻译内容，不要输出。"
            "本地 OCR 文本仅供校对，可能不完整或错误；不能限制你从图片中识别出的日文条目数量。图片中日文旁若有中文释义，只输出日文原文及其中文翻译，不重复图片里已有的中文。"
            "严格忠实原文，不补写图片之外的内容，不合并、遗漏或重排日文条目；原文没有省略号就不要添加。难以辨认的日文原文也要保留，并将译文标为“[无法辨认]”。"
            "返回 JSON 数组，每项只包含 source_text（日文原文）和 translated_text（简体中文译文）；非日文不输出。数组长度以图片中实际识别到的日文条目为准。\n\n"
            "本地 OCR 参考（可能不完整）：\n"
            + (numbered or "（未识别到文字）")
        )
    else:
        prompt = (
            "你是专业日中翻译器。把下面所有日语逐条翻译成简洁的简体中文，保持输入顺序，不要解释或合并条目。"
            "严格返回与输入数量相同的 JSON 数组，每个元素只有 translated_text 字段。\n\n"
            + numbered
        )

    parts = [{"text": prompt}]
    if image is not None:
        parts.append(_image_part(image))

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json"
        }
    }

    url = f"{BASE_URL}/models/{model}:generateContent"
    last_error = None

    for attempt in range(3):
        try:
            r = requests.post(
                url,
                params={"key": api_key},
                json=payload,
                timeout=90
            )
            if r.status_code == 429:
                detail = ""
                try:
                    detail = r.json().get("error", {}).get("message", "")
                except Exception:
                    pass
                last_error = GeminiError(
                    f"Gemini 请求被限流（HTTP 429）：{detail}"
                    if detail else "Gemini 请求被限流（HTTP 429），请稍后重试或检查 API 配额",
                    fallback_allowed=True
                )
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                break
            r.raise_for_status()

            data = r.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)

            if not isinstance(parsed, list) or (image is None and len(parsed) != len(items)):
                raise GeminiError("Gemini 返回条目数量与 OCR 结果不一致", fallback_allowed=True)

            out = []
            for index, value in enumerate(parsed):
                if not isinstance(value, dict):
                    raise GeminiError("Gemini JSON 格式错误", fallback_allowed=True)
                source = value.get("source_text") if image is not None else items[index]
                if not isinstance(source, str) or not source.strip():
                    raise GeminiError("Gemini 返回条目缺少 OCR 原文", fallback_allowed=True)
                out.append({
                    "source_text": source.strip(),
                    "translated_text": str(value.get("translated_text", "")).strip()
                })
            return out

        except requests.HTTPError as e:
            detail = ""
            try:
                detail = r.json().get("error", {}).get("message", "")
            except Exception:
                pass
            status = getattr(e.response, "status_code", 0)
            last_error = GeminiError(detail or f"Gemini HTTP {status}", fallback_allowed=status not in (401, 403))
            if getattr(e.response, "status_code", 0) in (401, 403, 404):
                break
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            last_error = GeminiError(f"Gemini 返回格式异常：{e}", fallback_allowed=True)
            break
        except GeminiError as e:
            last_error = e
            break
        except Exception as e:
            last_error = GeminiError(str(e))

    if last_error:
        raise last_error
    raise GeminiError("Gemini 请求失败")

def translate_batch(items, api_key, model=DEFAULT_MODEL, image=None, auto_fallback=False):
    if not api_key:
        raise GeminiError("未设置 Gemini API Key")
    if not items and image is None:
        return [], model

    if model in RETIRED_MODEL_REPLACEMENTS:
        replacement = RETIRED_MODEL_REPLACEMENTS[model]
        if not auto_fallback:
            raise GeminiError(f"所选模型 {model} 已停用，请改用 {replacement} 或开启自动降级")
        model = replacement

    if auto_fallback and model in FALLBACK_MODELS:
        models = FALLBACK_MODELS[FALLBACK_MODELS.index(model):]
    else:
        models = (model,)

    previous_errors = []
    for index, candidate in enumerate(models):
        try:
            return _translate_with_model(items, api_key, candidate, image), candidate
        except GeminiError as error:
            if index == 0 and (not auto_fallback or not error.fallback_allowed):
                raise
            previous_errors.append(f"{candidate}: {error}")
            if not error.fallback_allowed or index == len(models) - 1:
                raise GeminiError("自动降级模型均失败：" + "；".join(previous_errors)) from error

    raise GeminiError("Gemini 请求失败")

def test_model(api_key, model=DEFAULT_MODEL):
    if not api_key:
        raise GeminiError("未设置 Gemini API Key")

    url = f"{BASE_URL}/models/{model}"
    try:
        r = requests.get(url, params={"key": api_key}, timeout=20)
        r.raise_for_status()
        data = r.json()
        return {
            "model": data.get("baseModelId") or model,
            "display_name": data.get("displayName", ""),
            "input_token_limit": data.get("inputTokenLimit"),
            "output_token_limit": data.get("outputTokenLimit")
        }
    except requests.HTTPError:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except Exception:
            msg = ""
        raise GeminiError(msg or str(r))
    except Exception as e:
        raise GeminiError(str(e))