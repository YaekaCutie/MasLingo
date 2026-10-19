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


# How many proposals one screenshot may carry into recognition.
#
# This is a budget: every region costs one OCR pass (measured ~0.2 s on the
# development CPU, so the cap is seconds, not minutes), and it needs to sit
# above the number of text groups a dense page genuinely has. On a two-page
# spread the detector returns 58 proposals after merging, and with the old
# cap of 24 ten readable balloons — '黙れコラァ！！！' at 0.99 confidence,
# '一枚だけな' at 1.00, 'はいジョーカー！', '買ってもらったゲームで…' — ranked
# past the cut and were never read, while artwork fragments took their slots.
# Junk does share the budget, because nothing before OCR reliably separates a
# balloon from artwork that merely contains lettering; the confidence gate
# discards those afterwards. 80 keeps the spread's last real balloons
# ('またねー' at 0.98) inside the budget with a little headroom.
MAX_TEXT_REGIONS = 80
MAX_REGION_AREA_RATIO = 0.05
MAX_DARK_TEXT_CONTEXT_AREA_RATIO = 0.08
# White lettering on a black panel can touch a white face highlight or the
# page margin after the normal dilation, producing one large component that
# the 5% area cap discards. A second, tighter light-mask pass recovers those
# groups. It only accepts a large, mostly-dark, mostly-light-ink box, so the
# extra pass does not add the small face/hair highlights the normal pass
# already sees (or deliberately ignores).
LIGHT_TEXT_RECOVERY_KERNEL = 7
LIGHT_TEXT_RECOVERY_MIN_AREA_RATIO = 0.005
LIGHT_TEXT_RECOVERY_MAX_AREA_RATIO = 0.08
LIGHT_TEXT_RECOVERY_DARK_RATIO = 0.50
LIGHT_TEXT_RECOVERY_LIGHT_RATIO = 0.06
LIGHT_TEXT_RECOVERY_MIN_ASPECT = 1.2

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


# Share of a proposal's box that other proposals must cover for it to count
# as the paper *around* balloons rather than a balloon itself, and the share
# of the page the proposal itself must occupy to qualify as a panel.
#
# Both bars come from measured pages. The panel backgrounds that swallowed
# balloons covered 0.32 (13.8% of the page) and 0.49 (7.0%); the one candidate
# the guard must *not* drop is a real balloon at 0.30 — but only 1.8% of the
# page, where its "inner" is the furigana strip beside the letters, so the
# page-share bar does the separating.
BACKGROUND_INNER_SHARE = 0.28
BACKGROUND_MIN_SHARE_OF_PAGE = 0.035


def _drop_background_containers(
    candidates: list[tuple[int, int, int, int, int]],
    page_area: int,
) -> list[tuple[int, int, int, int, int]]:
    """Drop enclosed proposals that are panels' backgrounds, not balloons.

    A white panel is enclosed by its frame, so its background passes the ring
    test, and its bounding box covers every balloon standing on it — which
    makes it measure the balloons' lettering as its own score. On a
    dialogue-heavy spread that background then outranked the balloons (89911
    against 8317 and 4200), won the duplicate pass, and the two real balloons
    inside it were thrown away unread while the background itself was read as
    one garbled merged crop. When other proposals cover a large share of a
    proposal's box, it is that background: keep the contents, drop the
    container. Measured the same way on a second spread, a panel background
    at 0.32 coverage quietly swallowed its one balloon ('まあまあ‥‥っていうか
    普通‥‥'), which then never reached recognition at all.
    """
    boxes = [(item[0], item[1], item[2], item[3]) for item in candidates]
    keep = []
    for index, (left, top, right, bottom) in enumerate(boxes):
        area = (right - left) * (bottom - top)
        covered = 0
        for other, (other_left, other_top, other_right, other_bottom) in enumerate(boxes):
            if other == index:
                continue
            if (
                left <= other_left
                and top <= other_top
                and other_right <= right
                and other_bottom <= bottom
            ):
                covered += (other_right - other_left) * (other_bottom - other_top)
        if (
            area >= BACKGROUND_MIN_SHARE_OF_PAGE * page_area
            and covered >= BACKGROUND_INNER_SHARE * area
        ):
            continue
        keep.append(candidates[index])
    return keep


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


