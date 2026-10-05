"""Collect real manga pages from a Bing image search into a local test set.

The synthetic corpus has exact ground truth but only the cases I thought to
generate. Real pages bring the cases I did not: photographs of paper, coloured
scans, 4-koma, spreads, watermarks, layered balloons.

They are downloaded for local measurement only and are git-ignored. Published
manga belongs to its authors; nothing here is redistributed.

Usage:
    python tools/fetch_pages.py --query "日漫生肉截图" --want 12
    python tools/fetch_pages.py --url "<bing images url>" --want 12
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en;q=0.8",
}


def fetch(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def image_urls(html: str) -> list[str]:
    """Pull the full-size image URLs out of a Bing results fragment.

    The `/images/search` page is a JavaScript shell now — it contains no results
    at all, which is why parsing it yields nothing. The results come from
    `/images/async`, where each tile carries an `murl` (original) in an escaped
    JSON blob.
    """
    found: list[str] = []
    patterns = [
        r"murl&quot;:&quot;(.*?)&quot;",
        r'"murl":"(.*?)"',
        r"mediaurl=([^&\"]+)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, html):
            url = urllib.parse.unquote(match.group(1)).replace("\\/", "/")
            if url.startswith("http"):
                found.append(url)
    seen, unique = set(), []
    for url in found:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def search_url(query: str, first: int) -> str:
    return (
        "https://www.bing.com/images/async?q="
        + urllib.parse.quote(query)
        + f"&first={first}&count=35&mmasync=1"
    )


def looks_like_manga(data: bytes) -> tuple[bool, str]:
    try:
        from io import BytesIO

        from PIL import Image

        image = Image.open(BytesIO(data))
        width, height = image.size
    except Exception as error:
        return False, f"无法解码（{type(error).__name__}）"
    if width < 500 or height < 500:
        return False, f"太小 {width}x{height}"
    if width * height > 12_000_000:
        return False, f"太大 {width}x{height}"
    return True, f"{width}x{height}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", default="日漫生肉截图")
    parser.add_argument("--url", default="")
    parser.add_argument("--want", type=int, default=12)
    parser.add_argument("--out", default="testdata/real")
    parser.add_argument("--pages", type=int, default=3, help="search result pages to walk")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    candidates: list[str] = []
    for page in range(args.pages):
        url = args.url if args.url else search_url(args.query, page * 35 + 1)
        try:
            html = fetch(url).decode("utf-8", "ignore")
        except Exception as error:
            print(f"  搜索页 {page + 1} 取不到：{type(error).__name__} {error}")
            continue
        found = image_urls(html)
        print(f"  搜索页 {page + 1}: {len(found)} 个候选链接")
        candidates.extend(found)
        if args.url:
            break

    if not candidates:
        print("\n一个链接都没解析出来。Bing 可能返回了不同的页面结构。")
        return 1

    saved = []
    for url in candidates:
        if len(saved) >= args.want:
            break
        name = Path(urllib.parse.urlparse(url).path).name or "image"
        name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[-60:]
        target = out / name
        if target.is_file():
            continue
        try:
            data = fetch(url, timeout=40)
        except Exception as error:
            print(f"  --  {name[:40]} 下载失败 {type(error).__name__}")
            continue
        ok, note = looks_like_manga(data)
        if not ok:
            print(f"  --  {name[:40]} 跳过：{note}")
            continue
        target.write_bytes(data)
        saved.append(name)
        print(f"  ok  {name[:40]}  {note}  {len(data)//1024} KB")

    print(f"\n保存 {len(saved)} 张到 {out}")
    (out / "sources.json").write_text(
        json.dumps({"query": args.query, "url": args.url, "files": saved},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
