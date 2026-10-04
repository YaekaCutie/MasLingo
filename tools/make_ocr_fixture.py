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


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            return path
    raise SystemExit("no Japanese font found; install fonts-noto-cjk or edit FONT_CANDIDATES")


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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