def _separated_by_stroke(
    first: tuple[int, int, int, int, int],
    second: tuple[int, int, int, int, int],
    dark: np.ndarray,
) -> bool:
    """Whether a dark stroke runs between two vertically adjacent proposals.

    Two fragments of one piece of text are separated by white paper; two
    stacked speech balloons are separated by their outlines. The latter must
    not be merged — reading two balloons as one region produced garbled crops
    on a dialogue-dense spread — so a horizontal dark line across the overlap
    between the two boxes vetoes the merge.
    """
    if first[1] > second[1]:
        first, second = second, first
    overlap_left = max(first[0], second[0])
    overlap_right = min(first[2], second[2])
    if overlap_right - overlap_left < 8:
        return False
    gap_top = max(0, first[3])
    gap_bottom = min(dark.shape[0], second[1])
    if gap_bottom <= gap_top:
        gap_top = max(0, first[3] - 2)
        gap_bottom = min(dark.shape[0], first[3] + 2)
    band = dark[gap_top:gap_bottom, overlap_left:overlap_right]
    if band.size == 0:
        return False
    return bool((band.mean(axis=1) >= 0.7).any())


# The smallest component that counts as a glyph rather than texture.
#
# Screentone is drawn as thousands of 1–3px dots, every one of them small,
# round and solid — exactly the shape statistics a glyph detector looks for.
# On a screentone-heavy page those dots outscored the real lettering and the
# top slots filled with empty panels; the detector's recall against the
# labelled corpus sat at ~15% for it. Real glyphs on a page scaled to 1600px
# are 8px and up (area >= 64), while anti-aliased halftone dots stay under
# 4x5; a floor of 20 separates them with plenty of margin either way.
MIN_GLYPH_AREA = 20
# Below this total, a region is texture, not text — an empty balloon interior
# has no glyph-like components at all and drops out, which is the point.
MIN_GLYPH_SCORE = 24


def _has_text_like_ink(gray_pixels: np.ndarray, box: tuple[int, int, int, int]) -> bool:
    """Whether a proposed balloon interior actually contains lettering.

    Empty balloons, windows, eyes and clothing highlights are enclosed by
    outlines too, so the ring test alone admits them; what they lack is glyphs.
    A whole comic PANEL is enclosed by its border and *does* contain the
    caption's glyphs, but they fill a small fraction of its area — a text
    carrier's lettering covers at least a tenth of the box, a panel's handful
    of lines far less. Without the density bar the panel won the duplicate
    pass against the caption itself and the caption was never read.
    """
    score = _glyph_score(gray_pixels, box)
    box_area = (box[2] - box[0]) * (box[3] - box[1])
    return score >= MIN_GLYPH_SCORE and score >= 0.10 * box_area


def _is_page_light_background(
    gray_pixels: np.ndarray,
    box: tuple[int, int, int, int],
    width: int,
    height: int,
) -> bool:
    """Whether a light-mask proposal is the page margin, not lettering.

    A white page strip at the top/right edge is a large light component. When
    it touches the white strokes of a dark-panel caption, the grouping step
    merges both and the resulting box exceeds the 5% area cap, so the caption
    vanishes without ever reaching OCR. Black-on-white text is handled by the
    dark masks, so rejecting a large, edge-touching, mostly-light region from
    the light masks is safe; white lettering on a dark panel keeps a high dark
    share and is not rejected.
    """
    left, top, right, bottom = box
    box_area = (right - left) * (bottom - top)
    page_area = width * height
    if box_area < page_area * 0.02:
        return False
    edge = max(2, round(min(width, height) * 0.005))
    touches_edge = (
        left <= edge or top <= edge or
        right >= width - edge or bottom >= height - edge
    )
    if not touches_edge:
        return False
    region = gray_pixels[top:bottom, left:right]
    light_share = np.count_nonzero(region > 235) / box_area
    dark_share = np.count_nonzero(region < 70) / box_area
    return light_share >= 0.45 and dark_share < 0.50


