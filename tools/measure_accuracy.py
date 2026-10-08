"""Measure the real pipeline against the corpus's ground truth.

Accuracy is only meaningful as a number, so this runs the actual backend over
generated pages and reports three things separately, because they fail for
different reasons and are fixed in different places:

    detection recall    did we find the region at all
    detection precision how much of what we returned was real
    reading accuracy    of the regions we found, how much text was right

A single "accuracy" figure would hide which of the three is the problem.

Usage:
    python tools/measure_accuracy.py                    # whole corpus
    python tools/measure_accuracy.py --page page03.png  # one page
    python tools/measure_accuracy.py --verbose
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

BACKEND = "http://127.0.0.1:8001"


def normalise(text: str) -> str:
    """Compare on content only: punctuation width and spacing vary by engine."""
    table = str.maketrans({
        "．": ".", "，": ",", "：": ":", "！": "!", "？": "?", "〜": "~", "～": "~",
        "－": "-", "ー": "-", "　": "",
    })
    return "".join(character for character in text.translate(table) if not character.isspace())


def edit_distance(first: str, second: str) -> int:
    if first == second:
        return 0
    previous = list(range(len(second) + 1))
    for i, a in enumerate(first, start=1):
        current = [i]
        for j, b in enumerate(second, start=1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a != b),
            ))
        previous = current
    return previous[-1]


def similarity(first: str, second: str) -> float:
    first, second = normalise(first), normalise(second)
    if not first and not second:
        return 1.0
    longest = max(len(first), len(second))
    if not longest:
        return 1.0
    return 1.0 - edit_distance(first, second) / longest


def iou(first: list[int], second: list[int]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    if not intersection:
        return 0.0
    area = lambda box: max(0, box[2] - box[0]) * max(0, box[3] - box[1])  # noqa: E731
    union = area(first) + area(second) - intersection
    return intersection / union if union else 0.0


def recognise(path: Path) -> list[dict]:
    boundary = "----maslingo-measure"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; '
        f'filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n'
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        BACKEND + "/api/recognize-page",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    payload = json.loads(urllib.request.urlopen(request, timeout=1200).read().decode())
    return payload.get("items", [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", default="testdata/corpus")
    parser.add_argument("--page", default="")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--iou", type=float, default=0.25, help="match threshold")
    args = parser.parse_args()

    corpus_dir = Path(args.corpus)
    truth_path = corpus_dir / "ground_truth.json"
    if not truth_path.is_file():
        print(f"找不到 {truth_path}，先跑 tools/make_corpus.py")
        return 2

    corpus = json.loads(truth_path.read_text(encoding="utf-8"))
    if args.page:
        corpus = [page for page in corpus if page["image"] == args.page]
        if not corpus:
            print(f"语料里没有 {args.page}")
            return 2

    totals = {"truth": 0, "found": 0, "detected": 0, "matched": 0, "chars": 0, "errors": 0.0}
    by_kind: dict[str, dict] = {}

    for page in corpus:
        image = corpus_dir / page["image"]
        items = recognise(image)

        matched_truth: set[int] = set()
        matched_items: set[int] = set()
        rows = []
        for index, region in enumerate(page["regions"]):
            best, best_score = -1, args.iou
            for other, item in enumerate(items):
                if other in matched_items:
                    continue
                score = iou(region["box"], [
                    item["bbox"]["left"], item["bbox"]["top"],
                    item["bbox"]["right"], item["bbox"]["bottom"],
                ])
                if score > best_score:
                    best, best_score = other, score
            if best >= 0:
                matched_truth.add(index)
                matched_items.add(best)
                got = items[best]["text"]
                score = similarity(region["text"], got)
                rows.append((region, got, score, "ok" if score > 0.99 else "diff"))
                stats = by_kind.setdefault(region["kind"], {"truth": 0, "found": 0, "chars": 0, "errors": 0.0})
                stats["truth"] += 1
                stats["found"] += 1
                stats["chars"] += len(normalise(region["text"]))
                stats["errors"] += edit_distance(normalise(region["text"]), normalise(got))
                totals["chars"] += len(normalise(region["text"]))
                totals["errors"] += edit_distance(normalise(region["text"]), normalise(got))
            else:
                rows.append((region, None, 0.0, "missed"))
                stats = by_kind.setdefault(region["kind"], {"truth": 0, "found": 0, "chars": 0, "errors": 0.0})
                stats["truth"] += 1

        totals["truth"] += len(page["regions"])
        totals["found"] += len(matched_truth)
        totals["detected"] += len(items)
        totals["matched"] += len(matched_items)

        misses = len(page["regions"]) - len(matched_truth)
        extras = len(items) - len(matched_items)
        print(f"{page['image']}: 标准答案 {len(page['regions'])}  检出 {len(items)}  "
              f"漏 {misses}  多 {extras}")
        if args.verbose:
            for region, got, score, status in rows:
                mark = {"ok": "  ", "diff": "~ ", "missed": "× "}[status]
                print(f"   {mark}{region['kind']:<10} {score*100:5.1f}%  "
                      f"答案 {region['text']!r}")
                if got is not None and status != "ok":
                    print(f"             读到 {got!r}")

    print()
    recall = totals["found"] / totals["truth"] if totals["truth"] else 0
    precision = totals["matched"] / totals["detected"] if totals["detected"] else 0
    accuracy = 1 - totals["errors"] / totals["chars"] if totals["chars"] else 0
    print(f"检出率（召回）  {recall*100:6.1f}%   {totals['found']}/{totals['truth']}")
    print(f"检出准确率      {precision*100:6.1f}%   {totals['matched']}/{totals['detected']}")
    print(f"读取准确率      {accuracy*100:6.1f}%   字符错误 {int(totals['errors'])}/{totals['chars']}")

    print("\n分类：")
    for kind, stats in sorted(by_kind.items()):
        kind_recall = stats["found"] / stats["truth"] if stats["truth"] else 0
        kind_accuracy = 1 - stats["errors"] / stats["chars"] if stats["chars"] else 0
        print(f"  {kind:<10} 检出 {kind_recall*100:5.1f}%  "
              f"读取 {kind_accuracy*100:5.1f}%  ({stats['found']}/{stats['truth']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
