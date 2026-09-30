import re
from functools import lru_cache

from PIL import Image, ImageEnhance, ImageOps
from manga_ocr import MangaOcr


@lru_cache(maxsize=1)
def get_engine():
    return MangaOcr()


def _prepare_image(image):
    img = image.convert("RGB")
    width, height = img.size
    max_side = max(width, height)
    scale = 1.0

    if max_side < 512:
        scale = 512 / max_side
    elif max_side > 1800:
        scale = 1800 / max_side

    if scale != 1.0:
        img = img.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )

    img = ImageOps.autocontrast(img)
    img = ImageEnhance.Contrast(img).enhance(1.5)
    return img


def _normalize_texts(raw_text):
    if raw_text is None:
        return []

    if isinstance(raw_text, (list, tuple)):
        texts = [str(item).strip() for item in raw_text]
    else:
        texts = [str(raw_text).strip()]

    normalized = []
    for text in texts:
        for line in re.split(r"\r?\n+", text):
            cleaned = " ".join(line.split())
            if cleaned:
                normalized.append(cleaned)
    return normalized


def recognize(image):
    prepared = _prepare_image(image)
    raw = get_engine()(prepared)
    return _normalize_texts(raw)