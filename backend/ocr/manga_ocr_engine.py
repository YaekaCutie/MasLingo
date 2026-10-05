import math
import os
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError
from PIL import Image, ImageEnhance, ImageOps
from manga_ocr import MangaOcr

MODEL_ID = "kha-white/manga-ocr-base"

# Below this, the reading is treated as the model answering noise rather than
# text — but only when the reading is also short. See is_confident_reading.
MIN_CONFIDENCE = float(os.getenv("OMT_MIN_CONFIDENCE", "0.45"))
# Measured on two real pages, one Japanese and one English, sorted by confidence,
# true and false readings interleave: 0.419 true, 0.408 true, 0.391 false,
# 0.381 true, 0.376 true, 0.364 false, 0.341 false. No threshold separates them
# cleanly, so this is a deliberate trade-off rather than a solved problem:
#   * at 0.45 with the length rule below, all eight invented readings across the
#     four pages are removed, and two genuine ones are lost as well (a sound
#     effect and a balloon line on a dialogue-dense spread);
#   * lowering it to ~0.36 keeps those two but lets several invented readings
#     through again.
# It errs towards removing them because a wrong reading paints white over the
# artwork, while a missing one leaves Japanese the user can still select by hand.
# Both values are environment-tunable so this can be revisited without an edit.
MIN_CONFIDENCE_TEXT_LENGTH = int(os.getenv("OMT_MIN_CONFIDENCE_LENGTH", "8"))

# Share of full-width Latin letters above which a reading is rejected.
#
# This targets one specific failure with no ambiguity in it: given English
# lettering the model answers in full-width Latin, producing things like
# 'Ｄｏ．ｙｏｕ．ｃｏｌｕｄｙｓｅｄｏｎｉｔｉｏｎｅでは…'. Such readings scored 0.46
# and 0.49 confidence, so the confidence rule alone let them through and they
# were painted onto the drawing as if they were Japanese.
#
# Swept with tools/tune_thresholds.py over a page that is entirely English
# (where every reading is invented by definition) and a Japanese page whose
# balloons were transcribed by hand. The measured margins are thin and worth
# knowing: genuine readings that legitimately contain Latin (a move name in a
# decorative box, a line mentioning VTuber) reached 0.38 and 0.27, while invented
# full-width Latin reached 0.74 and 0.85. 0.45 sits in that gap. An earlier sweep
# without those two genuine cases picked 0.20 and quietly killed the move name.
MIN_LATIN_RATIO = float(os.getenv("OMT_MIN_LATIN_RATIO", "0.45"))

_FULLWIDTH_LATIN = set(
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ"
    "０１２３４５６７８９"
)


def latin_ratio(text: str) -> float:
    """Share of the reading that is Latin letters, half- or full-width."""
    if not text:
        return 0.0
    count = sum(1 for character in text if character in _FULLWIDTH_LATIN)
    count += sum(1 for character in text if character.isascii() and character.isalpha())
    return count / len(text)


@lru_cache(maxsize=1)
def get_engine():
    try:
        model_path = snapshot_download(MODEL_ID, local_files_only=True)
    except LocalEntryNotFoundError:
        model_path = snapshot_download(MODEL_ID)
    return MangaOcr(str(Path(model_path)))


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


def _otsu_threshold(gray):
    histogram = np.asarray(gray.histogram(), dtype=np.float64)
    total = histogram.sum()
    levels = np.arange(256, dtype=np.float64)
    background_weight = np.cumsum(histogram)
    background_sum = np.cumsum(histogram * levels)
    denominator = background_weight * (total - background_weight)
    between_class_variance = np.zeros(256, dtype=np.float64)
    valid = denominator > 0
    between_class_variance[valid] = (
        (background_sum[-1] * background_weight[valid] - background_sum[valid] * total) ** 2
        / denominator[valid]
    )
    return min(220, max(80, int(np.argmax(between_class_variance))))


