"""Pick the duplicate-overlap threshold by measurement.

Two proposals that overlap are usually the same piece of text found twice, and
the old thresholds let several through — the extension then painted two
overlapping patches whose readings disagreed. Lowering the threshold merges
more, but too low starts eating genuinely separate blocks, so the value is swept
here against two counters that matter: how many of the page's real text blocks
survive, and how many overlapping pairs remain.

Usage:
    python tools/tune_duplicates.py --image "Image from URL 2" --width 760
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr import bubble_detector  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402

# Text that is genuinely on the page (normalised: whitespace and the various
# dash/tilde characters differ between readings).
KNOWN = [
    "早く時間",
    "気まず",
    "アサちゃんはチェンソーマン好き",
    "まあまあ",
    "告白したの私じゃないのに",
]

THRESHOLDS = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]


def normalise(text: str) -> str:
    for character in " 　\n〜～~ー－-．・、。：:！!？?":
        text = text.replace(character, "")
    return text


def overlap_over_min(first, second) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    smaller = min(
        (first[2] - first[0]) * (first[3] - first[1]),
        (second[2] - second[0]) * (second[3] - second[1]),
    )
    return intersection / smaller if smaller else 0.0


def main() -> int:
    from PIL import Image

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--width", type=int, default=760)
    args = parser.parse_args()

    source = Image.open(args.image).convert("RGB")
    scale = args.width / source.width
    image = source.resize((args.width, round(source.height * scale)), Image.Resampling.LANCZOS)

    print(f"{'阈值':>6} {'区域数':>6} {'命中真文字':>10} {'重叠对':>7} {'通过过滤的条目'}")
    print("-" * 100)
    for threshold in THRESHOLDS:
        bubble_detector.DUPLICATE_OVERLAP = threshold
        regions = bubble_detector.detect_text_regions(image, limit=24)

        kept = []
        for box in regions:
            text = "\n".join(recognize_detailed(image.crop(box))["texts"]).strip()
            if sum(character.isalnum() for character in text) >= 4:
                kept.append((box, text))

        joined = [normalise(text) for _, text in kept]
        hits = sum(any(known in text for text in joined) for known in KNOWN)

        pairs = 0
        for index, (box, _) in enumerate(kept):
            for other, _ in kept[index + 1:]:
                if overlap_over_min(box, other) > 0.15:
                    pairs += 1

        sample = " | ".join(text.replace("\n", "") for _, text in kept)
        print(f"{threshold:>6} {len(regions):>6} {hits:>7}/{len(KNOWN)} {pairs:>7}  {sample[:60]}")

    bubble_detector.DUPLICATE_OVERLAP = 0.35
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
