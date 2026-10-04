"""Fetch the on-device OCR assets into the extension.

The browser needs two things that are too large (and too binary) to keep in git:

  extension/vendor/ort/   onnxruntime-web's wasm runtime  (~14 MB, *code*)
  extension/models/       the int8 ONNX model              (~111 MB, *data*)

Both are pinned here so a build is reproducible. The distinction matters for
Chrome Web Store policy: the wasm runtime is code and must ship inside the
package (never loaded from a CDN), while the model weights are data.

Usage:
    python tools/fetch_ocr_assets.py            # both
    python tools/fetch_ocr_assets.py --ort      # runtime only (small, for dev)
    python tools/fetch_ocr_assets.py --model    # weights only
"""

from __future__ import annotations

import argparse
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

# Pinned so the extension behaves the same every build.
ONNXRUNTIME_WEB_VERSION = "1.30.0"
ORT_FILES = ["ort.wasm.min.js", "ort-wasm-simd-threaded.wasm"]
NPM_TARBALL = (
    f"https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-{ONNXRUNTIME_WEB_VERSION}.tgz"
)

# kimchireader/manga-ocr-onnx-q8 is the int8 export that was verified to
# reproduce the server pipeline; see docs/BROWSER_OCR_FEASIBILITY.md.
MODEL_REPO = "kimchireader/manga-ocr-onnx-q8"
MODEL_REVISION = "main"
MODEL_FILES = {
    "onnx/encoder_model_quantized.onnx": "encoder.onnx",
    "onnx/decoder_model_quantized.onnx": "decoder.onnx",
}
# The decoder in this repo is the non-merged variant: the merged one exists but
# is only needed by transformers.js, which this project deliberately avoids.

REPO_ROOT = Path(__file__).resolve().parent.parent
ORT_DIR = REPO_ROOT / "extension" / "vendor" / "ort"
MODEL_DIR = REPO_ROOT / "extension" / "models"


def download(url: str, timeout: int = 120) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "openmanga-translator-build"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_ort() -> None:
    ORT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"onnxruntime-web {ONNXRUNTIME_WEB_VERSION}")
    archive = download(NPM_TARBALL, timeout=300)
    print(f"  downloaded {len(archive) / 1e6:.1f} MB tarball")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar.getmembers():
            name = member.name.rsplit("/", 1)[-1]
            if name not in ORT_FILES:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            target = ORT_DIR / name
            target.write_bytes(handle.read())
            print(f"  {name}: {target.stat().st_size / 1e6:.2f} MB")


def fetch_model() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for remote, local in MODEL_FILES.items():
        url = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{remote}"
        target = MODEL_DIR / local
        if target.exists() and target.stat().st_size > 0:
            print(f"{local}: already present ({target.stat().st_size / 1e6:.2f} MB), skipping")
            continue
        print(f"{local} <- {url}")
        data = download(url, timeout=900)
        target.write_bytes(data)
        print(f"  wrote {target.stat().st_size / 1e6:.2f} MB")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ort", action="store_true", help="fetch only the wasm runtime")
    parser.add_argument("--model", action="store_true", help="fetch only the model weights")
    args = parser.parse_args()

    want_ort = args.ort or not (args.ort or args.model)
    want_model = args.model or not (args.ort or args.model)

    if want_ort:
        fetch_ort()
    if want_model:
        fetch_model()

    total = sum(f.stat().st_size for f in list(ORT_DIR.glob("*")) + list(MODEL_DIR.glob("*")) if f.is_file())
    print(f"\ntotal on-device assets: {total / 1e6:.1f} MB")
    print("both directories are gitignored; rerun this after a clean clone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
