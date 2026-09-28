from functools import lru_cache

import numpy as np
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


def _result_data(result):
    if isinstance(result, dict):
        data = result
    else:
        data = getattr(result, "json", {})
        if callable(data):
            data = data()
    return data.get("res", data) if isinstance(data, dict) else {}


def recognize(image):
    rgb = np.asarray(image.convert("RGB"))
    results = get_engine().predict(rgb)
    entries = []

    for result in results:
        data = _result_data(result)
        texts = data.get("rec_texts", [])
        boxes = data.get("dt_polys", data.get("rec_polys", []))
        for text, polygon in zip(texts, boxes):
            cleaned = str(text).strip()
            if not cleaned:
                continue
            points = np.asarray(polygon)
            center_x = float(points[:, 0].mean())
            center_y = float(points[:, 1].mean())
            entries.append((center_x, center_y, cleaned))

    entries.sort(key=lambda item: (-item[0], item[1]))
    return [text for _, _, text in entries]