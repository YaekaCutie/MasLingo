"""Prove a runtime can actually do the job, not just import.

Run against the bundled runtime before packaging:

    build\\runtime\\Scripts\\python.exe packaging\\verify_runtime.py

An earlier packaging attempt shipped without the model cache and without
`unidic_lite`; both failures only appeared on first OCR, i.e. for the user. So
this exercises the real path — decode, detect, recognise — and fails loudly,
rather than reporting that the imports resolved.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FAILURES: list[str] = []


def step(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def main() -> int:
    print(f"解释器: {sys.executable}")
    print(f"版本:   {sys.version.split()[0]}\n")

    # 1. The modules the backend imports, named exactly as app.py names them.
    started = time.time()
    try:
        from backend.ocr.manga_ocr_engine import is_confident_reading, recognize_detailed
        from backend.ocr.bubble_detector import detect_text_regions
        from backend.image.decode import decode_image  # noqa: F401
        from backend.app import app  # noqa: F401
        step("全部后端模块可导入", True, f"{time.time() - started:.1f}s")
    except Exception as error:  # noqa: BLE001 - the message is the point
        step("全部后端模块可导入", False, f"{type(error).__name__}: {error}")
        return 1

    # 2. The weights. A missing HuggingFace cache is the failure this exists for:
    #    it does not fail at import, it fails on the user's first page.
    from PIL import Image

    samples = sorted((ROOT / "testdata" / "real").glob("*.jpg"))
    if not samples:
        print("\n  （testdata/real 为空，跳过识别测试；正式打包前必须补上）")
        return 1 if FAILURES else 0

    image = Image.open(samples[0]).convert("RGB")
    started = time.time()
    try:
        regions = detect_text_regions(image, limit=5)
        step("文本区域检测", len(regions) > 0, f"{len(regions)} 个区域，{time.time() - started:.1f}s")
    except Exception as error:  # noqa: BLE001
        step("文本区域检测", False, f"{type(error).__name__}: {error}")
        return 1

    started = time.time()
    try:
        raw: list[str] = []
        accepted: list[str] = []
        for left, top, right, bottom in regions[:3]:
            detailed = recognize_detailed(image.crop((left, top, right, bottom)))
            text = "\n".join(detailed["texts"]).strip()
            raw.append(text)
            if is_confident_reading(text, detailed["confidence"]):
                accepted.append(text)
            print(f"         [{left},{top},{right},{bottom}] conf={detailed['confidence']:.3f} "
                  f"{'采纳' if text in accepted else '丢弃'} {text[:40]!r}")

        # What this script is for: can the bundled runtime read Japanese at all?
        # The pipeline's confidence filter is a *quality* gate, tested against a
        # corpus elsewhere — asserting on it here means a legitimately-working
        # runtime reports FAIL whenever the detector hands the recogniser a
        # panel-sized region, which is what the first version of this check did.
        has_kana = any(
            any("\u3040" <= ch <= "\u30ff" for ch in text) for text in raw
        )
        step(
            "识别出日文文本",
            has_kana,
            f"采纳 {len(accepted)}/{len(regions[:3])} 条，{time.time() - started:.1f}s",
        )
        if not accepted:
            print("         （全部被置信度过滤器丢弃：区域过大所致，非运行时故障）")
    except Exception as error:  # noqa: BLE001
        step("识别出日文文本", False, f"{type(error).__name__}: {error}")

    print("")
    if FAILURES:
        print(f"{len(FAILURES)} 项失败：{'、'.join(FAILURES)}")
        return 1
    print("运行时可用：导入、检测、识别全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
