from functools import lru_cache

import numpy as np
from manga_ocr import MangaOcr
from paddleocr import PaddleOCR


@lru_cache(maxsize=1)
def get_engine():
    return PaddleOCR(
        lang="japan",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        engine="paddle",
    )


@lru_cache(maxsize=1)
def get_manga_ocr():
    return MangaOcr()


def _result_data(result):
    if isinstance(result, dict):
        data = result
    else:
        data = getattr(result, "json", {})
        if callable(data):
            data = data()
    return data.get("res", data) if isinstance(data, dict) else {}


def recognize(image):
    source = image.convert("RGB")
    rgb = np.asarray(source)
    results = get_engine().predict(rgb)
    entries = []

    for result in results:
        data = _result_data(result)
        texts = data.get("rec_texts", [])
        boxes = data.get("dt_polys", data.get("rec_polys", []))
        for text, polygon in zip(texts, boxes):
            if not str(text).strip():
                continue
            points = np.asarray(polygon)
            center_x = float(points[:, 0].mean())
            center_y = float(points[:, 1].mean())
            left = max(0, int(np.floor(points[:, 0].min())) - 3)
            top = max(0, int(np.floor(points[:, 1].min())) - 3)
            right = min(source.width, int(np.ceil(points[:, 0].max())) + 4)
            bottom = min(source.height, int(np.ceil(points[:, 1].max())) + 4)
            crop = source.crop((left, top, right, bottom))
            cleaned = str(get_manga_ocr()(crop)).strip()
            if cleaned:
                entries.append((center_x, center_y, cleaned))

    entries.sort(key=lambda item: (-item[0], item[1]))
    return [text for _, _, text in entries]