def _glyph_score(gray_pixels: np.ndarray, box: tuple[int, int, int, int]) -> int:
    """Total area of glyph-like strokes inside a proposal.

    Ranking candidates by raw ink let artwork win: a hatched face or a figure's
    outline carries more ink than a balloon's text, so on a dialogue-dense page
    the top slots filled with blobs and real text fell off the list. Glyphs are
    small, compact, solid components; artwork strokes are long, hollow or
    sprawling, and are excluded here, so a text group outranks a bigger blob.

    Both polarities are measured and the better one wins: dialogue over dark
    artwork is light lettering, and scoring dark ink only rated those crops
    zero (the background itself is one giant dark component), which silently
    dropped them from the candidate list.
    """
    left, top, right, bottom = box
    box_width, box_height = right - left, bottom - top
    region = gray_pixels[top:bottom, left:right]
    best = 0
    for interior in (region < 185, region > 205):
        total = 0
        for gl, gt, gr, gb in _components(interior):
            width, height = gr - gl, gb - gt
            area = width * height
            # 0.85, not 0.6: a crop tight around one line of text has glyphs as
            # tall as the box itself, and the tighter cap silently scored whole
            # caption lines at zero. Only strokes that genuinely span the box
            # (frames, outlines, motion lines) are excluded.
            if area < MIN_GLYPH_AREA or width > box_width * 0.85 or height > box_height * 0.85:
                continue
            if interior[gt:gb, gl:gr].mean() >= 0.2:
                total += area
        best = max(best, total)
    return best


