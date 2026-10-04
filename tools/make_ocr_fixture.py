"""Render a small Japanese sample image used as an OCR test fixture.

The probe crops used during development come from a commercial manga page and
must not be committed, so CI needs a copyright-clean stand-in. This renders a
neutral phrase with a system font; the phrase is deliberately *not* from any
manga.

Vertical writing is included because that is the common case for manga and the
model handles it in the same single-image call.

Usage:
    python tools/make_ocr_fixture.py --out tools/fixtures
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]

HORIZONTAL = "日本語のテストです"
VERTICAL = "よこはま"
# Several well-separated lines, so the region detector has something to find.
PAGE_LINES = [
    "日本語のテストです",
    "こんにちは世界",
    "漫画の翻訳",
    "テストページ",
    "おはようございます",
    "ありがとう",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            return path
    raise SystemExit("no Japanese font found; install fonts-noto-cjk or edit FONT_CANDIDATES")


def render_page(path: Path, size: int) -> None:
    """A manga-like page: phrases inside closed white balloons.

    Deliberately balloon-shaped rather than bare lines. The detector treats a
    closed light balloon as one region and crops the whole thing, which is far
    more robust than grouping bare glyphs — a page of loose lines gets split
    into fragments that are too short for the backend's readable-text filter.
    """
    font = ImageFont.truetype(find_font(), int(size * 0.75))
    width, height = size * 10, size * 16
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    balloons = [
        (40, 60, 300, 260, "こんにちは"),
        (360, 120, 600, 320, "漫画の翻訳"),
        (80, 420, 340, 620, "ありがとう"),
    ]
    for left, top, right, bottom, text in balloons:
        draw.ellipse([left, top, right, bottom], fill="white", outline="black", width=3)
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(
            (
                left + (right - left - (box[2] - box[0])) / 2,
                top + (bottom - top - (box[3] - box[1])) / 2 - box[1],
            ),
            text,
            fill="black",
            font=font,
        )

    # A dark panel with hatching: the kind of artwork that used to be mistaken
    # for text, kept here so the fixture exercises that rejection too.
    draw.rectangle([360, 420, 600, 640], fill="#1a1a1a")
    for x in range(370, 596, 7):
        draw.line([x, 425, x + 5, 636], fill="#6a6a6a")

    image.save(path)
    print(f"{path}: {image.width}x{image.height}  {len(balloons)} balloons + 1 dark panel")


def render(path: Path, text: str, size: int, vertical: bool) -> None:
    font = ImageFont.truetype(find_font(), size)
    if vertical:
        width, height = int(size * 1.6), int(size * 1.35 * len(text))
    else:
        width, height = int(size * 1.3 * len(text)), int(size * 1.8)

    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    if vertical:
        for index, character in enumerate(text):
            draw.text((size * 0.3, index * size * 1.35), character, fill="black", font=font)
    else:
        draw.text((size * 0.15, size * 0.3), text, fill="black", font=font)
    image.save(path)
    print(f"{path}: {image.width}x{image.height}  {text!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", type=int, default=64)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    render(out / "jp-horizontal.png", HORIZONTAL, args.size, vertical=False)
    render(out / "jp-vertical.png", VERTICAL, args.size, vertical=True)
    render_page(out / "jp-page.png", args.size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
