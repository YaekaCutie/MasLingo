"""Local comic text detection and glyph segmentation with an ONNX model.

The legacy ink heuristic remains available through MAS_TEXT_DETECTOR=heuristic.
The model is fetched once, checked by SHA-256, and never receives network images.
"""
from functools import lru_cache
import hashlib
import logging
import os
from pathlib import Path
import tempfile
import urllib.request

import numpy as np
from PIL import Image

from .bubble_detector import MAX_TEXT_REGIONS, detect_text_regions as detect_heuristic

logger = logging.getLogger(__name__)
MODEL_URL = "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt.onnx"
MODEL_SHA256 = "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f"
MODEL_SIZE = 1024


class TextRegions(list):
    def __init__(self, boxes, mask):
        super().__init__(boxes)
        self.mask = mask


def model_path():
    override = os.getenv("MAS_TEXT_DETECTOR_MODEL")
    if override:
        return Path(override)
    bundled = Path(__file__).resolve().parents[2] / "models" / "comictextdetector.onnx"
    if bundled.is_file():
        return bundled
    cache = Path(os.getenv("HF_HOME", str(Path.home() / ".cache" / "huggingface")))
    return cache / "maslingo" / "comictextdetector.onnx"


def ensure_model():
    path = model_path()
    if path.is_file():
        if hashlib.sha256(path.read_bytes()).hexdigest() == MODEL_SHA256:
            return path
        raise RuntimeError(f"文字检测模型校验失败，请删除后重新安装：{path}")
    if os.getenv("MAS_TEXT_DETECTOR_MODEL"):
        raise RuntimeError(f"找不到文字检测模型：{path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    logger.info("首次下载漫画文字检测模型（约 95 MB）")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as target:
            temp_path = Path(target.name)
            with urllib.request.urlopen(MODEL_URL, timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
        if hashlib.sha256(temp_path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise RuntimeError("文字检测模型下载不完整或校验失败，请重试安装。")
        temp_path.replace(path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return path


@lru_cache(maxsize=1)
def get_detector():
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(os.getenv("MAS_TORCH_THREADS", "2")))
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(ensure_model()), sess_options=options,
                                providers=["CPUExecutionProvider"])


def _overlap(first, second):
    intersection = max(0, min(first[2], second[2]) - max(first[0], second[0])) * max(
        0, min(first[3], second[3]) - max(first[1], second[1]))
    area = lambda box: max(1, (box[2] - box[0]) * (box[3] - box[1]))
    return intersection / min(area(first), area(second))


def _group_lines(lines):
    """Split a coarse block at paragraph gaps, keeping neighbouring columns.

    A block proposal can span two balloons. DB's shrunk line rectangles retain
    the column spacing that distinguishes them; expanding them before grouping
    destroys that evidence and bridges the balloons again.
    """
    parents = list(range(len(lines)))

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def close(a, b):
        aw, ah, bw, bh = a[2]-a[0], a[3]-a[1], b[2]-b[0], b[3]-b[1]
        a_vertical = ah > aw * 1.4
        b_vertical = bh > bw * 1.4
        a_horizontal = aw > ah * 1.4
        b_horizontal = bw > bh * 1.4
        if (a_vertical and b_horizontal) or (b_vertical and a_horizontal):
            return False
        vertical = a_vertical or b_vertical or not (a_horizontal or b_horizontal)
        x_overlap = max(0, min(a[2], b[2])-max(a[0], b[0]))
        y_overlap = max(0, min(a[3], b[3])-max(a[1], b[1]))
        x_gap = max(0, max(a[0], b[0])-min(a[2], b[2]))
        y_gap = max(0, max(a[1], b[1])-min(a[3], b[3]))
        if vertical:
            return ((y_overlap >= min(ah, bh)*0.35 and x_gap <= max(aw, bw)*2.2) or
                    (x_overlap >= min(aw, bw)*0.4 and y_gap <= max(aw, bw)*1.5))
        return ((x_overlap >= min(aw, bw)*0.35 and y_gap <= max(ah, bh)*2.2) or
                (y_overlap >= min(ah, bh)*0.4 and x_gap <= max(ah, bh)*1.5))

    for index, line in enumerate(lines):
        for other in range(index):
            if close(line, lines[other]):
                parents[root(index)] = root(other)
    groups = {}
    for index, line in enumerate(lines):
        groups.setdefault(root(index), []).append(line)
    return list(groups.values())


def _line_bounds(group, glyphs, width, height):
    """Recover line fringes from glyph evidence without including balloon art."""
    font = float(np.median([min(line[2]-line[0], line[3]-line[1]) for line in group]))
    fringe = max(2, round(font * 0.6))
    left = max(0, int(min(line[0] for line in group)-fringe))
    top = max(0, int(min(line[1] for line in group)-fringe))
    right = min(width, int(max(line[2] for line in group)+fringe+1))
    bottom = min(height, int(max(line[3] for line in group)+fringe+1))
    ys, xs = np.nonzero(glyphs[top:bottom, left:right] > 0.18)
    if len(xs):
        right, bottom = left+int(xs.max())+1, top+int(ys.max())+1
        left, top = left+int(xs.min()), top+int(ys.min())
    # Small balloons may have only a few pixels between a kana and the frame.
    # The former 6-12px OCR margin included the frame and changed 'え' into noise.
    margin = max(2, min(6, round(font * 0.25)))
    return (max(0, left-margin), max(0, top-margin), min(width, right+margin), min(height, bottom+margin))


def detect_text_regions(image: Image.Image, limit=MAX_TEXT_REGIONS):
    if os.getenv("MAS_TEXT_DETECTOR", "neural") == "heuristic":
        return detect_heuristic(image, limit)
    import cv2
    width, height = image.size
    scale = MODEL_SIZE / max(width, height)
    resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
    # The exported model uses RGB, zero padding on the right/bottom, and NCHW.
    surface = np.zeros((MODEL_SIZE, MODEL_SIZE, 3), dtype=np.uint8)
    surface[:resized_height, :resized_width] = cv2.resize(np.asarray(image.convert("RGB")),
        (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    tensor = surface.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    detector = get_detector()
    predictions, segmentation, line_map = detector.run(None, {detector.get_inputs()[0].name: tensor})
    glyphs = cv2.resize(segmentation[0, 0, :resized_height, :resized_width],
                       (width, height), interpolation=cv2.INTER_LINEAR)
    lines = line_map[0, 0]
    contours, _ = cv2.findContours((lines > 0.3).astype(np.uint8), cv2.RETR_EXTERNAL,
                                  cv2.CHAIN_APPROX_SIMPLE)
    line_boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if min(w, h) < 3 or float(lines[y:y+h, x:x+w].mean()) < 0.45:
            continue
        box = (max(0, x/scale), max(0, y/scale),
               min(width, (x+w)/scale), min(height, (y+h)/scale))
        if min(box[2]-box[0], box[3]-box[1]) >= 3:
            line_boxes.append(box)

    proposals = []
    boxes = []
    claimed = set()
    rows = predictions[0]
    scores = rows[:, 4] * rows[:, 5:].max(axis=1)
    for index in np.argsort(scores)[::-1]:
        if scores[index] < 0.35:
            break
        cx, cy, w, h = rows[index, :4] / scale
        box = (max(0, cx-w/2), max(0, cy-h/2), min(width, cx+w/2), min(height, cy+h/2))
        if min(box[2]-box[0], box[3]-box[1]) < 8:
            continue
        if any(_overlap(box, old) > 0.7 for old in proposals):
            continue
        matched = [i for i, line in enumerate(line_boxes) if i not in claimed and _overlap(line, box) > 0.6]
        if matched:
            for group in _group_lines([line_boxes[i] for i in matched]):
                boxes.append(_line_bounds(group, glyphs, width, height))
            claimed.update(matched)
        else:
            left, top, right, bottom = map(int, box)
            pad = max(6, min(12, round(min(right-left, bottom-top) * 0.12)))
            boxes.append((max(0, left-pad), max(0, top-pad), min(width, right+pad), min(height, bottom+pad)))
        proposals.append(box)
    # Standalone lines are common for narration embedded directly in artwork.
    unclaimed = [line for i, line in enumerate(line_boxes) if i not in claimed]
    for group in _group_lines(unclaimed):
        boxes.append(_line_bounds(group, glyphs, width, height))
    boxes = [box for box in boxes if min(box[2]-box[0], box[3]-box[1]) >= 8][:limit]
    boxes.sort(key=lambda box: (box[1], -box[0]))
    return TextRegions(boxes, glyphs)