def _split_run(
    mask: np.ndarray,
    box: tuple[int, int, int, int],
    axis: int,
    min_gap: int = 6,
    min_side: int = 40,
    ink_share: float = 0.06,
) -> list[tuple[int, int, int, int]]:
    """Split a merged block where its ink projection has a wide empty band.

    Stacked balloons whose outlines touch end up as one connected component
    after dilation, and reading them as one region garbles both. The white
    sliver between the two outlines shows up as a run of rows with (almost) no
    ink; splitting there recovers one region per balloon. Only used on blocks
    that actually look merged (tall or wide relative to their other side), so
    ordinary single texts are untouched.
    """
    left, top, right, bottom = box
    region = mask[top:bottom, left:right]
    projection = region.sum(axis=1) if axis == 0 else region.sum(axis=0)
    cross = (right - left) if axis == 0 else (bottom - top)
    length = (bottom - top) if axis == 0 else (right - left)
    if length < min_side * 2:
        return []
    limit = max(1, int(cross * 0.02))
    cuts = []
    index = 0
    while index < length:
        if projection[index] <= limit:
            start = index
            while index < length and projection[index] <= limit:
                index += 1
            if index - start >= min_gap:
                cuts.append((start + index) // 2)
        else:
            index += 1
    if not cuts:
        return []
    total_ink = int(projection.sum()) or 1
    bounds = []
    previous = 0
    for cut in cuts:
        bounds.append((previous, cut))
        previous = cut
    bounds.append((previous, length))
    pieces = []
    for start, end in bounds:
        if end - start < min_side:
            continue
        if int(projection[start:end].sum()) < total_ink * ink_share:
            continue
        if axis == 0:
            pieces.append((left, top + start, right, top + end))
        else:
            pieces.append((left + start, top, left + end, bottom))
    return pieces if len(pieces) >= 2 else []


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
    #
    # The outlines are sealed before the interiors are taken (dilate then erode
    # on the dark mask). A plain `gray > 230` component search fails here: JPEG
    # noise drops single pixels on the outline below the threshold, an interior
    # then leaks into the page background and merges with it, and a page full of
    # balloons produced almost no usable proposals. Sealing a two-pixel gap
    # costs nothing on real outlines and keeps every interior its own component.
    dark_for_seal = (gray_pixels < 210).astype(np.uint8) * 255
    sealed = np.asarray(
        Image.fromarray(dark_for_seal)
        .filter(ImageFilter.MaxFilter(7))
        .filter(ImageFilter.MinFilter(7))
    ) > 0
    for left, top, right, bottom in _components(~sealed):
        box_width, box_height = right - left, bottom - top
        box_area = box_width * box_height
        if box_width < 24 or box_height < 24:
            continue
        if box_area < width * height * 0.004 or box_area > width * height * 0.16:
            continue
        # Vertical-text balloons are tall and narrow; a plain 0.35–1.7 range
        # rejected most of them. 0.22–2.2 covers the real shapes on both page
        # orientations (a long two-line balloon reaches ~2.0) without admitting
        # wide art panels, which keep being rejected.
        if not 0.22 <= box_width / box_height <= 2.2:
            continue
        dark_ink_count = int((gray_pixels[top:bottom, left:right] < 185).sum())
        dark_ink_ratio = dark_ink_count / box_area
        if dark_ink_count < minimum_ink or not 0.015 <= dark_ink_ratio <= 0.65:
            continue
        # A balloon is enclosed by its own outline. Check the band just outside
        # the interior: an enclosed white patch of artwork (an eye highlight, a
        # shirt fold) passes the size and ink tests but is not ringed by a
        # continuous dark stroke.
        ring = 3
        crop_light = (~sealed)[top:bottom, left:right]
        crop_dark = sealed[top:bottom, left:right]
        grown = np.asarray(
            Image.fromarray(crop_light.astype(np.uint8) * 255)
            .filter(ImageFilter.MaxFilter(2 * ring + 1))
        ) > 0
        band = grown & ~crop_light
        band_pixels = int(band.sum())
        if band_pixels <= 0:
            continue
        # The band follows the shape's own boundary (a bbox ring misses the
        # outline of a round balloon entirely, since the ellipse only touches
        # its bounding box at four points).
        if int((crop_dark & band).sum()) / band_pixels < 0.18:
            continue
        if not _has_text_like_ink(gray_pixels, (left, top, right, bottom)):
            continue
        bubble_candidates.append((left, top, right, bottom, dark_ink_count))

    # Panels' backgrounds are enclosed regions too; see the docstring of
    # _drop_background_containers for why they have to leave before scoring.
    # The test runs on the raw outlines — the 3% inset below would break the
    # shared edges the containment check relies on.
    bubble_candidates = _drop_background_containers(bubble_candidates, width * height)
    # Inset each crop inside its outline: the model reads dialogue, not the
    # balloon frame.
    inset_candidates = []
    for left, top, right, bottom, dark_ink_count in bubble_candidates:
        inset = max(2, round(min(right - left, bottom - top) * 0.03))
        inset_candidates.append(
            (left + inset, top + inset, right - inset, bottom - inset, dark_ink_count)
        )
    bubble_candidates = inset_candidates

    for mask_index, ink in enumerate(ink_masks):
        # The global light mask gets a second, tighter dilation. Text painted
        # on a black panel can sit within one dilation step of a white face
        # highlight; the normal kernel merges them into a box above the area
        # cap, and the whole line disappears. The tighter pass only contributes
        # candidates that still look like large light-on-dark text, so ordinary
        # artwork highlights do not become extra OCR regions.
        passes = ((kernel, False),)
        if mask_index == 1:
            passes = ((kernel, False), (LIGHT_TEXT_RECOVERY_KERNEL, True))
        for active_kernel, recovery in passes:
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
                # Dot-grid textures (some web scans print halftone darker than
                # 185) are 1-3px specks; dilated they fuse into one page-sized
                # web that swallows the lettering along with them. Clearing the
                # sub-glyph specks *before* the dilation keeps glyph strokes —
                # orders of magnitude larger — and is what finally let the
                # labelled corpus page's text form a candidate at all.
                speck_cleared = np.zeros_like(ink)
                for speck_left, speck_top, speck_right, speck_bottom in _components(ink):
                    if (speck_right - speck_left) * (speck_bottom - speck_top) >= 12:
                        speck_cleared[speck_top:speck_bottom, speck_left:speck_right] |= (
                            ink[speck_top:speck_bottom, speck_left:speck_right]
                        )
                grouped = Image.fromarray(speck_cleared.astype(np.uint8) * 255)
                grouped = grouped.filter(ImageFilter.MinFilter(3))
            grouped = grouped.filter(ImageFilter.MaxFilter(active_kernel))
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
                region_pixels = gray_values[top:bottom, left:right]
                if mask_index == 1 and np.count_nonzero(
                    region_pixels < 185
                ) / box_area < 0.35:
                    continue
                if mask_index in (1, 3) and _is_page_light_background(
                    gray_values, (left, top, right, bottom), width, height,
                ):
                    continue
                if recovery:
                    page_area = width * height
                    if box_area < page_area * LIGHT_TEXT_RECOVERY_MIN_AREA_RATIO:
                        continue
                    if box_area > page_area * LIGHT_TEXT_RECOVERY_MAX_AREA_RATIO:
                        continue
                    if np.count_nonzero(region_pixels < 70) / box_area < (
                        LIGHT_TEXT_RECOVERY_DARK_RATIO
                    ):
                        continue
                    if np.count_nonzero(region_pixels > 235) / box_area < (
                        LIGHT_TEXT_RECOVERY_LIGHT_RATIO
                    ):
                        continue
                    if max(box_width / box_height, box_height / box_width) < (
                        LIGHT_TEXT_RECOVERY_MIN_ASPECT
                    ):
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
    candidates = [
        (left, top, right, bottom, _glyph_score(gray_pixels, (left, top, right, bottom)))
        for left, top, right, bottom, _ink in candidates
    ]
    # Texture (screentone, hatching, hair) scores near zero once the glyph-area
    # floor applies; a region without a single glyph-like component is not text
    # and must not occupy one of the limited region slots.
    #
    # The density floor catches the other kind of imposter: a panel border is
    # one connected component whose box is the whole panel, so it contains the
    # caption's glyphs and scores like a text region — and then overrides the
    # caption itself in the duplicate pass, because everything overlaps the
    # frame. Real text fills a few percent of its box or more; a frame that
    # merely *contains* text stays far below.
    candidates = [
        candidate for candidate in candidates
        if candidate[4] >= MIN_GLYPH_SCORE
        and candidate[4] >= 0.05 * (candidate[2] - candidate[0]) * (candidate[3] - candidate[1])
    ]
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

    # A shared outline between two proposals means two balloons, not one text
    # block: merging them is what produced crops spanning several balloons.
    dark_mask = gray_pixels < 200
    for index, candidate in enumerate(unique_candidates):
        for other_index in range(index):
            if _share_text_line(candidate, unique_candidates[other_index]) and not _separated_by_stroke(
                candidate, unique_candidates[other_index], dark_mask
            ):
                parents[root(index)] = root(other_index)

    groups: dict[int, list[tuple[int, int, int, int, int]]] = {}
    for index, candidate in enumerate(unique_candidates):
        groups.setdefault(root(index), []).append(candidate)

    def _padded(left, top, right, bottom):
        """Add the crop margin, shrinking it if the box would exceed the cap."""
        box_width, box_height = right - left, bottom - top
        tall_text_block = box_height > box_width * 1.5
        padding_x = max(2, round(box_width * (0.25 if tall_text_block else 0.18)))
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
        return (
            max(0, left - padding_x),
            max(0, top - padding_y),
            min(width, right + padding_x),
            min(height, bottom + padding_y),
        )

    dark_projection = gray_pixels < 185
    candidates = []
    for group in groups.values():
        left = min(item[0] for item in group)
        top = min(item[1] for item in group)
        right = max(item[2] for item in group)
        bottom = max(item[3] for item in group)
        box_width, box_height = right - left, bottom - top
        if box_width * box_height > width * height * MAX_REGION_AREA_RATIO:
            continue
        # A block much taller (or wider) than its other side is often several
        # balloons whose outlines the dilation bridged into one component.
        # Splitting at the widest ink-free band gives each balloon its own crop,
        # which is the difference between reading two lines and reading noise.
        pieces = [(left, top, right, bottom)]
        if box_height >= 150 and box_height >= box_width * 1.5:
            split = _split_run(dark_projection, (left, top, right, bottom), axis=0)
            if split:
                pieces = split
        elif box_width >= 150 and box_width >= box_height * 1.5:
            split = _split_run(dark_projection, (left, top, right, bottom), axis=1)
            if split:
                pieces = split
        group_ink = sum(item[4] for item in group)
        for piece in pieces:
            padded = _padded(*piece)
            padded_width = padded[2] - padded[0]
            padded_height = padded[3] - padded[1]
            if padded_width * padded_height > width * height * MAX_REGION_AREA_RATIO:
                continue
            candidates.append((*padded, max(1, group_ink // len(pieces))))

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

    # Rank balloons by glyph-likeness too: an enclosed white patch of artwork
    # (a window, an eye highlight, a hair gap) also survives the ring and ink
    # tests, and raw ink made those large patches outrank real balloons on a
    # dialogue-heavy spread.
    bubble_candidates = [
        (left, top, right, bottom, _glyph_score(gray_pixels, (left, top, right, bottom)))
        for left, top, right, bottom, _ink in bubble_candidates
    ]
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
