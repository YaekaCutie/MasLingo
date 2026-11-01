"""Run the real OCR HTTP API on local manga pages and save inspectable evidence.

No translation service or API key is used. Originals stay outside the repository.
Example: python tools/evaluate_manga_pages.py page.jpg --out /tmp/manga-review
"""
import argparse
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import time
import urllib.request
import uuid

from PIL import Image, ImageDraw


def evaluate(paths, backend, out):
    out.mkdir(parents=True, exist_ok=True)
    results = []
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(backend.rstrip("/") + "/health", timeout=10) as response:
        json.load(response)
    for path in paths:
        data = path.read_bytes()
        source = Image.open(BytesIO(data)).convert("RGB")
        folder = out / path.stem
        folder.mkdir(exist_ok=True)
        started = time.perf_counter()
        boundary = uuid.uuid4().hex
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="page.jpg"\r\n'
                  'Content-Type: application/octet-stream\r\n\r\n').encode()
        body = prefix + data + f'\r\n--{boundary}--\r\n'.encode()
        request = urllib.request.Request(backend.rstrip("/") + "/api/recognize-page",data=body,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with client.open(request,timeout=600) as response:
            payload = json.load(response)
        if not payload.get("ok"):
            raise RuntimeError(f"OCR failed for {path.name}: {payload.get('error')}")
        (folder / "response.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        marked = source.copy()
        pen = ImageDraw.Draw(marked)
        repaired = source.convert("RGBA")
        readings = []
        for index, item in enumerate(payload["items"], 1):
            box = tuple(item["bbox"][key] for key in ("left", "top", "right", "bottom"))
            patch = item.get("erase") or {}
            inline = bool(patch.get("image") and patch.get("safe", True))
            pen.rectangle(box, outline="#00a058" if inline else "#ef8b00", width=2)
            pen.text((box[0], max(0, box[1]-12)), str(index), fill="#004cff", stroke_width=1, stroke_fill="white")
            source.crop(box).save(folder / f"crop-{index:02}.png")
            if inline:
                layer = Image.open(BytesIO(base64.b64decode(patch["image"].split(",", 1)[1])))
                repaired.alpha_composite(layer, (patch["rect"]["left"], patch["rect"]["top"]))
            readings.append({"index": index, "text": item["text"], "bbox": item["bbox"],
                             "confidence": item.get("confidence"), "mode": "inline" if inline else "preserved",
                             "quality": patch.get("quality")})
        marked.save(folder / "boxes.png")
        repaired.convert("RGB").save(folder / "erased.png")
        result = {"file": path.name, "sha256": hashlib.sha256(data).hexdigest(), "size": list(source.size),
                  "seconds": round(time.perf_counter()-started, 2), "items": readings}
        (folder / "readings.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--backend", default="http://127.0.0.1:8001")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    evaluate(args.images, args.backend, args.out)
