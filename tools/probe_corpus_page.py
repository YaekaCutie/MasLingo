"""Explain, for one corpus page, why regions were found or missed.

The corpus reports recall as a single number; this shows the pixels behind it —
how dark the text actually is, how much of each ground-truth box is ink, and
what the detector returned instead.

Usage:
    python tools/probe_corpus_page.py --page page01.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="testdata/corpus")
    parser.add_argument("--page", default="page01.png")
    args = parser.parse_args()

    corpus_dir = Path(args.corpus)
    truth = json.loads((corpus_dir / "ground_truth.json").read_text(encoding="utf-8"))
    page = next(p for p in truth if p["image"] == args.page)
    image = Image.open(corpus_dir / args.page).convert("RGB")
    gray = np.asarray(image.convert("L"))

    print(f"{args.page}  {image.size[0]}x{image.size[1]}")
    print(f"整页灰度: 最暗 {gray.min()}  最亮 {gray.max()}  中位 {int(np.median(gray))}")
    print(f"  暗于120: {(gray < 120).mean() * 100:.2f}%   暗于185: {(gray < 185).mean() * 100:.2f}%")
    print()
    print("标准答案区域：")
    for region in page["regions"]:
        left, top, right, bottom = region["box"]
        crop = gray[top:bottom, left:right]
        if crop.size == 0:
            continue
        print(
            f"  {region['kind']:<10} {right-left:>4}x{bottom-top:<4} "
            f"最暗 {crop.min():>3}  暗于185 {(crop < 185).mean() * 100:>5.1f}%  "
            f"{region['text']}"
        )

    regions = detect_text_regions(image, limit=24)
    print(f"\n检测器返回 {len(regions)} 个区域：")
    for box in regions:
        left, top, right, bottom = box
        crop = gray[top:bottom, left:right]
        ink = (crop < 185).mean() * 100 if crop.size else 0
        print(f"  {left:>4},{top:>4} → {right:>4},{bottom:>4}  {right-left:>4}x{bottom-top:<4} 墨 {ink:5.1f}%")

    # Feeding each region in on its own separates two very different failures:
    # "this text is not detectable" from "this text was detectable but got
    # swallowed by something else on the page".
    print("\n每块文字单独送进检测器：")
    for region in page["regions"]:
        left, top, right, bottom = region["box"]
        pad = 18
        crop = image.crop((
            max(0, left - pad), max(0, top - pad),
            min(image.width, right + pad), min(image.height, bottom + pad),
        ))
        found = detect_text_regions(crop, limit=24)
        if found:
            near = max(
                iou(region["box"], [
                    box[0] + max(0, left - pad), box[1] + max(0, top - pad),
                    box[2] + max(0, left - pad), box[3] + max(0, top - pad),
                ])
                for box in found
            )
        else:
            near = 0.0
        verdict = "单独也检不出" if near < 0.2 else "单独能检出"
        print(f"  {region['kind']:<10} {verdict}  (最佳重叠 {near:.2f}, 返回 {len(found)} 个)  {region['text']}")
    return 0


def iou(first, second) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    if not intersection:
        return 0.0
    area = lambda box: max(0, box[2] - box[0]) * max(0, box[3] - box[1])  # noqa: E731
    union = area(first) + area(second) - intersection
    return intersection / union if union else 0.0


if __name__ == "__main__":
    raise SystemExit(main())
