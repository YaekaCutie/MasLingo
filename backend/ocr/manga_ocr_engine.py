from manga_ocr import MangaOcr
_engine=None
def get_engine():
    global _engine
    if _engine is None:
        _engine=MangaOcr()
    return _engine
def recognize(img):
    return get_engine()(img)
def is_loaded():
    return _engine is not None