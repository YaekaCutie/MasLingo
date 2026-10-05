"""Does the detector still find text as the page shrinks?

The browser sends a crop of the displayed screenshot, not the original file, so
a manga page viewed at 60% zoom reaches the detector around 60% smaller. The
ink masks use absolute thresholds (grey < 185 for dark ink, > 235 for light
ink), so thin white-on-black lettering is the first thing to blur out of range.

Usage:
    python tools/probe_detection_scale.py --image "Image from URL 2" --out report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize  # noqa: E402

# Boxes of interest in the 768x1119 original, measured by eye:
#   the white-on-black lettering over the artwork in the lower right.
INTEREST = {
    "右下角黑底白字": (470, 780, 720, 975),
    "左上气泡": (95, 30, 330, 220),
    "右上气泡": (500, 60, 700, 230),
    "左中气泡": (85, 350, 250, 520),
    "中气泡": (280, 320, 500, 530),
}


def overlap_ratio(box, region) -> float:
    left, top, right, bottom = box
    r_left, r_top, r_right, r_bottom = region
    width = max(0, min(right, r_right) - max(left, r_left))
    height = max(0, min(bottom, r_bottom) - max(top, r_top))
    area = (right - left) * (bottom - top)
    return (width * height) / area if area else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    report = {"source": list(source.size), "scales": []}

    for factor in (1.0, 0.85, 0.7, 0.55, 0.4):
        width = max(1, round(source.width * factor))
        height = max(1, round(source.height * factor))
        image = source.resize((width, height), Image.Resampling.LANCZOS)
        regions = detect_text_regions(image, limit=24)

        entry = {"factor": factor, "size": [width, height], "regionCount": len(regions), "hits": {}}
        for name, box in INTEREST.items():
            scaled = tuple(round(value * factor) for value in box)
            match = None
            for region in regions:
                if overlap_ratio(scaled, region) > 0.5:
                    match = region
                    break
            if match is None:
                entry["hits"][name] = None
                continue
            crop = image.crop(match)
            entry["hits"][name] = {
                "box": list(match),
                "text": recognize(crop),
            }
        report["scales"].append(entry)
        found = sum(1 for value in entry["hits"].values() if value)
        print(f"{factor:>4}x  {width}x{height}  区域 {len(regions):>2}  命中 {found}/{len(INTEREST)}")

    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
