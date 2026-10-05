"""Falsification test for the "binary share" feature.

The measurements on two real pages suggest artwork texture (hair, shading) is
almost purely black-and-white, while lettering keeps a band of antialiased
midtones, so "share of pixels that are strongly dark or strongly light" looked
like a separator. Before trusting it, check the cases most likely to break it:
clean synthetic lettering with no noise at all, and lettering at several sizes.
If clean text also scores high, the feature would reject real text and must be
thrown away.

Usage:
    python tools/probe_binary_feature.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from probe_features import features  # noqa: E402

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit("需要一款日文字体")


def measure(label: str, image: Image.Image) -> float:
    data = features(image)
    print(
        f"{label:<34} 组件{data['components']:>4}  二值% {data['binary%']:>5.1f}  "
        f"墨% {data['ink%']:>5.1f}  最跨度 {data['maxSpan']:>5.0f}%"
    )
    return data["binary%"]


def main() -> int:
    print("合成文字（无噪点，最有利于'高比例'的情形）")
    scores = []
    for size in (28, 40, 64, 96):
        image = Image.new("RGB", (size * 12, int(size * 2.2)), "white")
        ImageDraw.Draw(image).text((10, size * 0.3), "こんにちは世界", fill="black", font=font(size))
        scores.append(measure(f"  纯黑纯白 {size}px", image))

    for size in (28, 40, 64):
        image = Image.new("RGB", (size * 12, int(size * 2.2)), (246, 246, 246))
        ImageDraw.Draw(image).text((10, size * 0.3), "こんにちは世界", fill=(28, 28, 28), font=font(size))
        scores.append(measure(f"  灰底灰字 {size}px", image))

    print(f"\n合成文字最高：{max(scores):.1f}%")
    print("实测真文字：  82.5 / 90.4 / 90.2 / 92.4 / 88.2 / 81.4 / 86.7 / 65.5 / 63.2 %")
    print("实测误检：    94.4 / 96.0 %")
    if max(scores) >= 93:
        print("\n结论：合成文字也超过 93%，该特征会误杀真文字 —— 不可用。")
        return 1
    print(f"\n结论：合成文字最高 {max(scores):.1f}%，低于 93%；特征仍站得住，但余量只有 "
          f"{93 - max(scores):.1f} 个百分点。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
