"""Choose the acceptance thresholds against pages whose truth is known.

Two pages carry reliable labels without a full annotation pass:

  * an English scanlation page, where every reading the pipeline produces is by
    definition fabricated. Any reading accepted here is a false positive, so it
    measures precision directly.
  * the Chainsaw Man page whose five balloons were transcribed earlier, so a
    reading matching one of them is a true positive and anything else is not.

The trade is asymmetric and deliberate: refusing a real reading leaves Japanese
on the page, which the user can still select by hand, while accepting an
invention paints confident nonsense over the drawing.

Usage:
    python tools/tune_thresholds.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402
from backend.ocr.manga_ocr_engine import recognize_detailed  # noqa: E402

FULLWIDTH = set(
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９"
)

# Everything on this page is English, so nothing read from it can be correct.
FABRICATED_PAGE = "testdata/real/20190706025145_gpkox.thumb.1000_0.jpg"

# Transcribed from the artwork: a reading is a true positive only if it carries
# one of these.
GENUINE_PAGE = "testdata/real/2066-313a34d763174262db7210be8c36742a.jpg"
GENUINE = [
    "早く時間過ぎて",
    "気まず",
    "アサちゃんはチェンソーマン好き",
    "まあまあ",
    "告白したの私じゃないのに",
]


def latin_ratio(text: str) -> float:
    if not text:
        return 0.0
    count = sum(1 for character in text if character in FULLWIDTH)
    count += sum(1 for character in text if character.isascii() and character.isalpha())
    return count / len(text)


def normalise(text: str) -> str:
    for character in " 　\n〜～~ー－-．・、。：:！!？?「」":
        text = text.replace(character, "")
    return text


def collect(path: str, width: int = 900):
    image = Image.open(path).convert("RGB")
    scale = min(1.0, width / image.width)
    if scale < 1.0:
        image = image.resize(
            (round(image.width * scale), round(image.height * scale)),
            Image.Resampling.LANCZOS,
        )
    out = []
    for box in detect_text_regions(image, limit=24):
        detailed = recognize_detailed(image.crop(box))
        text = "\n".join(detailed["texts"]).strip()
        if sum(character.isalnum() for character in text) < 4:
            continue
        out.append((text, detailed["confidence"], latin_ratio(text)))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latin", type=float, nargs="*", default=[0.0, 0.2, 0.3, 0.35, 0.5])
    parser.add_argument("--confidence", type=float, nargs="*",
                        default=[0.0, 0.3, 0.45, 0.55, 0.65, 0.7, 0.8])
    parser.add_argument("--min-length", type=int, nargs="*", default=[0, 8])
    args = parser.parse_args()

    fabricated = collect(FABRICATED_PAGE)
    genuine_pool = collect(GENUINE_PAGE)
    genuine = []
    for text, confidence, latin in genuine_pool:
        hit = any(key in normalise(text) for key in GENUINE)
        genuine.append((text, confidence, latin, hit))

    print(f"英文页（全部为编造）: {len(fabricated)} 条")
    for text, confidence, latin in fabricated:
        print(f"   {confidence:.2f} 拉丁{latin:.2f}  {text[:44]!r}")
    print(f"\n日文页: {len(genuine)} 条，其中命中真值 {sum(1 for g in genuine if g[3])} 条")
    for text, confidence, latin, hit in genuine:
        print(f"   {'真' if hit else '假'}  {confidence:.2f} 拉丁{latin:.2f}  {text[:44]!r}")

    print(f"\n{'拉丁>=':>7} {'置信>=':>7} {'长度>':>6} {'保留编造':>9} {'保留真值':>9} {'精确率':>7}")
    print("-" * 56)
    best = None
    for latin_min in args.latin:
        for confidence_min in args.confidence:
            for min_length in args.min_length:
                def accept(text, confidence, latin):
                    if latin >= latin_min > 0:
                        return False
                    if confidence < confidence_min:
                        return False
                    if len(normalise(text)) <= min_length:
                        return False
                    return True

                kept_fake = sum(1 for t, c, l in fabricated if accept(t, c, l))
                kept_real = [g for g in genuine if g[3] and accept(g[0], g[1], g[2])]
                total_kept = kept_fake + sum(1 for g in genuine if accept(g[0], g[1], g[2]))
                precision = (sum(1 for g in genuine if g[3] and accept(g[0], g[1], g[2])) / total_kept
                             if total_kept else 1.0)
                print(f"{latin_min:>7.2f} {confidence_min:>7.2f} {min_length:>6} "
                      f"{kept_fake:>9} {len(kept_real):>9} {precision*100:>6.1f}%")
                key = (len(kept_real), -kept_fake)
                if best is None or key > best[0]:
                    best = (key, latin_min, confidence_min, min_length, len(kept_real), kept_fake)
    if best:
        _, latin_min, confidence_min, min_length, kept_real, kept_fake = best
        print(f"\n最优：拉丁>={latin_min} 置信>={confidence_min} 长度>{min_length}  "
              f"→ 保留真值 {kept_real}/{sum(1 for g in genuine if g[3])}，放行编造 {kept_fake}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
