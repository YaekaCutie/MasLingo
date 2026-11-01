"""Reproducible dialogue fixtures: colour, embedded text, vertical, and borders.

Run: python tools/evaluate_text_pipeline.py --out /tmp/maslingo-evaluation
Downloads the pinned detector through its normal local model cache on first use.
"""
import argparse
import base64
from io import BytesIO
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.ocr.bubble_detector import detect_text_regions as heuristic
from backend.ocr.text_detector import detect_text_regions
from backend.image.erase import make_erase_patch
from backend.ocr.manga_ocr_engine import recognize_detailed


def font(size):
    candidates = [r"C:\Windows\Fonts\YuGothB.ttc", r"C:\Windows\Fonts\msgothic.ttc",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
                  "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"]
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise RuntimeError("Install a Japanese font for the evaluation fixtures.")


def fixtures():
    for name, background, foreground, bubble, vertical, outlined in [
        ("white-bubble", (255, 255, 255), (20, 20, 20), True, False, False),
        ("coloured-bubble", (246, 213, 145), (77, 32, 82), True, False, False),
        ("equal-luminance-colour", (210, 145, 90), (80, 195, 170), False, False, False),
        ("embedded-gradient", None, (20, 20, 20), False, False, True),
        ("light-on-dark", (28, 40, 68), (246, 246, 246), False, False, False),
        ("vertical-colour", (231, 190, 211), (48, 28, 58), False, True, False),
    ]:
        clean = Image.new("RGB", (640, 880), background or (120, 140, 170))
        if background is None:
            array = np.asarray(clean).copy()
            for y in range(clean.height):
                array[y, :, :] = (120 + y//12, 140 + y//15, 170 + y//20)
            clean = Image.fromarray(array)
        pen = ImageDraw.Draw(clean)
        # An outline and illustration strokes close to the text must survive.
        if bubble:
            pen.rounded_rectangle((55, 290, 585, 550), radius=70,
                                  fill=background, outline=(15, 15, 15), width=4)
        pen.line((85, 625, 555, 650), fill=(15, 15, 15), width=5)
        pen.ellipse((100, 80, 230, 250), outline=(45, 55, 65), width=6)
        overlay = Image.new("RGBA", clean.size)
        text_pen = ImageDraw.Draw(overlay)
        text = "今日はいい天気ですね。"
        f = font(36)
        if vertical:
            for index, character in enumerate(text):
                column, row = divmod(index, 6)
                text_pen.text((385-column*48, 290+row*43), character, font=f, fill=(*foreground,255))
        else:
            text_pen.text((110, 395), text, font=f, fill=(*foreground,255),
                stroke_width=2 if outlined else 0, stroke_fill=(250,250,250,255))
        source = Image.alpha_composite(clean.convert("RGBA"), overlay).convert("RGB")
        yield name, clean, source, np.asarray(overlay)[:, :, 3], text


def coverage(box, truth):
    left, top, right, bottom = box
    return float(truth[top:bottom, left:right].sum()) / max(1, float(truth.sum()))


def evaluate(out, with_ocr=True):
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, clean, source, truth, expected in fixtures():
        source.save(out / f"{name}-source.png")
        regions = detect_text_regions(source)
        old = heuristic(source)
        result = source.copy().convert("RGBA")
        overlay = source.copy()
        pen = ImageDraw.Draw(overlay)
        readings = []
        best = max(regions, key=lambda box: coverage(box, truth), default=None)
        # Repair only the dialogue region being evaluated, as the OCR route
        # does after filtering a candidate's reading.
        if best:
            pen.rectangle(best, outline="red", width=2)
            patch = make_erase_patch(source, best, regions.mask)
            if patch and patch.get("image"):
                tile = Image.open(BytesIO(base64.b64decode(patch["image"].split(",")[1])))
                result.alpha_composite(tile, (patch["rect"]["left"], patch["rect"]["top"]))
            if with_ocr:
                readings = recognize_detailed(source.crop(best))["texts"]
        result.convert("RGB").save(out / f"{name}-erased.png")
        overlay.save(out / f"{name}-detected.png")
        residual = np.max(np.abs(np.asarray(result.convert("RGB")).astype(float) - np.asarray(clean)), axis=2)
        # Permit a 2px antialias fringe in the repair mask when measuring damage.
        fringe = np.asarray(Image.fromarray(truth).filter(ImageFilter.MaxFilter(5))) > 0
        row = {"case": name, "expected": expected, "readings": readings,
            "old_coverage": round(max((coverage(b, truth) for b in old), default=0), 4),
            "new_coverage": round(coverage(best, truth) if best else 0, 4),
            "text_residual_mae": round(float(residual[truth>0].mean()), 3),
            "changed_background_pixels": int(np.count_nonzero((residual>3) & ~fringe)),
            "boxes": regions}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (out / "metrics.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("testdata/text-pipeline"))
    parser.add_argument("--no-ocr", action="store_true")
    args = parser.parse_args()
    evaluate(args.out, not args.no_ocr)
