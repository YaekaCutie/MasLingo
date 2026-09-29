from functools import lru_cache

from manga_ocr import MangaOcr


@lru_cache(maxsize=1)
def get_engine():
    return MangaOcr()


def recognize(image):
    text = str(get_engine()(image.convert("RGB"))).strip()
    return [text] if text else []