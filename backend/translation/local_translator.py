import json
import os
import re
import urllib.parse
from typing import Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request

FREE_TRANSLATE_API = os.getenv(
    "FREE_TRANSLATE_API",
    "https://translate.googleapis.com/translate_a/single",
)
_JAPANESE_RE = re.compile(r"[\u3040-\u30ff]")


def _split_mixed_segments(text: str) -> list[str]:
    if not text:
        return []

    segments = []
    current = []
    current_is_japanese = None

    for ch in text:
        is_japanese = bool(_JAPANESE_RE.fullmatch(ch))
        if current and current_is_japanese is not None and is_japanese != current_is_japanese:
            segments.append("".join(current))
            current = []
        current.append(ch)
        current_is_japanese = is_japanese

    if current:
        segments.append("".join(current))

    return segments


def _translate_single(text: str) -> str:
    params = {
        "client": "gtx",
        "sl": "auto",
        "tl": "zh-CN",
        "dt": "t",
        "q": text,
    }
    url = f"{FREE_TRANSLATE_API}?{urllib.parse.urlencode(params)}"
    req = urllib_request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="GET")

    try:
        with urllib_request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib_error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise RuntimeError("免费翻译服务不可用，请稍后重试。") from exc

    try:
        return payload[0][0][0].strip()
    except (TypeError, IndexError, KeyError):
        return text.strip()


def translate_texts(texts: Sequence[str]) -> list[str]:
    cleaned = [str(text).strip() for text in texts if str(text).strip()]
    if not cleaned:
        return []

    translated = []
    for text in cleaned:
        pieces = []
        for segment in _split_mixed_segments(text):
            if segment and _JAPANESE_RE.search(segment):
                pieces.append(_translate_single(segment))
            else:
                pieces.append(segment)
        translated.append("".join(pieces))
    return translated
