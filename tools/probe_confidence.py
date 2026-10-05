"""Does the model's own confidence separate real lettering from artwork?

The detector hands over regions made of hair and screentone, and manga-ocr
answers with fluent Japanese anyway ("そういえば、"), which then gets painted
over the drawing. Token probability is the one signal that should differ between
"text I can read" and "texture I am guessing at", so this measures it on every
region of a real page before any threshold is chosen.

Usage:
    python tools/probe_confidence.py --image "Image from URL 2" --width 760
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402


def main() -> int:
    from PIL import Image

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=760)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    scale = args.width / source.width
    image = source.resize((args.width, round(source.height * scale)), Image.Resampling.LANCZOS)

    regions = detect_text_regions(image, limit=24)
    print(f"{'#':>3} {'尺寸':>10} {'置信度':>8} {'方向':>10}  文本（× = 会被可读性过滤掉）")
    print("-" * 96)

    survivors = []
    for index, box in enumerate(regions):
        detailed = recognize_detailed(image.crop(box))
        text = "\n".join(detailed["texts"]).strip()
        passes = sum(character.isalnum() for character in text) >= 4
        mark = "  " if passes else "× "
        print(
            f"{index:>3} {box[2]-box[0]:>4}x{box[3]-box[1]:<5} {detailed['confidence']:>8.3f} "
            f"{str(detailed['direction']):>10}  {mark}{text!r}"
        )
        if passes:
            survivors.append((detailed["confidence"], text))

    print(f"\n通过可读性过滤的条目共 {len(survivors)} 条，按其置信度排序：")
    for confidence, text in sorted(survivors, reverse=True):
        print(f"  {confidence:.3f}  {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
