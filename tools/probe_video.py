"""Pull frames out of a screen recording so it can be looked at.

The recordings the user supplies are far too large to watch directly, so this
reports the basics and writes evenly spaced frames to disk.

Usage:
    python tools/probe_video.py <video> [--frames 12] [--out DIR] [--width 1200]
    python tools/probe_video.py <video> --at 12.5 30 61   # specific seconds
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2


def stamp(seconds: float) -> str:
    minutes, remainder = divmod(int(seconds), 60)
    return f"{minutes:02d}m{remainder:02d}s"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video")
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--out", default="")
    parser.add_argument("--width", type=int, default=1200)
    parser.add_argument("--at", type=float, nargs="*", default=None,
                        help="times in seconds; overrides --frames")
    args = parser.parse_args()

    source = Path(args.video)
    if not source.is_file():
        print(f"找不到文件: {source}")
        return 2

    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        print("无法打开视频（编码可能不受支持）")
        return 2

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total / fps if fps else 0.0
    print(f"分辨率 {width}x{height}   {fps:.1f} fps   {total} 帧   时长 {stamp(duration)}")

    out_dir = Path(args.out) if args.out else source.parent / f"{source.stem}-frames"
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.at:
        times = list(args.at)
    else:
        # Skip the very start and end: the first seconds are usually the window
        # being arranged and the last are usually the stop click.
        margin = min(2.0, duration * 0.03)
        span = max(0.1, duration - margin * 2)
        times = [margin + span * index / max(1, args.frames - 1) for index in range(args.frames)]

    scale = min(1.0, args.width / width) if width else 1.0
    written = []
    for index, seconds in enumerate(times):
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000.0)
        ok, frame = capture.read()
        if not ok:
            print(f"  {stamp(seconds)}  读取失败")
            continue
        if scale < 1.0:
            frame = cv2.resize(
                frame,
                (int(frame.shape[1] * scale), int(frame.shape[0] * scale)),
                interpolation=cv2.INTER_AREA,
            )
        path = out_dir / f"{index:02d}-{stamp(seconds)}.png"
        cv2.imwrite(str(path), frame)
        written.append(path)
        print(f"  {stamp(seconds)}  ->  {path.name}")

    capture.release()
    print(f"\n输出目录: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
