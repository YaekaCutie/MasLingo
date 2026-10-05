"""MangaOCR backend.

The same app serves two very different deployments:

* the original local-only mode, where one user runs it on loopback, and
* a shared public instance, where many strangers hit one small free VM.

The public case needs three things the local one does not, so they are all
controlled by environment variables that default to the local behaviour:

* inference runs off the event loop, so one slow page no longer blocks every
  other request (and ``/health`` keeps answering while OCR is busy);
* OCR concurrency is capped, so a 4-core box is not thrashed by parallel pages;
* a per-IP rate limit keeps a single client from monopolising the instance.
"""

import asyncio
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from PIL import UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from .image.decode import decode_image
from .ocr.bubble_detector import MAX_TEXT_REGIONS, detect_text_regions
from .ocr.manga_ocr_engine import get_engine, recognize, recognize_detailed
from .translation.local_translator import translate_texts
from .translation.openai_compatible import translate_texts as translate_openai_compatible

logger = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 15 * 1024 * 1024

# uvicorn only configures its own loggers, so without this our own messages
# (including the model preload line the deployment guide tells operators to
# look for) would never reach the container logs.
logging.basicConfig(
    level=os.getenv("OMT_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

OCR_CONCURRENCY = max(1, int(os.getenv("OMT_OCR_CONCURRENCY", "2")))
RATE_LIMIT_REQUESTS = int(os.getenv("OMT_RATE_LIMIT_REQUESTS", "0"))
RATE_LIMIT_WINDOW = float(os.getenv("OMT_RATE_LIMIT_WINDOW", "60"))
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("OMT_ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]
ENABLE_FREE_TRANSLATE = os.getenv("OMT_ENABLE_FREE_TRANSLATE", "1") != "0"
TORCH_THREADS = int(os.getenv("OMT_TORCH_THREADS", "0"))
PRELOAD_MODEL = os.getenv("OMT_PRELOAD_MODEL", "1") != "0"

if TORCH_THREADS > 0:
    # Small VMs benefit from an explicit cap: torch otherwise spawns one
    # thread per visible core and each OCR call fights the others.
    import torch

    torch.set_num_threads(TORCH_THREADS)


@asynccontextmanager
async def lifespan(_app):
    """Load the OCR model before serving.

    Besides making the first request fast, this keeps a few GB resident. That
    matters on Oracle's Always Free tier, which may reclaim an instance whose
    memory utilisation stays under 20% for a week.
    """
    if PRELOAD_MODEL:
        try:
            await run_in_threadpool(get_engine)
            logger.info("MangaOCR 模型已预加载并常驻内存")
        except Exception:
            logger.exception("预加载 MangaOCR 模型失败，将在首次请求时重试")
    yield


app = FastAPI(title="MangaOCR Backend", lifespan=lifespan)

_ocr_slots = asyncio.Semaphore(OCR_CONCURRENCY)
_ocr_busy = 0
_rate_hits: dict[str, deque] = defaultdict(deque)
_rate_lock = asyncio.Lock()


def _has_readable_text(text: str) -> bool:
    return sum(character.isalnum() for character in text) >= 4


class TranslationRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)
    mode: str = "none"
    endpoint: str = ""
    model: str = ""
    api_key: str = ""


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _client_ip(request) -> str:
    """Client address, honouring the reverse proxy's X-Forwarded-For."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def limit_requests(request, call_next):
    if RATE_LIMIT_REQUESTS <= 0 or request.url.path == "/health":
        return await call_next(request)

    client = _client_ip(request)
    now = time.monotonic()
    async with _rate_lock:
        if len(_rate_hits) > 20000:
            _rate_hits.clear()
        bucket = _rate_hits[client]
        while bucket and now - bucket[0] > RATE_LIMIT_WINDOW:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_REQUESTS:
            retry_after = max(1, int(RATE_LIMIT_WINDOW - (now - bucket[0])))
            return JSONResponse(
                {"detail": f"请求过于频繁，请在 {retry_after} 秒后重试。"},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)
    return await call_next(request)


class _ocr_slot:
    """Hold one OCR worker slot and run blocking work in a thread."""

    async def __aenter__(self):
        global _ocr_busy
        await _ocr_slots.acquire()
        _ocr_busy += 1
        return self

    async def __aexit__(self, *_exc):
        global _ocr_busy
        _ocr_busy -= 1
        _ocr_slots.release()
        return False


@app.get("/health")
def health():
    return {
        "ok": True,
        "backend": "ready",
        "ocr": "mangaocr",
        "busy": _ocr_busy,
        "concurrency": OCR_CONCURRENCY,
        "free_translate": ENABLE_FREE_TRANSLATE,
    }


@app.post("/api/translate-text")
async def translate_text(request: TranslationRequest):
    items = [str(text).strip() for text in request.texts if str(text).strip()]
    if not items:
        raise HTTPException(400, "未提供可翻译文本。")

    try:
        if request.mode == "none":
            translated = items
        elif request.mode == "free-translate":
            if not ENABLE_FREE_TRANSLATE:
                raise HTTPException(
                    400,
                    "此服务器已禁用 Google 翻译，请在扩展设置里改用 OpenAI-compatible API。",
                )
            translated = await run_in_threadpool(translate_texts, items)
        elif request.mode == "openai-compatible":
            translated = await run_in_threadpool(
                translate_openai_compatible,
                items,
                request.endpoint,
                request.model,
                request.api_key,
            )
        else:
            raise HTTPException(400, "不支持的翻译模式。")
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    if len(translated) != len(items):
        translated = translated[: len(items)] + [items[-1]] * max(0, len(items) - len(translated))

    return {
        "ok": True,
        "items": [
            {"text": original, "translated": translated_text}
            for original, translated_text in zip(items, translated)
        ],
    }


async def _read_image(upload: UploadFile) -> bytes:
    data = bytearray()
    while chunk := await upload.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "图片过大，不能超过 15 MB。")
    if not data:
        raise HTTPException(400, "未提供图片内容。")
    return bytes(data)


@app.post("/api/recognize-image")
async def recognize_image(
    image: UploadFile = File(...)
):
    raw = await _read_image(image)

    try:
        img = decode_image(raw)
        async with _ocr_slot():
            result = await run_in_threadpool(recognize_detailed, img)
        return {
            "ok": True,
            # The front end lays the translation out with this, so it has to come
            # from the same decision that drove recognition.
            "direction": result["direction"],
            "items": [{"text": text} for text in result["texts"]]
        }
    except UnidentifiedImageError as e:
        raise HTTPException(415, "无法识别图片格式，请上传 PNG、JPEG、WEBP 等有效图片。") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("本地漫画 OCR 处理失败")
        raise HTTPException(500, "本地 OCR 服务处理失败，请查看后端日志。") from e


def _recognize_page_sync(img) -> list[dict]:
    """Detect text groups in a full screenshot and OCR each group."""
    regions = detect_text_regions(img, limit=MAX_TEXT_REGIONS)
    logger.info("自动页面 OCR 检测到 %d 个区域（上限 %d）", len(regions), MAX_TEXT_REGIONS)
    items = []
    for index, (left, top, right, bottom) in enumerate(regions, start=1):
        logger.info("自动页面 OCR 进度 %d/%d", index, len(regions))
        region = img.crop((left, top, right, bottom))
        detailed = recognize_detailed(region)
        text = "\n".join(detailed["texts"]).strip()
        if _has_readable_text(text):
            items.append({
                "text": text,
                "bbox": {"left": left, "top": top, "right": right, "bottom": bottom},
                # Reported per region so the extension typesets each one the way
                # it was actually read.
                "direction": detailed["direction"],
            })
    return items


@app.post("/api/recognize-page")
async def recognize_page(image: UploadFile = File(...)):
    """Detect text groups in a full screenshot and OCR each group locally."""
    raw = await _read_image(image)
    try:
        img = decode_image(raw)
        async with _ocr_slot():
            items = await run_in_threadpool(_recognize_page_sync, img)
        return {"ok": True, "items": items}
    except UnidentifiedImageError as exc:
        raise HTTPException(415, "无法识别图片格式，请上传 PNG、JPEG、WEBP 等有效图片。") from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("本地漫画页面 OCR 处理失败")
        raise HTTPException(500, "本地 OCR 服务处理失败，请查看后端日志。") from exc
