#!/usr/bin/env python3
"""Parity test: does the community ONNX export of manga-ocr reproduce it exactly?

This is the evidence behind docs/BROWSER_OCR_FEASIBILITY.md. It was used to
prove that on-device (browser) OCR is viable, which removes the need for any
server — and therefore any cloud account or credit card.

It runs the ONNX encoder/decoder by hand rather than through transformers.js,
so preprocessing and tokenizer are exactly the ones manga-ocr itself uses.
That isolates the two things a naive transformers.js call gets wrong:

  * preprocessing — manga-ocr converts to grayscale first: convert("L").convert("RGB"),
    then the ViT processor resizes to 224x224 and normalises with mean/std 0.5;
  * tokenizer — the decoder uses a character-level Japanese vocab (6144 entries).
    transformers.js cannot reproduce it in a browser because the upstream
    BertJapaneseTokenizer needs MeCab.

Usage:
    python tools/onnx_parity_test.py --work DIR --model-dir SNAPSHOT [--ortlib DIR]

Expects --work to contain the crops as <name>.png plus a baseline.json of
{"<name>": {"text": ...}} produced by the current PyTorch pipeline. See
docs/BROWSER_OCR_FEASIBILITY.md for how those are generated.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, help="dir with <name>.png crops, onnx/ and baseline.json")
    parser.add_argument("--model-dir", required=True, help="local manga-ocr snapshot (config + vocab.txt)")
    parser.add_argument("--ortlib", default=None, help="dir where onnxruntime was pip --target installed")
    parser.add_argument("--max-length", type=int, default=300)
    args = parser.parse_args()

    work = Path(args.work)
    if args.ortlib:
        sys.path.insert(0, args.ortlib)
    # allow `from backend...` when run from the repo root
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from transformers import AutoTokenizer, ViTImageProcessor

    from backend.ocr.manga_ocr_engine import _prepare_image
    from manga_ocr.ocr import post_process

    encoder = ort.InferenceSession(str(work / "onnx" / "encoder.onnx"), providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(str(work / "onnx" / "decoder.onnx"), providers=["CPUExecutionProvider"])
    print("encoder inputs :", [(i.name, i.shape) for i in encoder.get_inputs()])
    print("decoder inputs :", [(i.name, i.shape) for i in decoder.get_inputs()])

    processor = ViTImageProcessor.from_pretrained(args.model_dir)
    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, tokenizer_type="bert-japanese")
    print("vocab size     :", tokenizer.vocab_size)

    def greedy(pixel_values) -> list[int]:
        encoder_hidden = encoder.run(None, {"pixel_values": pixel_values})[0]
        ids = [2]  # decoder_start_token_id
        for _ in range(args.max_length):
            logits = decoder.run(
                None,
                {"input_ids": np.array([ids], dtype=np.int64), "encoder_hidden_states": encoder_hidden},
            )[0]
            next_id = int(np.argmax(logits[0, -1]))
            if next_id == 3:  # eos
                break
            ids.append(next_id)
        return ids

    baseline = json.loads((work / "baseline.json").read_text(encoding="utf-8"))
    matches = 0
    total = 0
    for name, expected in baseline.items():
        crop = Image.open(work / f"{name}.png")
        for label, image in {"raw": crop, "_prepare_image": _prepare_image(crop)}.items():
            prepared = image.convert("L").convert("RGB")
            pixels = processor(prepared, return_tensors="np").pixel_values.astype(np.float32)
            started = time.perf_counter()
            ids = greedy(pixels)
            elapsed = time.perf_counter() - started
            text = post_process(tokenizer.decode(ids, skip_special_tokens=True))
            match = text.strip() == expected["text"].strip()
            matches += int(match)
            total += 1
            print(f"{name:9s} [{label:16s}] {elapsed:5.2f}s match={match}")
            print(f"    onnx    : {text}")
            print(f"    pytorch : {expected['text']}")
    print(f"\nexact match: {matches}/{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
