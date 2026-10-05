"""Measure candidate features on detected regions, to separate lettering from artwork.

The detector currently hands the OCR model regions made of hair and screentone,
and the model answers with plausible Japanese ("そういえば、") that then gets
painted over the drawing. Any fix needs a feature that actually separates the two,
so this prints several candidates for every region on a real page and lets the
numbers pick the threshold instead of a guess.

Usage:
    python tools/probe_features.py --image "Image from URL 2" --width 760
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import _components, detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402


def features(crop: Image.Image) -> dict:
    gray = np.asarray(crop.convert("L"), dtype=np.uint8)
    total = gray.size

    # Otsu, so a white-on-black region is measured against its own contrast
    # rather than a fixed level.
    histogram = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    levels = np.arange(256, dtype=np.float64)
    background_weight = np.cumsum(histogram)
    background_sum = np.cumsum(histogram * levels)
    denominator = background_weight * (histogram.sum() - background_weight)
    variance = np.zeros(256)
    valid = denominator > 0
    variance[valid] = (
        (background_sum[-1] * background_weight[valid] - background_sum[valid] * histogram.sum()) ** 2
        / denominator[valid]
    )
    threshold = int(np.argmax(variance))

    dark = gray < threshold
    light = gray > threshold
    # Whichever polarity gives the smaller ink coverage is the "ink" side for a
    # page that is mostly paper; for a dark panel it is the other way round.
    ink = dark if dark.mean() <= light.mean() else light
    density = float(ink.mean())

    components = _components(ink)
    areas = [(right - left) * (bottom - top) for left, top, right, bottom in components]
    elongations = [
        max(right - left, bottom - top) / max(1, min(right - left, bottom - top))
        for left, top, right, bottom in components
    ]
    small = [area for area in areas if area >= 4]
    elongated_ink = sum(
        area for area, elongation in zip(areas, elongations) if elongation > 3.5 and area >= 4
    )
    ink_pixels = float(ink.sum())

    # A hair strand runs across the whole region; a glyph stroke does not. These
    # two ratios are the ones that should tell them apart.
    region_area = max(1, gray.shape[0] * gray.shape[1])
    spans = [
        max(right - left, bottom - top) / max(1, max(gray.shape[0], gray.shape[1]))
        for left, top, right, bottom in components
    ]
    largest = max(areas) if areas else 0

    return {
        "thr": threshold,
        "ink%": density * 100,
        "components": len(small),
        "medianArea": float(np.median(small)) if small else 0.0,
        "elong%": (elongated_ink / ink_pixels * 100) if ink_pixels else 0.0,
        "extremes%": float(((gray < 60) | (gray > 240)).mean() * 100),
        "binary%": float(((gray < 100) | (gray > 210)).mean() * 100),
        "maxSpan": (max(spans) * 100) if spans else 0.0,
        "largest%": (largest / region_area * 100) if region_area else 0.0,
        "perKpx": len(small) / (region_area / 1000) if region_area else 0.0,
        "total": total,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=760)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    scale = args.width / source.width
    image = source.resize((args.width, round(source.height * scale)), Image.Resampling.LANCZOS)

    regions = detect_text_regions(image, limit=24)
    header = (f"{'#':>3} {'尺寸':>10} {'组件':>5} {'每千像素':>8} {'最长跨度':>8} "
              f"{'最大占比':>8} {'细长%':>6} {'二值%':>6}  文本")
    print(header)
    print("-" * 118)
    for index, box in enumerate(regions):
        crop = image.crop(box)
        data = features(crop)
        text = "\n".join(recognize_detailed(crop)["texts"]).strip()
        leftovers = sum(character.isalnum() for character in text)
        mark = "  " if leftovers >= 4 else "× "  # × = dropped by the readable-text filter
        print(
            f"{index:>3} {box[2]-box[0]:>4}x{box[3]-box[1]:<5} {data['components']:>5} "
            f"{data['perKpx']:>8.1f} {data['maxSpan']:>7.0f}% {data['largest%']:>7.1f}% "
            f"{data['elong%']:>5.1f} {data['binary%']:>5.1f} {mark}{text!r}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
