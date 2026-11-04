"""Read digital and scanned PDF pages and export readable translated PDF pages."""

import io
import os
import re
from functools import lru_cache
from pathlib import Path
from threading import Lock
from xml.sax.saxutils import escape

from fastapi import HTTPException
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont, TTFError
from reportlab.platypus import Paragraph, SimpleDocTemplate

OCR_LOCK = Lock()
MIN_TEXT_LAYER_LETTERS = 120
SCAN_IMAGE_COVERAGE = 0.60
MAX_SCAN_PAGES = 30


@lru_cache(maxsize=1)
def ocr():
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as error:
        raise HTTPException(503, "扫描版 PDF 需要安装后端 PDF OCR 依赖") from error
    return RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)


def has_page_scan(page, image_type, form_type):
    left, bottom, right, top = page.get_bbox()
    min_area = (right - left) * (top - bottom) * SCAN_IMAGE_COVERAGE
    covers_page = False
    for obj in page.get_objects(filter=[image_type, form_type]):
        if obj.level == 0:
            # Root forms include their transform. A nested image's raw bounds
            # can be much larger than the area it actually covers on the page.
            bounds = getattr(obj, "get_bounds", None) or obj.get_pos
            x0, y0, x1, y1 = bounds()
            width = max(0, min(right, x1) - max(left, x0))
            height = max(0, min(top, y1) - max(bottom, y0))
            covers_page = width * height >= min_area
        if covers_page and obj.type == image_type:
            return True
    return False


def scanned_lines(data, index, *, require_page_image=False, limit_reached=False):
    import numpy as np
    import pypdfium2
    from pypdfium2 import PdfiumError
    from pypdfium2.raw import FPDF_PAGEOBJ_FORM, FPDF_PAGEOBJ_IMAGE

    # PDFium and the OCR model share a slot to keep concurrent scans bounded.
    with OCR_LOCK:
        try:
            with pypdfium2.PdfDocument(data) as pdf:
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    if not min(width, height) or min(width, height) < 0:
                        raise HTTPException(422, "PDF 页面尺寸无效")
                    if require_page_image and not has_page_scan(page, FPDF_PAGEOBJ_IMAGE, FPDF_PAGEOBJ_FORM):
                        return None
                    if limit_reached:
                        raise HTTPException(413, f"单个 PDF 最多识别 {MAX_SCAN_PAGES} 张扫描页")
                    bitmap = page.render(scale=min(2.4, 1900 / max(width, height)))
                    try:
                        image = np.asarray(bitmap.to_pil().convert("RGB"))[:, :, ::-1].copy()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        except PdfiumError as error:
            raise HTTPException(422, "无法读取扫描版 PDF 页面") from error
        result, _ = ocr()(image)
        return [line[1] for line in (result or []) if line[1].strip()]


@lru_cache(maxsize=4)
def font(name):
    pdfmetrics.registerFont(UnicodeCIDFont(name))
    return name


@lru_cache(maxsize=7)
def unicode_font(script):
    windows = Path(os.getenv("WINDIR", "C:/Windows")) / "Fonts"
    noto = Path("/usr/share/fonts/truetype/noto")
    candidates = {
        "Arabic": [noto / "NotoSansArabic-Regular.ttf", windows / "arial.ttf"],
        "Devanagari": [noto / "NotoSansDevanagari-Regular.ttf", windows / "Nirmala.ttc"],
        "Thai": [noto / "NotoSansThai-Regular.ttf", windows / "tahoma.ttf"],
        "Chinese": [windows / "msyh.ttc", windows / "simsun.ttc"],
        "Japanese": [windows / "msgothic.ttc"],
        "Korean": [windows / "malgun.ttf"],
        "Latin": [noto / "NotoSans-Regular.ttf", windows / "arial.ttf",
                  Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")],
    }
    for path in candidates[script]:
        if path.is_file():
            name = "MasLingo" + script
            try:
                pdfmetrics.registerFont(TTFont(name, str(path)))
                return name
            except TTFError:
                continue
    return ""


def page_style(text):
    if re.search(r"[\u3040-\u30ff]", text):
        return unicode_font("Japanese") or font("HeiseiMin-W3"), "CJK"
    if re.search(r"[\uac00-\ud7af]", text):
        return unicode_font("Korean") or font("HYSMyeongJo-Medium"), "CJK"
    if re.search(r"[\u3400-\u9fff]", text):
        return unicode_font("Chinese") or font("STSong-Light"), "CJK"
    if re.search(r"[\u0600-\u06ff]", text):
        script, wrap = "Arabic", "RTL"
    elif re.search(r"[\u0900-\u097f]", text):
        script, wrap = "Devanagari", None
    elif re.search(r"[\u0e00-\u0e7f]", text):
        script, wrap = "Thai", None
    elif any(ord(char) > 255 for char in text):
        script, wrap = "Latin", None
    else:
        return "Helvetica", None
    face = unicode_font(script)
    if not face:
        raise HTTPException(503, "后端缺少 PDF 目标语言字体，请安装 Noto 字体")
    return face, wrap


def translated_page(lines):
    output = io.BytesIO()
    text = "\n".join(lines)
    face, wrap = page_style(text)
    body = ParagraphStyle("body", fontName=face, fontSize=11, leading=17, spaceAfter=5,
                          wordWrap=wrap, shaping=True, alignment=2 if wrap == "RTL" else 0)
    flow = [Paragraph(escape(line).replace("\n", "<br/>"), body) for line in lines if line.strip()]
    SimpleDocTemplate(output, pagesize=A4, title="MasLingo Translation").build(flow)
    return PdfReader(io.BytesIO(output.getvalue()))


def process_pdf(data, mapping, mode):
    try:
        source = PdfReader(io.BytesIO(data))
        if source.is_encrypted and not source.decrypt(""):
            raise HTTPException(422, "此 PDF 需要打开密码，请先解锁 PDF 再翻译")
        if len(source.pages) > 150:
            raise HTTPException(413, "PDF 不能超过 150 页")
        target = PdfWriter() if mapping.translations is not None else None
        scanned = 0
        for index, page in enumerate(source.pages):
            original = (page.extract_text() or "").strip()
            lines = [line for line in original.splitlines() if line.strip()]
            letters = sum(char.isalpha() for char in original)
            if letters < MIN_TEXT_LAYER_LETTERS and len(page.images):
                recognized = scanned_lines(data, index, require_page_image=bool(letters),
                                           limit_reached=scanned >= MAX_SCAN_PAGES)
                if recognized is not None:
                    scanned += 1
                    if recognized and (not letters or
                                       sum(char.isalpha() for line in recognized for char in line) > letters):
                        lines = recognized
            translated = [mapping.apply(line) for line in lines]
            if target is not None:
                if mode == "bilingual":
                    target.add_page(page)
                if lines:
                    for translated_part in translated_page(translated).pages:
                        target.add_page(translated_part)
        if target is None:
            return None
        output = io.BytesIO()
        target.write(output)
        return output.getvalue()
    except (PdfReadError, KeyError, ValueError) as error:
        raise HTTPException(422, "无法读取该 PDF 文档") from error
