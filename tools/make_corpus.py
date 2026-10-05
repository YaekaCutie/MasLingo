"""Generate a manga-like test corpus with exact ground truth.

Why synthetic: measuring accuracy needs the correct answer for every region, and
a page crawled off a scan site has none. Reading the text off a screenshot and
transcribing it by hand gives a handful of samples and no coverage of the cases
that actually break — white-on-black lettering, text sitting on screentone,
small type, sound effects. Here the text, its box and its direction are known
exactly because this program put them there.

The pages are drawn to look like a real page: panel gutters, speech balloons,
screentone fills, hatching and shapes for the detector to be tempted by. That
matters — a corpus of clean text on blank paper would report a precision the
real thing never achieves.

Usage:
    python tools/make_corpus.py --out testdata/corpus --pages 12
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\meiryo.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

DIALOGUE = [
    "早く時間過ぎて～！",
    "気まずっ！！帰りたい",
    "アサちゃんはチェンソーマン好き？",
    "まあまあ．．．っていうか普通",
    "告白したの私じゃないのに",
    "そんなことより、聞いてくれ",
    "今日はもう帰ろうよ",
    "それって本当なの？",
    "私はずっと前から知ってた",
    "ちょっと待ってください",
    "なぜこんなことに",
    "ねえ、聞こえてる？",
]

NARRATION = [
    "その日、街は静かだった",
    "三日後のことである",
    "彼女は知らなかった",
    "すべてはここから始まった",
]

SOUND_EFFECTS = ["ドドド", "バキッ", "ザワザワ", "ゴゴゴ", "ヒュウウ"]


def font(size: int, bold: bool = False):
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size, index=1 if bold else 0)
            except Exception:
                return ImageFont.truetype(path, size)
    raise SystemExit("需要一款日文字体")


def text_size(draw, text: str, f) -> tuple[int, int]:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    return right - left, bottom - top


def weight_for(size: int) -> int:
    """Manga lettering is bold; MS Gothic at 16px is not.

    Rendering the corpus in a thin face made the detector look far worse than it
    is — thin 12-18px text is genuinely invisible to it, but real pages do not
    contain text like that.
    """
    return max(1, round(size / 14))


def draw_vertical(draw, text: str, right: int, top: int, f, rows: int,
                  fill=(20, 18, 16), line_gap=1.08, weight=1):
    """Right-to-left vertical text, the normal direction in manga.

    Characters stack *downward* and a new column starts to the left. Getting
    this wrong is easy and produces text that runs off the balloon entirely,
    which is what the first version of this generator did.
    """
    glyph = text_size(draw, "漢", f)[1]
    step = int(glyph * line_gap)
    for index, character in enumerate(text):
        column, row = divmod(index, rows)
        draw.text((right - column * step, top + row * step), character, font=f,
                  fill=fill, stroke_width=weight, stroke_fill=fill)
    columns = (len(text) + rows - 1) // rows
    return columns * step, min(len(text), rows) * step


def vertical_block_size(draw, text: str, f, rows: int) -> tuple[int, int]:
    glyph = text_size(draw, "漢", f)[1]
    step = int(glyph * 1.08)
    columns = (len(text) + rows - 1) // rows
    return columns * step, min(len(text), rows) * step


def screentone(size: tuple[int, int], spacing: int = 3, dot: int = 1, level: int = 120):
    """A halftone fill, rendered the way it survives print and downscaling.

    Drawn as crisp 2px black dots it is not a halftone at all — it is a black
    grid, and the detector correctly treats it as a solid block of ink. Real
    screentone reaches the screen as mid-grey texture, so it is blurred here and
    kept near the middle of the range. Getting this wrong made the corpus measure
    an artefact of its own generator rather than the pipeline.
    """
    from PIL import ImageFilter

    tile = Image.new("L", size, 255)
    pen = ImageDraw.Draw(tile)
    for y in range(0, size[1], spacing):
        for x in range(0, size[0], spacing):
            offset = (x + y) % spacing
            pen.ellipse((x + offset, y, x + offset + dot, y + dot), fill=level)
    return tile.filter(ImageFilter.GaussianBlur(0.7))


def make_page(index: int, width: int, height: int, rng: random.Random):
    page = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(page)
    truth = []

    # Panels, so the detector has real borders and gutters to cope with.
    margin, gutter = 24, 14
    columns, rows = 2, 3
    panel_w = (width - margin * 2 - gutter * (columns - 1)) // columns
    panel_h = (height - margin * 2 - gutter * (rows - 1)) // rows

    for row in range(rows):
        for column in range(columns):
            left = margin + column * (panel_w + gutter)
            top = margin + row * (panel_h + gutter)
            right, bottom = left + panel_w, top + panel_h
            draw.rectangle((left, top, right, bottom), outline=(30, 30, 30), width=2)
            # Screentone in some panels, hatching in others: both are things the
            # detector has to not mistake for text.
            if rng.random() < 0.45:
                tone = screentone((panel_w - 6, panel_h - 6), spacing=rng.choice([3, 4]),
                                  level=rng.choice([130, 150, 170]))
                page.paste(
                    Image.merge("RGB", (tone, tone, tone)),
                    (left + 3, top + 3),
                    Image.eval(tone, lambda value: 255 - value).convert("L"),
                )
            elif rng.random() < 0.4:
                for offset in range(0, panel_h, 9):
                    draw.line((left + 6, top + offset, right - 6, top + offset + 10),
                              fill=(200, 200, 200))
            # A shape or two, so regions have to survive non-text ink.
            for _ in range(rng.randint(0, 3)):
                x0 = rng.randint(left + 8, max(left + 9, right - 60))
                y0 = rng.randint(top + 8, max(top + 9, bottom - 60))
                draw.ellipse((x0, y0, x0 + rng.randint(20, 60), y0 + rng.randint(20, 60)),
                             outline=(40, 40, 40), width=2)

    slots = [(row, column) for row in range(rows) for column in range(columns)]
    rng.shuffle(slots)

    for row, column in slots[: rng.randint(3, 5)]:
        left = margin + column * (panel_w + gutter)
        top = margin + row * (panel_h + gutter)
        kind = rng.choice(["vertical", "vertical", "horizontal", "narration", "embedded"])
        text = rng.choice(NARRATION if kind == "narration" else DIALOGUE)
        size = rng.choice([16, 19, 22, 25])
        f = font(size)
        pad = 14

        if kind == "embedded":
            # Text sitting straight on the artwork, no balloon — the case the
            # user reported as "非气泡外嵌文字".
            rows_per_column = min(len(text), rng.randint(4, 7))
            block_w, block_h = vertical_block_size(draw, text, f, rows_per_column)
            x = left + rng.randint(12, max(13, panel_w - block_w - 12))
            y = top + rng.randint(12, max(13, panel_h - block_h - 12))
            draw_vertical(draw, text, x + block_w, y, f, rows_per_column,
                          weight=weight_for(size))
            truth.append({
                "text": text,
                "box": [x, y, x + block_w, y + block_h],
                "direction": "vertical", "kind": kind,
            })
            continue

        if kind == "horizontal":
            text_w, text_h = text_size(draw, text, f)
            box_w, box_h = text_w + pad * 2, text_h + pad * 2
            box = (
                left + rng.randint(10, max(11, panel_w - box_w - 10)),
                top + rng.randint(10, max(11, panel_h - box_h - 10)),
            )
            box = (box[0], box[1], box[0] + box_w, box[1] + box_h)
            draw.ellipse(box, fill="white", outline=(20, 20, 20), width=2)
            draw.text((box[0] + pad, box[1] + pad), text, font=f, fill=(20, 18, 16),
                        stroke_width=weight_for(size), stroke_fill=(20, 18, 16))
            truth.append({
                "text": text, "box": list(box),
                "direction": "horizontal", "kind": kind,
            })
            continue

        # Vertical dialogue in a balloon, or in a black narration box.
        rows_per_column = min(len(text), rng.randint(4, 8))
        block_w, block_h = vertical_block_size(draw, text, f, rows_per_column)
        box_w, box_h = block_w + pad * 2, block_h + pad * 2
        if box_w > panel_w - 16 or box_h > panel_h - 16:
            continue
        x = left + rng.randint(8, max(9, panel_w - box_w - 8))
        y = top + rng.randint(8, max(9, panel_h - box_h - 8))
        box = (x, y, x + box_w, y + box_h)

        black = kind == "narration"
        if black:
            draw.rectangle(box, fill=(18, 18, 18), outline=(20, 20, 20), width=2)
        else:
            draw.ellipse(box, fill="white", outline=(20, 20, 20), width=2)
        draw_vertical(
            draw, text, box[2] - pad, box[1] + pad, f, rows_per_column,
            fill=(250, 248, 244) if black else (20, 18, 16),
            weight=weight_for(size),
        )
        truth.append({
            "text": text, "box": list(box),
            "direction": "vertical",
            "kind": "narration" if black else "vertical",
        })

    # A sound effect, drawn huge and often on top of artwork.
    if rng.random() < 0.6:
        effect = rng.choice(SOUND_EFFECTS)
        f = font(rng.choice([34, 42]))
        x = rng.randint(margin + 20, width - 200)
        y = rng.randint(margin + 30, height - 160)
        draw.text((x, y), effect, font=f, fill=(25, 25, 25),
                  stroke_width=weight_for(size), stroke_fill=(25, 25, 25))
        truth.append({
            "text": effect,
            "box": [x, y, x + text_size(draw, effect, f)[0], y + text_size(draw, effect, f)[1]],
            "direction": "horizontal",
            "kind": "sfx",
        })

    # A page number in a corner: small, and correctly hard to read.
    draw.text((width - 60, height - 40), str(index + 1), font=font(18), fill=(60, 60, 60))

    return page, truth


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="testdata/corpus")
    parser.add_argument("--pages", type=int, default=12)
    parser.add_argument("--width", type=int, default=760)
    parser.add_argument("--height", type=int, default=1100)
    parser.add_argument("--seed", type=int, default=20261005)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)

    corpus = []
    for index in range(args.pages):
        page, truth = make_page(index, args.width, args.height, rng)
        name = f"page{index + 1:02d}.png"
        page.save(out / name)
        corpus.append({"image": name, "width": args.width, "height": args.height, "regions": truth})
        print(f"  {name}  {len(truth)} 处文字")

    (out / "ground_truth.json").write_text(
        json.dumps(corpus, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    total = sum(len(page["regions"]) for page in corpus)
    print(f"\n{args.pages} 页，共 {total} 处文字，标准答案写入 {out / 'ground_truth.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
