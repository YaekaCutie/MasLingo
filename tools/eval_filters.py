"""Which signal actually separates a real reading from a fabricated one?

Measured on real pages, the failure that hurts most is fluent invention: given
English lettering the model answers "そして、" with 0.455 confidence, and given a
panel of artwork it answers "そういえば、". Confidence alone does not separate
those from genuine low-confidence readings.

This scores every candidate signal on the same regions so the choice is made on
evidence:

    confidence          what the model says about its own answer
    fullwidth latin     English read as ＡＢＣ — real Japanese rarely looks like that
    self-consistency    read the same region from a slightly different crop; real
                        text survives, invention does not

Usage:
    python tools/eval_filters.py --dir testdata/labels
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402

FULLWIDTH = set(
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ"
    "０１２３４５６７８９"
)


def latin_ratio(text: str) -> float:
    if not text:
        return 0.0
    letters = sum(1 for character in text if character in FULLWIDTH)
    ascii_letters = sum(1 for character in text if character.isascii() and character.isalpha())
    return (letters + ascii_letters) / len(text)


def normalise(text: str) -> str:
    return "".join(character for character in text if character.isalnum())


def agreement(first: str, second: str) -> float:
    """Character-level overlap of two readings of the same region."""
    first, second = normalise(first), normalise(second)
    if not first or not second:
        return 0.0
    if first == second:
        return 1.0
    common = 0
    pool = list(second)
    for character in first:
        if character in pool:
            pool.remove(character)
            common += 1
    return common / max(len(first), len(second))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="testdata/labels")
    args = parser.parse_args()

    directory = Path(args.dir)
    files = sorted(directory.glob("*.json"))
    if not files:
        print(f"{directory} 里没有标注文件，先跑 tools/label_pages.py")
        return 2

    print(f"{'页面':<26} {'#':>3} {'置信':>5} {'拉丁':>5} {'自一致':>6}  读数")
    print("-" * 92)
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        image = Image.open(data["image"]).convert("RGB")
        scale = min(1.0, data["width"] / image.width)
        if scale < 1.0:
            image = image.resize(
                (round(image.width * scale), round(image.height * scale)),
                Image.Resampling.LANCZOS,
            )
        for region in data["regions"]:
            box = region["box"]
            straight = recognize_detailed(image.crop(tuple(box)))
            # Same text, different framing: pad a little differently and scale
            # slightly, which is what a different detection pass would produce.
            pad = 6
            jittered = image.crop((
                max(0, box[0] - pad), max(0, box[1] - pad),
                min(image.width, box[2] + pad), min(image.height, box[3] + pad),
            ))
            jittered = jittered.resize(
                (max(8, round(jittered.width * 0.92)), max(8, round(jittered.height * 0.92))),
                Image.Resampling.LANCZOS,
            )
            other = recognize_detailed(jittered)

            text = "\n".join(straight["texts"]).strip()
            other_text = "\n".join(other["texts"]).strip()
            score = agreement(text, other_text)
            print(f"{path.stem[:24]:<26} {region['index']:>3} {straight['confidence']:>5.2f} "
                  f"{latin_ratio(text):>5.2f} {score:>6.2f}  {text[:40]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
