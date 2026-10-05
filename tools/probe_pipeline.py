"""Should the service worker upscale before detection at all?

The upscale to 1600px helps when the page is displayed small (the detector's
morphology kernels are tuned for larger images) and hurts when it is not: a
1.45x bilinear blow-up dilutes a one-pixel white-on-black stroke below the
detector's fixed ">235 = light ink" mask, and that lettering then disappears.

This sweeps display widths through both strategies and counts how many of the
page's known text areas come back.

Usage:
    python tools/probe_pipeline.py --image "Image from URL 2"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize  # noqa: E402

# Text areas in the 768x1119 original. The last one is the case that regressed:
# white lettering painted straight onto the artwork, not inside a balloon.
AREAS = {
    "右上气泡": (500, 60, 700, 230),
    "左上气泡": (200, 20, 360, 165),
    "左中气泡": (85, 350, 250, 520),
    "中气泡": (280, 320, 500, 530),
    "右下黑底白字": (470, 780, 720, 975),
}


def overlap(box, region) -> float:
    left, top, right, bottom = box
    r_left, r_top, r_right, r_bottom = region
    width = max(0, min(right, r_right) - max(left, r_left))
    height = max(0, min(bottom, r_bottom) - max(top, r_top))
    area = (right - left) * (bottom - top)
    return (width * height) / area if area else 0.0


def evaluate(image: Image.Image, scale: float) -> tuple[int, dict[str, str]]:
    regions = detect_text_regions(image, limit=24)
    hits: dict[str, str] = {}
    for name, box in AREAS.items():
        scaled = tuple(round(value * scale) for value in box)
        match = next((r for r in regions if overlap(scaled, r) > 0.5), None)
        if match:
            hits[name] = recognize(image.crop(match))
    return len(hits), hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    print(f"原图 {source.size}，共 {len(AREAS)} 个已知文字区\n")
    print(f"{'显示宽度':>8}  {'不放大':>18}  {'放大到 1600px':>22}")
    print(f"{'':>8}  {'命中':>6} {'右下角':>10}  {'命中':>6} {'右下角':>10}")

    totals = {"none": 0, "upscale": 0}
    widths = (400, 470, 540, 620, 700, 760, 900)
    for width in widths:
        rendered = source.resize(
            (width, round(source.height * width / source.width)), Image.Resampling.LANCZOS
        )
        scale = width / source.width

        plain_hits, plain_detail = evaluate(rendered, scale)
        upscale = max(1.0, min(3.0, 1600 / max(rendered.size)))
        blown = rendered.resize(
            (round(rendered.width * upscale), round(rendered.height * upscale)),
            Image.Resampling.BILINEAR,
        )
        blown_hits, blown_detail = evaluate(blown, scale * upscale)

        totals["none"] += plain_hits
        totals["upscale"] += blown_hits
        mark = lambda detail: "命中" if "右下黑底白字" in detail else "丢失"
        print(f"{width:>8}  {plain_hits:>4}/{len(AREAS)} {mark(plain_detail):>10}  "
              f"{blown_hits:>4}/{len(AREAS)} {mark(blown_detail):>10}  (放大 {upscale:.2f}x)")

    print()
    print(f"合计命中：不放大 {totals['none']}，放大到 1600px {totals['upscale']} "
          f"（满分为 {len(widths) * len(AREAS)}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
