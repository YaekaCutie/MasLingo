"""Why is white-on-black lettering never detected?

The corpus reports 0/8 for narration boxes, which is the case the user asked for
by name ("嵌在图里的白字"). This isolates it: a black box with white text, at
several sizes, against a plain page.

Usage:
    python tools/probe_light_text.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402

FONTS = [r"C:\Windows\Fonts\msgothic.ttc", r"C:\Windows\Fonts\YuGothM.ttc"]
TEXT = "その日、街は静かだった"


def load(size: int):
    for path in FONTS:
        if Path(path).is_file():
            return ImageFont.truetype(path, size, index=1)
    raise SystemExit("需要日文字体")


def main() -> int:
    print(f"{'字号':>5} {'白字检出':>8} {'黑字检出':>8}   备注")
    print("-" * 52)
    for size in (16, 20, 24, 28, 34):
        font = load(size)
        box = (40, 40, 300, 300)

        # White text on a solid black box — the narration-box case.
        dark_page = Image.new("RGB", (400, 400), "white")
        draw = ImageDraw.Draw(dark_page)
        draw.rectangle(box, fill=(18, 18, 18))
        draw.text((box[0] + 16, box[1] + 16), TEXT, font=font, fill=(250, 248, 244),
                  stroke_width=1, stroke_fill=(250, 248, 244))
        white_found = detect_text_regions(dark_page, limit=24)

        # The same text as black on white, for comparison.
        light_page = Image.new("RGB", (400, 400), "white")
        ImageDraw.Draw(light_page).text((40, 150), TEXT, font=font, fill=(20, 18, 16),
                                        stroke_width=1, stroke_fill=(20, 18, 16))
        black_found = detect_text_regions(light_page, limit=24)

        note = ""
        if not white_found and black_found:
            note = "黑字能检出，白字不能"
        print(f"{size:>5} {len(white_found):>8} {len(black_found):>8}   {note}")

    # How much pure-white ink is actually in the black box?
    page = Image.new("RGB", (400, 400), "white")
    draw = ImageDraw.Draw(page)
    draw.rectangle(box, fill=(18, 18, 18))
    draw.text((box[0] + 16, box[1] + 16), TEXT, font=load(24), fill=(250, 248, 244),
              stroke_width=1, stroke_fill=(250, 248, 244))
    gray = np.asarray(page.convert("L"))
    region = gray[box[1]:box[3], box[0]:box[2]]
    print(f"\n黑框内: >235 的像素 {(region > 235).mean() * 100:.1f}%  "
          f">230 {(region > 230).mean() * 100:.1f}%  <70 {(region < 70).mean() * 100:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
