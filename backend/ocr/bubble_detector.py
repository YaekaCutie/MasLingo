"""Lightweight text-region grouping for page-level manga OCR."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageFilter


def _components(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Return connected bounding boxes using row runs and a union-find."""
    parents: list[int] = []
    boxes: list[list[int]] = []
    previous: list[tuple[int, int, int]] = []

    def root(label: int) -> int:
        while parents[label] != label:
            parents[label] = parents[parents[label]]
            label = parents[label]
        return label

    for y, row in enumerate(mask):
        padded = np.pad(row, (1, 1), constant_values=False).astype(np.int8)
        edges = np.diff(padded)
        starts = np.flatnonzero(edges == 1)
        ends = np.flatnonzero(edges == -1)
        current: list[tuple[int, int, int]] = []
        previous_index = 0
        for start, end in zip(starts, ends):
            while previous_index < len(previous) and previous[previous_index][1] < start:
                previous_index += 1
            overlaps = []
            scan = previous_index
            while scan < len(previous) and previous[scan][0] <= end:
                overlaps.append(root(previous[scan][2]))
                scan += 1
            if overlaps:
                label = overlaps[0]
                for other in overlaps[1:]:
                    other_root = root(other)
                    label_root = root(label)
                    if other_root != label_root:
                        parents[other_root] = label_root
                        boxes[label_root] = [
                            min(boxes[label_root][0], boxes[other_root][0]),
                            min(boxes[label_root][1], boxes[other_root][1]),
                            max(boxes[label_root][2], boxes[other_root][2]),
                            max(boxes[label_root][3], boxes[other_root][3]),
                        ]
                label = root(label)
                box = boxes[label]
                box[0] = min(box[0], int(start))
                box[1] = min(box[1], y)
                box[2] = max(box[2], int(end))
                box[3] = max(box[3], y + 1)
            else:
                label = len(parents)
                parents.append(label)
                boxes.append([int(start), y, int(end), y + 1])
            current.append((int(start), int(end), label))
        previous = current

    unique: dict[int, tuple[int, int, int, int]] = {}
    for index, box in enumerate(boxes):
        label = root(index)
        current_box = unique.get(label)
        value = (box[0], box[1], box[2], box[3])
        if current_box is None:
            unique[label] = value
        else:
            unique[label] = (
                min(current_box[0], value[0]),
                min(current_box[1], value[1]),
                max(current_box[2], value[2]),
                max(current_box[3], value[3]),
            )
    return list(unique.values())


MAX_TEXT_REGIONS = 24
MAX_REGION_AREA_RATIO = 0.05
MAX_DARK_TEXT_CONTEXT_AREA_RATIO = 0.08

# Overlap, as a fraction of the smaller box, above which two proposals count as
# the same piece of text. A balloon proposal and the glyphs inside it overlap
# heavily, so they merge at a lower bar than two ordinary proposals.
#
# Lowering these was measured and rejected: sweeping the text-vs-text bar from
# 0.65 down to 0.35 with tools/tune_duplicates.py cost a whole real balloon
# (4/5 -> 3/5 of the page's genuine text blocks) while removing nothing, because
# no pair of surviving regions overlapped at all. Keep them where they are.
BUBBLE_DUPLICATE_OVERLAP = 0.45
TEXT_DUPLICATE_OVERLAP = 0.65


def _share_text_line(
    first: tuple[int, int, int, int, int],
    second: tuple[int, int, int, int, int],
) -> bool:
    left_a, top_a, right_a, bottom_a, _ = first
    left_b, top_b, right_b, bottom_b, _ = second
    width_a, height_a = right_a - left_a, bottom_a - top_a
    width_b, height_b = right_b - left_b, bottom_b - top_b
    overlap_x = max(0, min(right_a, right_b) - max(left_a, left_b))
    overlap_y = max(0, min(bottom_a, bottom_b) - max(top_a, top_b))
    gap_x = max(0, max(left_a, left_b) - min(right_a, right_b))
    gap_y = max(0, max(top_a, top_b) - min(bottom_a, bottom_b))
    scale_ratio = max(
        width_a / width_b,
        width_b / width_a,
        height_a / height_b,
        height_b / height_a,
    )
    same_reading_line = (
        scale_ratio <= 2.0
        and gap_x <= max(12, round(min(height_a, height_b) * 0.12))
        and overlap_y / min(height_a, height_b) >= 0.3
    )
    minimum_width = min(width_a, width_b)
    horizontal_segments = (
        width_a >= height_a * 0.9 and width_b >= height_b * 0.9
    )
    vertical_gap_factor = 1.4 if minimum_width >= 50 and horizontal_segments else 0.3
    same_vertical_block = (
        scale_ratio <= 2.5
        and gap_y <= max(12, round(minimum_width * vertical_gap_factor))
        and overlap_x / min(width_a, width_b) >= 0.55
    )
    return same_reading_line or same_vertical_block


