import logging

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import UnidentifiedImageError

from .image.decode import decode_image
from .ocr.manga_ocr_engine import recognize
from .translation.local_translator import translate_texts

app = FastAPI(title="MangaOCR Local Backend")
logger = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 15 * 1024 * 1024


class TranslationRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.get("/health")
def health():
    return {"ok": True, "backend": "ready", "ocr": "mangaocr"}


@app.post("/api/translate-text")
async def translate_text(request: TranslationRequest):
    items = [str(text).strip() for text in request.texts if str(text).strip()]
    if not items:
        raise HTTPException(400, "未提供可翻译文本。")

    try:
        translated = translate_texts(items)
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
        texts = recognize(img)
        return {
            "ok": True,
            "items": [{"text": text} for text in texts]
        }
    except UnidentifiedImageError as e:
        raise HTTPException(415, "无法识别图片格式，请上传 PNG、JPEG、WEBP 等有效图片。") from e
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("本地漫画 OCR 处理失败")
        raise HTTPException(500, "本地 OCR 服务处理失败，请查看后端日志。") from e