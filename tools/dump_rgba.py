"""Dump the probe crops as raw RGBA so the JavaScript engine can be tested in
Node against exactly the pixels the browser's canvas would hand it.

Usage:
    python tools/dump_rgba.py --work DIR
Writes <name>.rgba plus <name>.size.json next to each <name>.png.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()

    work = Path(args.work)
    count = 0
    for png in sorted(work.glob("*.png")):
        image = Image.open(png).convert("RGBA")
        (work / f"{png.stem}.rgba").write_bytes(image.tobytes())
        (work / f"{png.stem}.size.json").write_text(
            json.dumps({"width": image.width, "height": image.height}), encoding="utf-8"
        )
        print(f"{png.name}: {image.width}x{image.height} -> {png.stem}.rgba")
        count += 1
    print(f"{count} image(s) dumped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
