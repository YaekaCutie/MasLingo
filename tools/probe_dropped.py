"""Contact sheet of the regions the confidence filter would drop.

The filter was tuned on a page whose false positives came from hair texture. On
a dialogue-dense page it may be throwing away real lines instead, and only
looking at the crops can settle that — the readings alone are not evidence.

Usage:
    python tools/probe_dropped.py --image <path> --width 1100 --out sheet.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import (  # noqa: E402
    MIN_CONFIDENCE,
    MIN_CONFIDENCE_TEXT_LENGTH,
    is_confident_reading,
    recognize_detailed,
)


def main() -> int:
    from PIL import Image, ImageDraw

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=1100)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    scale = args.width / source.width
    image = source.resize((args.width, round(source.height * scale)), Image.Resampling.LANCZOS)

    regions = detect_text_regions(image, limit=24)
    dropped = []
    for box in regions:
        detailed = recognize_detailed(image.crop(box))
        text = "\n".join(detailed["texts"]).strip()
        alnum = sum(character.isalnum() for character in text)
        if alnum < 4:
            continue                      # already dropped as unreadable
        if is_confident_reading(text, detailed["confidence"]):
            continue                      # kept
        dropped.append((box, detailed["confidence"], text, alnum))

    print(f"阈值: 置信度 < {MIN_CONFIDENCE} 且字母数字 <= {MIN_CONFIDENCE_TEXT_LENGTH}")
    print(f"会被丢弃的条目: {len(dropped)}\n")

    if not dropped:
        return 0

    cell_height = 260
    cells = []
    for box, confidence, text, alnum in dropped:
        crop = image.crop(box)
        crop = crop.resize(
            (max(1, round(crop.width * cell_height / crop.height)), cell_height),
            Image.Resampling.LANCZOS,
        )
        cells.append((crop, confidence, text, alnum))

    total_width = sum(cell.width for cell, *_ in cells) + 10 * (len(cells) + 1)
    sheet = Image.new("RGB", (total_width, cell_height + 60), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    x = 10
    for index, (cell, confidence, text, alnum) in enumerate(cells):
        sheet.paste(cell, (x, 40))
        draw.text((x, 8), f"[{index}] conf={confidence:.3f} alnum={alnum}", fill=(180, 0, 0))
        draw.text((x, 22), text[:26], fill=(0, 0, 0))
        print(f"  [{index}] conf={confidence:.3f} alnum={alnum:>2}  {text!r}")
        x += cell.width + 10

    sheet.save(args.out)
    print(f"\n对照图: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
