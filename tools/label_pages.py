"""Produce numbered overlays of detected regions, so a human can label them.

Every accuracy idea so far has been judged against synthetic pages or two real
ones, and both turned out to be misleading. Improving precision on real pages
needs labels from real pages: what is actually printed there, versus what the
pipeline claimed.

This writes, for each page, an image with every detected region numbered and a
JSON file listing the readings. Filling in the JSON by eye is the ground truth
that the filters get scored against.

Usage:
    python tools/label_pages.py --limit 4
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402

FONTS = [r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\arial.ttf"]


def label_font(size: int):
    for path in FONTS:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="testdata/real")
    parser.add_argument("--out", default="testdata/labels")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--width", type=int, default=900)
    args = parser.parse_args()

    source_dir = Path(args.dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    images = sorted(
        path for path in source_dir.iterdir()
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if args.limit:
        images = images[: args.limit]

    for path in images:
        source = Image.open(path).convert("RGB")
        scale = min(1.0, args.width / source.width)
        image = source.resize(
            (round(source.width * scale), round(source.height * scale)),
            Image.Resampling.LANCZOS,
        ) if scale < 1.0 else source

        regions = detect_text_regions(image, limit=24)
        entries = []
        overlay = image.copy()
        draw = ImageDraw.Draw(overlay)
        font = label_font(max(13, image.width // 70))

        for index, box in enumerate(regions):
            detailed = recognize_detailed(image.crop(box))
            text = "\n".join(detailed["texts"]).strip()
            entries.append({
                "index": index,
                "box": list(box),
                "text": text,
                "confidence": round(detailed["confidence"], 3),
                "direction": detailed["direction"],
                # Filled in by eye: "yes" the reading matches the page, "no" it
                # does not (fabricated or wrong), "part" if partly right.
                "correct": "",
            })
            draw.rectangle(box, outline=(230, 40, 40), width=2)
            draw.rectangle((box[0], box[1], box[0] + font.size + 8, box[1] + font.size + 6),
                           fill=(230, 40, 40))
            draw.text((box[0] + 4, box[1] + 2), str(index), font=font, fill="white")

        stem = path.stem[:48]
        overlay.save(out / f"{stem}-boxes.png")
        (out / f"{stem}.json").write_text(json.dumps({
            "image": str(path), "width": image.size[0], "height": image.size[1],
            "regions": entries,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  {stem}: {len(entries)} 个区域 -> {stem}-boxes.png")

    print(f"\n标注目录：{out}")
    print("把每个 json 里 regions[].correct 填成 yes / no / part，再用 eval_filters.py 打分")
    return 0


if __name__ == "__main__":
    sys.exit(main())
