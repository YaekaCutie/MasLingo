"""Compare attempted inpainting and preserve-artwork policy on known backgrounds.

These are synthetic samples, not the user's uploaded manga images. The exact
glyph mask isolates repair safety from detector accuracy. No translator/key is used.
"""
import argparse
import base64
from io import BytesIO
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.image.erase import make_erase_patch


def evaluate(out):
    out.mkdir(parents=True, exist_ok=True)
    candidates = [r"C:\Windows\Fonts\YuGothB.ttc",r"C:\Windows\Fonts\msgothic.ttc",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]
    font_path = next((path for path in candidates if Path(path).is_file()),None)
    if not font_path:
        raise RuntimeError("A Japanese font is required for the synthetic samples.")
    font = ImageFont.truetype(font_path,36)
    rows = []
    for name in ["flat-colour","purple-hatching","screentone","line-art"]:
        clean = Image.new("RGB",(480,360),(171,74,133) if name!="screentone" else (250,250,250))
        draw = ImageDraw.Draw(clean)
        if name=="purple-hatching":
            for x in range(-200,700,8): draw.line((x,0,x+150,359),fill=(115,40,100),width=2)
        elif name=="screentone":
            for x in range(0,480,6):
                for y in range(0,360,6): draw.ellipse((x,y,x+2,y+2),fill=(100,100,100))
        elif name=="line-art":
            draw.rectangle((0,0,479,359),fill=(225,225,225))
            for x in range(-200,700,8): draw.line((x,0,x+140,359),fill=(35,35,35),width=2)
            draw.line((20,80,450,300),fill=(20,20,20),width=5)
        glyphs = Image.new("RGBA",clean.size)
        ImageDraw.Draw(glyphs).text((115,138),"思い出した",font=font,fill=(20,20,20,255),
                                    stroke_width=2,stroke_fill=(252,252,252,255))
        bounds = glyphs.getbbox()
        box = (bounds[0]-10,bounds[1]-10,bounds[2]+10,bounds[3]+10)
        source = Image.alpha_composite(clean.convert("RGBA"),glyphs).convert("RGB")
        probability = np.asarray(glyphs)[:,:,3].astype(np.float32)/255
        attempted = make_erase_patch(source,box,probability,preserve_artwork=False)
        selected = make_erase_patch(source,box,probability)
        repair = source.convert("RGBA")
        tile = Image.open(BytesIO(base64.b64decode(attempted["image"].split(",")[1])))
        repair.alpha_composite(tile,(attempted["rect"]["left"],attempted["rect"]["top"]))
        source.save(out/f"{name}-source.png");clean.save(out/f"{name}-clean.png")
        repair.convert("RGB").save(out/f"{name}-attempt.png")
        error = np.abs(np.asarray(repair.convert("RGB")).astype(np.float32)-np.asarray(clean))
        row={"case":name,"mode":"inline" if selected["safe"] else "adjacent",
             "safe":selected["safe"],"quality":selected["quality"],"box":box,
             "attempted_hidden_background_mae":round(float(error[probability>0].mean()),3)}
        rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    (out/"metrics.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",type=Path,default=Path("testdata/repair-policy"))
    evaluate(parser.parse_args().out)
