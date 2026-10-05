"""Find the size at which the detector starts seeing text at all.

Feeding corpus regions in one at a time showed the blocks are rejected even in
isolation, so the question is not "what swallowed them" but "what does the
detector actually accept". This renders the same line at increasing sizes and
reports when it starts being found.

Usage:
    python tools/probe_text_size.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402

FONTS = [
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\meiryo.ttc",
]
TEXT = "まあまあっていうか普通"


def load(size: int):
    for path in FONTS:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size, index=1)   # bold face
            except Exception:
                return ImageFont.truetype(path, size)
    raise SystemExit("需要日文字体")


def vertical(image, text, x, y, font, rows, weight=0):
    draw = ImageDraw.Draw(image)
    box = draw.textbbox((0, 0), "漢", font=font)
    step = int((box[3] - box[1]) * 1.08)
    for index, character in enumerate(text):
        column, row = divmod(index, rows)
        draw.text((x - column * step, y + row * step), character, font=font,
                  fill=(20, 18, 16), stroke_width=weight, stroke_fill=(20, 18, 16))


def main() -> int:
    # Manga lettering is bold. Thin synthetic glyphs and real lettering are not
    # the same test, so both weights are measured side by side.
    print(f"{'字号':>5} {'细横':>5} {'细竖':>5} {'粗横':>5} {'粗竖':>5}")
    print("-" * 34)
    for size in (12, 14, 16, 18, 22, 26, 30, 36):
        font = load(size)
        row = []
        for weight in (0, 1):
            for direction in ("horizontal", "vertical"):
                image = Image.new("RGB", (420, 320), "white")
                if direction == "horizontal":
                    ImageDraw.Draw(image).text(
                        (30, 130), TEXT, font=font, fill=(20, 18, 16),
                        stroke_width=weight, stroke_fill=(20, 18, 16),
                    )
                else:
                    vertical(image, TEXT, 380, 30, font, rows=8, weight=weight)
                row.append(len(detect_text_regions(image, limit=24)))
        print(f"{size:>5} {row[0]:>5} {row[1]:>5} {row[2]:>5} {row[3]:>5}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
