"""Run the pipeline over real pages and report what it finds.

The synthetic corpus says recall is low, but synthetic pages are only as
realistic as the generator. Real pages answer the question that matters: is that
number representative, or an artefact of the corpus?

There is no ground truth here, so this reports counts and readings for a human to
check rather than a score.

Usage:
    python tools/measure_real.py --limit 6 --verbose
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402


def readable(text: str) -> bool:
    return sum(character.isalnum() for character in text) >= 4


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="testdata/real")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--width", type=int, default=760, help="display width to emulate")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--annotate", default="", help="write boxed copies here")
    args = parser.parse_args()

    directory = Path(args.dir)
    images = sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if args.limit:
        images = images[: args.limit]
    if not images:
        print(f"{directory} 里没有图片，先跑 tools/fetch_pages.py")
        return 2

    if args.annotate:
        Path(args.annotate).mkdir(parents=True, exist_ok=True)

    totals = {"pages": 0, "regions": 0, "kept": 0}
    for path in images:
        source = Image.open(path).convert("RGB")
        scale = min(1.0, args.width / source.width)
        image = source.resize(
            (round(source.width * scale), round(source.height * scale)),
            Image.Resampling.LANCZOS,
        ) if scale < 1.0 else source

        regions = detect_text_regions(image, limit=24)
        kept = []
        for box in regions:
            detailed = recognize_detailed(image.crop(box))
            text = "\n".join(detailed["texts"]).strip()
            if readable(text):
                kept.append((box, text, detailed["confidence"], detailed["direction"]))

        totals["pages"] += 1
        totals["regions"] += len(regions)
        totals["kept"] += len(kept)
        print(f"{path.name[:34]:<36} {image.size[0]}x{image.size[1]:<6} "
              f"检出 {len(regions):>2}  通过过滤 {len(kept):>2}")

        if args.verbose:
            for box, text, confidence, direction in kept:
                print(f"     {str(direction):<10} {confidence:.3f}  {text[:52]!r}")

        if args.annotate:
            from PIL import ImageDraw

            preview = image.copy()
            draw = ImageDraw.Draw(preview)
            for box in regions:
                draw.rectangle(box, outline=(220, 40, 40), width=2)
            for box, _text, _c, _d in kept:
                draw.rectangle(box, outline=(20, 140, 120), width=2)
            preview.save(Path(args.annotate) / path.name)

    print()
    print(f"{totals['pages']} 页，检出 {totals['regions']} 个区域，"
          f"其中通过可读性过滤 {totals['kept']} 个")
    print(f"平均每页检出 {totals['regions'] / totals['pages']:.1f}，"
          f"通过 {totals['kept'] / totals['pages']:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
