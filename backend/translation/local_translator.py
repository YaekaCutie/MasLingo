from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import os
import time
import urllib.parse
from typing import Optional, Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request

FREE_TRANSLATE_API = os.getenv(
    "FREE_TRANSLATE_API",
    "https://translate.googleapis.com/translate_a/single",
)
MAX_TRANSLATE_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 5


def _retry_delay(exc: urllib_error.HTTPError, attempt: int) -> Optional[float]:
    retry_after = exc.headers.get("Retry-After") if exc.headers else None
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                delay = (retry_at - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                delay = 0.5 * (2 ** attempt)
        if delay > MAX_RETRY_AFTER_SECONDS:
            return None
        return max(0.0, delay)
    return 0.5 * (2 ** attempt)


def _translate_single(text: str) -> str:
    params = {
        "client": "gtx",
        "sl": "ja",
        "tl": "zh-CN",
        "dt": "t",
        "q": text,
    }
    url = f"{FREE_TRANSLATE_API}?{urllib.parse.urlencode(params)}"
    req = urllib_request.Request(url, headers={"User-Agent": "Mozilla/5.0"}, method="GET")

    payload = None
    for attempt in range(MAX_TRANSLATE_ATTEMPTS):
        try:
            with urllib_request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            break
        except urllib_error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            can_retry = retryable and attempt + 1 < MAX_TRANSLATE_ATTEMPTS
            delay = _retry_delay(exc, attempt) if can_retry else None
            if delay is not None:
                time.sleep(delay)
                continue
            if exc.code == 429:
                raise RuntimeError("免费翻译服务请求过于频繁，请稍后重试。") from exc
            raise RuntimeError("免费翻译服务不可用，请稍后重试。") from exc
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

    return [_translate_single(text) for text in cleaned]
