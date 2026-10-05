"""Dump detected regions with their text, and every overlapping pair.

Two kinds of mistake show up in the API output on a real page: the same balloon
detected twice with different readings, and regions invented from screentone.
Both are visible as damage once the translation is painted in, so they are worth
measuring before touching any threshold.

Usage:
    python tools/probe_regions.py --image "Image from URL 2" --width 760
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402


def area(box) -> int:
    left, top, right, bottom = box
    return max(0, right - left) * max(0, bottom - top)


def overlap_over_min(first, second) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    smaller = min(area(first), area(second))
    return intersection / smaller if smaller else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=760, help="display width to emulate")
    parser.add_argument("--annotate", default="", help="optional PNG path to write boxes onto")
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    scale = args.width / source.width
    image = source.resize(
        (args.width, round(source.height * scale)), Image.Resampling.LANCZOS
    )

    regions = detect_text_regions(image, limit=24)
    print(f"显示宽度 {args.width}px  检测到 {len(regions)} 个区域\n")

    records = []
    for index, box in enumerate(regions):
        detailed = recognize_detailed(image.crop(box))
        text = "\n".join(detailed["texts"]).strip()
        width = box[2] - box[0]
        height = box[3] - box[1]
        records.append({"index": index, "box": box, "text": text, "direction": detailed["direction"]})
        print(f"  [{index:>2}] {width:>4}x{height:<4} {str(detailed['direction']):<10} {text!r}")

    print("\n重叠的对（重叠率 = 交集 / 较小者面积）：")
    found = False
    for i, first in enumerate(records):
        for second in records[i + 1:]:
            ratio = overlap_over_min(first["box"], second["box"])
            if ratio > 0.15:
                found = True
                print(f"  {ratio:.2f}  [{first['index']}] {first['text']!r}")
                print(f"        [{second['index']}] {second['text']!r}")
    if not found:
        print("  无")

    if args.annotate:
        preview = image.copy()
        draw = ImageDraw.Draw(preview)
        for record in records:
            left, top, right, bottom = record["box"]
            draw.rectangle((left, top, right, bottom), outline=(255, 0, 0), width=2)
        preview.save(args.annotate)
        print(f"\n标注图: {args.annotate}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
