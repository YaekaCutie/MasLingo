"""Run the server-side region detector over a raw RGBA dump and print its boxes.

Used by tools/regions_parity_test.mjs to check that the JavaScript port in
extension/ocr/regions.js produces the same regions as backend/ocr/bubble_detector.py.

Usage:
    python tools/detect_regions_reference.py --image work/page.rgba --size work/page.size.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

from backend.ocr.bubble_detector import detect_text_regions  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="raw RGBA file")
    parser.add_argument("--size", required=True, help="JSON with width/height")
    parser.add_argument("--limit", type=int, default=24)
    args = parser.parse_args()

    size = json.loads(Path(args.size).read_text(encoding="utf-8"))
    data = Path(args.image).read_bytes()
    expected = size["width"] * size["height"] * 4
    if len(data) != expected:
        raise SystemExit(f"expected {expected} bytes for {size['width']}x{size['height']}, got {len(data)}")

    image = Image.frombytes("RGBA", (size["width"], size["height"]), data).convert("RGB")
    regions = detect_text_regions(image, limit=args.limit)
    print(json.dumps({
        "width": size["width"],
        "height": size["height"],
        "regions": [{"left": l, "top": t, "right": r, "bottom": b} for l, t, r, b in regions],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
