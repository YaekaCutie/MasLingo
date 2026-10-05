"""Send one real page to the running backend and print what comes back.

Used to confirm the backend is actually serving the model, not just answering
/health — a health check passes even when OCR is broken.
"""

import json
import sys
import time
import urllib.request

BACKEND = "http://127.0.0.1:8001"


def post(path, filepath):
    boundary = "----omt"
    data = open(filepath, "rb").read()
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; '
        f'filename="page.png"\r\nContent-Type: image/png\r\n\r\n'
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        BACKEND + path,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.loads(urllib.request.urlopen(request, timeout=900).read().decode())


def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else "4b41-a54f6b467963479d1a5552c315c8b31f.jpg"
    started = time.time()
    payload = post("/api/recognize-page", filepath)
    items = payload.get("items", [])
    print(f"耗时 {time.time() - started:.1f}s，返回 {len(items)} 条：")
    for item in items:
        confidence = item.get("confidence")
        shown = f"{confidence:.3f}" if isinstance(confidence, (int, float)) else "—"
        print(f"  conf={shown}  dir={str(item.get('direction')):10} {item['text']}")


if __name__ == "__main__":
    main()
