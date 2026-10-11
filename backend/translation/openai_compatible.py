"""OpenAI Chat Completions-compatible translation client."""

import json
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin

from ..net_guard import assert_safe_endpoint


class _GuardedRedirectHandler(urllib_request.HTTPRedirectHandler):
    """Validate every redirect hop before it is followed.

    urllib follows 3xx by default, so a caller-supplied endpoint — which already
    passed the app's initial check — used to be able to bounce the request to
    169.254.169.254 or any other blocked address. The app checks the address the
    caller named; this checks where that address tries to send us next.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urljoin(req.full_url, newurl)
        try:
            assert_safe_endpoint(target)
        except ValueError as exc:
            # RuntimeError is what the route maps to a readable 503.
            raise RuntimeError(f"翻译接口重定向到不允许的地址：{exc}") from exc
        return super().redirect_request(req, fp, code, msg, headers, target)


_opener = urllib_request.build_opener(_GuardedRedirectHandler)


def translate_texts(texts: list[str], endpoint: str, model: str, api_key: str) -> list[str]:
    endpoint = endpoint.strip()
    model = model.strip()
    if not endpoint or not model:
        raise RuntimeError("请配置 OpenAI-compatible 接口地址和模型。")
    if not endpoint.startswith(("https://", "http://")):
        raise RuntimeError("翻译接口地址必须以 http:// 或 https:// 开头。")

    request = urllib_request.Request(
        endpoint,
        data=json.dumps({
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是专业日漫本地化译者。结合本批所有条目理解上下文、角色关系、"
                        "语气和指代，再将每条日文 OCR 文本译成自然、简洁的简体中文。"
                        "忠实保留原意，不增译、不漏译、不解释；人名和专有名词保持一致，"
                        "口语、敬语、情绪和拟声词按语境自然处理。若条目本身不是日文，"
                        "原样保留。严格按输入编号逐条输出，编号、顺序和条目数量必须一致，"
                        "每行一个条目，不要添加标题或其他内容。"
                    ),
                },
                {
                    "role": "user",
                    "content": "\n".join(f"{index + 1}. {text}" for index, text in enumerate(texts)),
                },
            ],
            "temperature": 0.1,
        }).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        },
        method="POST",
    )
    try:
        with _opener.open(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
        content = payload["choices"][0]["message"]["content"]
    except (urllib_error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("OpenAI-compatible 翻译接口请求失败或响应格式无效。") from exc

    lines = [line.strip() for line in str(content).splitlines() if line.strip()]
    translations = []
    for line in lines:
        # Accept numbered lists commonly returned by chat-completion models.
        if line[:1].isdigit() and ". " in line[:5]:
            line = line.split(". ", 1)[1]
        translations.append(line.strip())
    if len(translations) != len(texts):
        raise RuntimeError("翻译接口返回的译文数量与原文不一致。")
    return translations