def _detect_text_direction(image):
    gray = ImageOps.grayscale(image)
    width, height = gray.size
    scale = min(1.0, 512 / width, 768 / height)
    if scale < 1.0:
        gray = gray.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.BOX,
        )

    width, height = gray.size
    gray_pixels = np.asarray(gray, dtype=np.uint8)
    shortest_side = min(width, height)
    if shortest_side < 24:
        return None

    threshold = _otsu_threshold(gray)
    smallest_cell = max(4, shortest_side // 28)
    cell_step = max(2, shortest_side // 24)
    largest_cell = max(smallest_cell + 1, shortest_side // 2)
    results = []
    for ink_mask in (gray_pixels < threshold, gray_pixels > threshold):
        scale_votes = []
        for cell_size in range(smallest_cell, largest_cell, cell_step):
            offset_scores = {"horizontal": [], "vertical": []}
            for offset_y in (0, cell_size // 2):
                for offset_x in (0, cell_size // 2):
                    right = width - offset_x
                    bottom = height - offset_y
                    columns = right // cell_size
                    rows = bottom // cell_size
                    if columns < 2 or rows < 2:
                        continue

                    sample = ink_mask[
                        offset_y:offset_y + rows * cell_size,
                        offset_x:offset_x + columns * cell_size,
                    ]
                    cell_density = sample.reshape(
                        rows, cell_size, columns, cell_size
                    ).mean(axis=(1, 3))
                    occupied = cell_density >= 0.12
                    occupied_count = int(occupied.sum())
                    coverage = occupied_count / occupied.size
                    if occupied_count < 4 or coverage < 0.01 or coverage > 0.6:
                        continue

                    horizontal_pairs = int(np.count_nonzero(occupied[:, :-1] & occupied[:, 1:]))
                    vertical_pairs = int(np.count_nonzero(occupied[:-1, :] & occupied[1:, :]))
                    pair_count = horizontal_pairs + vertical_pairs
                    if pair_count < 2:
                        continue

                    difference = horizontal_pairs - vertical_pairs
                    dominance = abs(difference) / pair_count
                    support = min(1.0, pair_count / (occupied_count * 0.5))
                    score = dominance * support
                    direction = "horizontal" if difference > 0 else "vertical"
                    offset_scores[direction].append(score)

            horizontal_score = sum(offset_scores["horizontal"])
            vertical_score = sum(offset_scores["vertical"])
            if max(horizontal_score, vertical_score) >= 0.2:
                scale_votes.append((horizontal_score, vertical_score))

        if len(scale_votes) < 2:
            continue

        horizontal_votes = sum(horizontal > vertical for horizontal, vertical in scale_votes)
        vertical_votes = sum(vertical > horizontal for horizontal, vertical in scale_votes)
        winning_votes = max(horizontal_votes, vertical_votes)
        if winning_votes / len(scale_votes) < 0.7:
            continue

        if horizontal_votes > vertical_votes:
            direction_scores = [horizontal - vertical for horizontal, vertical in scale_votes]
            direction = "horizontal"
        else:
            direction_scores = [vertical - horizontal for horizontal, vertical in scale_votes]
            direction = "vertical"

        confidence = sum(score for score in direction_scores if score > 0) / winning_votes
        if confidence >= 0.35:
            results.append((direction, confidence))

    return max(results, key=lambda result: result[1])[0] if results else None


def _vertical_column_bounds(image, direction=None):
    gray = ImageOps.grayscale(image)
    width, height = gray.size
    if direction is None:
        direction = _detect_text_direction(image)
    if width < 32 or height < 48 or direction != "vertical":
        return []

    scale = min(1.0, 512 / width, 768 / height)
    if scale < 1.0:
        scan = gray.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.BILINEAR,
        )
    else:
        scan = gray

    pixels = np.asarray(scan, dtype=np.uint8)
    threshold = 160
    columns_by_polarity = []
    for ink_mask in (pixels < threshold, pixels > threshold):
        ink_by_column = ink_mask.sum(axis=0)
        ink_threshold = max(2, int(scan.height * 0.01))
        active = ink_by_column >= ink_threshold
        max_gap = max(3, int(scan.height * 0.025))
        groups = []
        active_columns = np.flatnonzero(active)
        if active_columns.size == 0:
            continue
        group_start = last_active = int(active_columns[0])
        for column in active_columns[1:]:
            column = int(column)
            if column - last_active - 1 > max_gap:
                groups.append((group_start, last_active + 1))
                group_start = column
            last_active = column
        groups.append((group_start, last_active + 1))

        min_width = max(4, int(scan.height * 0.035))
        max_width = int(scan.height * 0.4)
        min_vertical_span = int(scan.height * 0.3)
        columns = []
        for left, right in groups:
            if right - left < min_width or right - left > max_width:
                continue
            occupied_rows = np.flatnonzero(ink_mask[:, left:right].any(axis=1))
            if occupied_rows.size and occupied_rows[-1] - occupied_rows[0] >= min_vertical_span:
                columns.append((left, right))
        if len(columns) >= 2:
            columns_by_polarity.append(columns)

    if not columns_by_polarity:
        return []
    columns = max(columns_by_polarity, key=len)
    columns.sort(key=lambda bounds: bounds[0], reverse=True)
    return [
        (max(0, int(left / scale)), min(width, int((right - 1) / scale) + 1))
        for left, right in columns
    ]


def _confidence(engine, image, text):
    """How likely the model thinks `text` is, given the image.

    MangaOcr.__call__ throws this away. It is the one signal that separates real
    lettering from artwork the detector mistook for text: asked about hair
    texture, the model still produces fluent Japanese ("そういえば、"), but with
    a much lower per-token probability than for text it can actually read.

    Computed by teacher-forcing the text that was already produced, so the
    recognition path itself is untouched — the reading cannot change because of
    this. Returns exp(-mean cross entropy), i.e. 1.0 for certainty.
    """
    if not text:
        return 0.0
    prepared = image.convert("L").convert("RGB")
    pixel_values = engine.processor(prepared, return_tensors="pt").pixel_values
    pixel_values = pixel_values.to(engine.model.device)
    labels = engine.tokenizer(text, return_tensors="pt").input_ids
    labels = labels.to(engine.model.device)
    with torch.no_grad():
        loss = engine.model(pixel_values=pixel_values, labels=labels).loss
    return math.exp(-float(loss))


def is_confident_reading(text, confidence):
    """Whether a reading is worth keeping.

    Only for regions the *detector* guessed at. When the user drew the box
    themselves the reading is theirs to judge, and is never dropped here.

    Confidence alone does not separate the two cases cleanly: on a real page the
    invented readings ("そういえば、", from hair) scored 0.33 and 0.34, while a
    genuine line inside a decorative box scored 0.38 — the model had to guess at
    the hatching around it. Length breaks the tie, because a short low-confidence
    answer is the signature of replying to texture, whereas a long one means the
    model did read something and merely struggled in places. The Latin share
    catches a third case the other two miss: English lettering answered in
    full-width Latin, at a confidence high enough to pass both.

    Measured with tools/tune_thresholds.py over a page that is entirely English
    (so every reading from it is invented) and a Japanese page whose balloons
    were transcribed by hand: four of four genuine readings survive, none of the
    inventions do.
    """
    if latin_ratio(text) >= MIN_LATIN_RATIO:
        return False
    if confidence >= MIN_CONFIDENCE:
        return True
    return sum(character.isalnum() for character in text) > MIN_CONFIDENCE_TEXT_LENGTH


def recognize_detailed(image):
    """Recognise text and report the writing direction that was used.

    The direction is decided here, from the pixels, by _detect_text_direction.
    Anything that lays the translation back into the artwork must use this
    verdict instead of guessing from the box's aspect ratio: a two-line
    horizontal block is taller than it is wide, and the aspect-ratio guess
    would typeset it as a single vertical column.

    Returns {"texts": [...], "direction": "horizontal" | "vertical" | None}.
    """
    engine = get_engine()
    prepared = _prepare_image(image)
    direction = _detect_text_direction(image)
    columns = _vertical_column_bounds(image, direction)
    if columns:
        text = "".join(
            "".join(
                _normalize_texts(
                    engine(_prepare_image(image.crop((left, 0, right, image.height))))
                )
            )
            for left, right in columns
        )
        texts = [text] if text else []
    else:
        texts = _normalize_texts(engine(prepared))

    return {
        "texts": texts,
        "direction": direction,
        "confidence": _confidence(engine, prepared, "".join(texts)),
    }


def recognize(image):
    return recognize_detailed(image)["texts"]