def detect_text_regions(
    image: Image.Image, limit: int = MAX_TEXT_REGIONS
) -> list[tuple[int, int, int, int]]:
    """Find grouped ink regions suitable for MangaOCR, in source-image pixels.

    This deliberately uses only Pillow and NumPy, already required by the OCR
    backend. It groups dark or light lettering by contrast, rather than
    attempting to segment decorative balloon outlines as text.
    """
    source_width, source_height = image.size
    if not source_width or not source_height:
        return []
    scale = min(1.0, 1600 / max(source_width, source_height))
    width = max(1, round(source_width * scale))
    height = max(1, round(source_height * scale))
    gray = image.convert("L").resize((width, height), Image.Resampling.LANCZOS)
    gray_pixels = np.asarray(gray)
    gray_values = gray_pixels.astype(np.int16)
    contrast_kernel = max(11, min(31, (round(max(width, height) / 40) | 1)))
    local_maximum = np.asarray(
        gray.filter(ImageFilter.MaxFilter(contrast_kernel)),
        dtype=np.int16,
    )
    local_minimum = np.asarray(
        gray.filter(ImageFilter.MinFilter(contrast_kernel)),
        dtype=np.int16,
    )
    ink_masks = (
        gray_pixels < 185,
        gray_pixels > 235,
        ((local_maximum - gray_values) > 36) & (gray_pixels >= 40) & (gray_pixels < 235),
        ((gray_values - local_minimum) > 36) & (gray_pixels > 20) & (gray_pixels <= 235),
    )

    # Join nearby glyph strokes without merging panel borders and artwork into
    # a page-sized component. Check both dark lettering and light lettering
    # over dark artwork.
    radius = max(4, min(5, round(max(width, height) / 500)))
    kernel = (radius + 2) * 2 + 1
    candidates = []
    bubble_candidates = []
    minimum_ink = max(16, round(width * height * 0.000004))

    # Closed, light speech balloons can provide a better OCR crop than the
    # fragmented glyph groups inside them. Keep these proposals separate from
    # morphology-based grouping so large illustration regions stay excluded.
    for left, top, right, bottom in _components(gray_pixels > 230):
        box_width, box_height = right - left, bottom - top
        box_area = box_width * box_height
        if box_width < 24 or box_height < 24:
            continue
        if box_area < width * height * 0.015 or box_area > width * height * 0.18:
            continue
        if not 0.35 <= box_width / box_height <= 1.7:
            continue
        dark_ink_count = int((gray_pixels[top:bottom, left:right] < 185).sum())
        dark_ink_ratio = dark_ink_count / box_area
        if dark_ink_count < minimum_ink or not 0.02 <= dark_ink_ratio <= 0.7:
            continue
        bubble_candidates.append((left, top, right, bottom, dark_ink_count))

    for mask_index, ink in enumerate(ink_masks):
        grouped = Image.fromarray(ink.astype(np.uint8) * 255)
        # Remove isolated one-pixel artwork/panel strokes before dilation.
        # Otherwise a dense manga hatch/grid becomes one connected component
        # that encloses and suppresses all of the actual lettering.
        #
        # The two local-contrast masks are exempt. They are what catches thin
        # lettering painted straight onto the artwork — white dialogue over a
        # dark panel, for instance — and a 3x3 erosion deletes exactly the
        # one-to-two-pixel strokes they exist to find. Measured with
        # tools/probe_pipeline.py across display widths 400-900 on a real page,
        # eroding those two masks lost the white-on-black line at every width
        # where it would otherwise be found.
        if mask_index < 2:
            grouped = grouped.filter(ImageFilter.MinFilter(3))
        grouped = grouped.filter(ImageFilter.MaxFilter(kernel))
        for left, top, right, bottom in _components(np.asarray(grouped) > 0):
            box_width, box_height = right - left, bottom - top
            box_area = box_width * box_height
            if box_width < 8 or box_height < 8:
                continue
            if box_width > width * 0.92 or box_height > height * 0.92:
                continue
            if box_area > width * height * MAX_REGION_AREA_RATIO:
                continue
            ink_count = int(ink[top:bottom, left:right].sum())
            if ink_count < minimum_ink:
                continue
            if ink_count / box_area > 0.78:
                continue
            if mask_index == 1 and np.count_nonzero(
                gray_values[top:bottom, left:right] < 185
            ) / box_area < 0.35:
                continue
            # Add a small margin around the detected glyph group.
            padding = max(2, round(min(box_width, box_height) * 0.08))
            candidates.append((
                max(0, left - padding),
                max(0, top - padding),
                min(width, right + padding),
                min(height, bottom + padding),
                ink_count,
            ))

    # Keep the most text-like regions if a page contains substantial artwork
    # noise, then restore page reading order (top-to-bottom, right-to-left).
    candidates.sort(key=lambda item: item[4], reverse=True)
    unique_candidates = []
    for candidate in candidates:
        left, top, right, bottom, _ = candidate
        area = (right - left) * (bottom - top)
        duplicate = False
        for existing in unique_candidates:
            overlap_width = max(0, min(right, existing[2]) - max(left, existing[0]))
            overlap_height = max(0, min(bottom, existing[3]) - max(top, existing[1]))
            overlap = overlap_width * overlap_height
            existing_area = (existing[2] - existing[0]) * (existing[3] - existing[1])
            if overlap / min(area, existing_area) > 0.65:
                duplicate = True
                break
        if not duplicate:
            unique_candidates.append(candidate)
            if len(unique_candidates) == limit:
                break
    parents = list(range(len(unique_candidates)))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for index, candidate in enumerate(unique_candidates):
        for other_index in range(index):
            if _share_text_line(candidate, unique_candidates[other_index]):
                parents[root(index)] = root(other_index)

    groups: dict[int, list[tuple[int, int, int, int, int]]] = {}
    for index, candidate in enumerate(unique_candidates):
        groups.setdefault(root(index), []).append(candidate)

    candidates = []
    for group in groups.values():
        left = min(item[0] for item in group)
        top = min(item[1] for item in group)
        right = max(item[2] for item in group)
        bottom = max(item[3] for item in group)
        box_width, box_height = right - left, bottom - top
        box_area = box_width * box_height
        if box_area > width * height * MAX_REGION_AREA_RATIO:
            continue

        tall_text_block = box_height > box_width * 1.5
        padding_x = max(2, round(box_width * (0.46 if tall_text_block else 0.22)))
        padding_y = max(2, round(box_height * (0.02 if tall_text_block else 0.22)))
        if (box_width + 2 * padding_x) * (box_height + 2 * padding_y) > width * height * MAX_REGION_AREA_RATIO:
            lower, upper = 0.0, 1.0
            for _ in range(20):
                scale = (lower + upper) / 2
                scaled_x = round(padding_x * scale)
                scaled_y = round(padding_y * scale)
                padded_area = (box_width + 2 * scaled_x) * (box_height + 2 * scaled_y)
                if padded_area <= width * height * MAX_REGION_AREA_RATIO:
                    lower = scale
                else:
                    upper = scale
            padding_x = round(padding_x * lower)
            padding_y = round(padding_y * lower)
        candidates.append((
            max(0, left - padding_x),
            max(0, top - padding_y),
            min(width, right + padding_x),
            min(height, bottom + padding_y),
            sum(item[4] for item in group),
        ))

    expanded_candidates = []
    for left, top, right, bottom, ink_count in candidates:
        box_width, box_height = right - left, bottom - top
        box_area = box_width * box_height
        if (
            box_area >= width * height * 0.035
            and box_area <= width * height * MAX_REGION_AREA_RATIO
        ):
            region_pixels = gray_values[top:bottom, left:right]
            dark_background = np.count_nonzero(region_pixels < 70) / box_area
            light_ink = np.count_nonzero(region_pixels > 235) / box_area
            context_top = round(box_height * 0.15)
            context_bottom = round(box_height * 0.35)
            expanded_area = box_width * (
                box_height + context_top + context_bottom
            )
            if (
                dark_background >= 0.55
                and light_ink >= 0.06
                and expanded_area <= width * height * MAX_DARK_TEXT_CONTEXT_AREA_RATIO
            ):
                top = max(0, top - context_top)
                bottom = min(height, bottom + context_bottom)
        expanded_candidates.append((left, top, right, bottom, ink_count))
    candidates = expanded_candidates

    bubble_candidates.sort(key=lambda item: item[4], reverse=True)
    proposal_candidates = [*bubble_candidates, *candidates]
    final_candidates = []
    final_is_bubble = []
    for proposal_index, candidate in enumerate(proposal_candidates):
        is_bubble = proposal_index < len(bubble_candidates)
        left, top, right, bottom, _ = candidate
        area = (right - left) * (bottom - top)
        duplicate = False
        for existing, existing_is_bubble in zip(final_candidates, final_is_bubble):
            overlap = (
                max(0, min(right, existing[2]) - max(left, existing[0]))
                * max(0, min(bottom, existing[3]) - max(top, existing[1]))
            )
            existing_area = (
                (existing[2] - existing[0]) * (existing[3] - existing[1])
            )
            threshold = (
                BUBBLE_DUPLICATE_OVERLAP if is_bubble or existing_is_bubble
                else TEXT_DUPLICATE_OVERLAP
            )
            if overlap / min(area, existing_area) > threshold:
                duplicate = True
                break
        if duplicate:
            continue
        final_candidates.append(candidate)
        final_is_bubble.append(is_bubble)
        if len(final_candidates) == limit:
            break

    final_candidates.sort(key=lambda item: (item[1], -item[0]))
    factor_x, factor_y = source_width / width, source_height / height
    result = []
    for left, top, right, bottom, _ in final_candidates:
        result.append((
            max(0, math.floor(left * factor_x)),
            max(0, math.floor(top * factor_y)),
            min(source_width, math.ceil(right * factor_x)),
            min(source_height, math.ceil(bottom * factor_y)),
        ))
    return result
