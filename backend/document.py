"""Translate the text in Word packages while keeping the original document parts."""

import json
import re
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from lxml import etree
from starlette.concurrency import run_in_threadpool
from .document_common import MAX_FILE_BYTES, PARSE_ERRORS, SPACE, TextMap, open_package, write_package, xml, xml_bytes

router = APIRouter(prefix="/api/document")
MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PART = re.compile(r"word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml")
NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def w(name):
    return f"{{{NS}}}{name}"


@dataclass
class TextGroup:
    nodes: list = field(default_factory=list)
    properties: object = None
    link: object = None

    @property
    def text(self):
        return "".join(node.text or "" for node in self.nodes)


def paragraphs(root):
    """Group adjacent runs only when they share formatting and link targets."""
    field_depth = 0
    for paragraph in root.iter(w("p")):
        groups = []
        active = None
        previous_style = None
        for child in paragraph:
            link = child if child.tag == w("hyperlink") else None
            runs = link if link is not None else (child,)
            for run in runs:
                if run.tag != w("r"):
                    active = None
                    continue
                properties = run.find(w("rPr"))
                style = etree.tostring(properties, with_tail=False) if properties is not None else None
                for element in run:
                    if element.tag == w("rPr"):
                        continue
                    if element.tag == w("fldChar"):
                        kind = element.get(w("fldCharType"))
                        if kind == "begin":
                            field_depth += 1
                        elif kind == "end":
                            field_depth = max(0, field_depth - 1)
                    if field_depth or element.tag != w("t"):
                        active = None
                        if not field_depth and (element.tag in (w("tab"), w("cr")) or
                                (element.tag == w("br") and element.get(w("type"), "textWrapping") == "textWrapping")):
                            groups.append(element)
                        continue
                    if active is None or active.link is not link or style != previous_style:
                        active = TextGroup(properties=properties, link=link)
                        groups.append(active)
                        previous_style = style
                    active.nodes.append(element)
        yield paragraph, groups


def set_text(node, text):
    node.text = text
    if text != text.strip():
        node.set(SPACE, "preserve")


def add_line(paragraph, pairs):
    etree.SubElement(etree.SubElement(paragraph, w("r")), w("br"))
    for group, text in pairs:
        if isinstance(group, TextGroup):
            parent = paragraph
            if group.link is not None:
                parent = etree.SubElement(paragraph, w("hyperlink"), attrib=dict(group.link.attrib))
            run = etree.SubElement(parent, w("r"))
            if group.properties is not None:
                run.append(deepcopy(group.properties))
            set_text(etree.SubElement(run, w("t")), text)
        else:
            etree.SubElement(paragraph, w("r")).append(deepcopy(group))


def process(data, translations=None, mode=None):
    try:
        with open_package(data) as source:
            types = xml(source.read("[Content_Types].xml"))
            if "word/document.xml" not in source.namelist() or not any(
                part.get("PartName") == "/word/document.xml" and part.get("ContentType") == MIME + ".main+xml"
                for part in types
            ):
                raise HTTPException(422, "请选择 Word .docx 文档")
            mapping = TextMap(translations)
            changed_parts = {}
            for item in source.infolist():
                if not PART.fullmatch(item.filename):
                    continue
                root = xml(source.read(item))
                if item.filename == "word/document.xml" and root.tag != w("document"):
                    raise HTTPException(422, "不支持该 Word 文档的 XML 格式")
                changed = False
                for paragraph, groups in paragraphs(root):
                    pairs = []
                    changed_paragraph = False
                    for group in groups:
                        if not isinstance(group, TextGroup):
                            pairs.append((group, None))
                            continue
                        original = group.text
                        result = mapping.apply(original)
                        pairs.append((group, result))
                        if result != original:
                            changed_paragraph = True
                            if mode == "translated":
                                set_text(group.nodes[0], result)
                                for node in group.nodes[1:]:
                                    node.text = ""
                    if changed_paragraph and mode == "bilingual":
                        add_line(paragraph, pairs)
                    changed |= changed_paragraph
                if changed:
                    changed_parts[item.filename] = xml_bytes(root)
            if translations is None:
                return {"texts": mapping.texts}
            mapping.validate()
            return write_package(source, changed_parts)
    except PARSE_ERRORS as error:
        raise HTTPException(422, "无法读取该 Word .docx 文档") from error


async def read_document(file):
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "文档不能超过 15 MB")
    return data


def dispatch(data, suffix, translations=None, mode=None):
    if suffix == ".docx":
        return process(data, translations, mode), MIME
    from .document_formats import process_format
    return process_format(data, suffix, translations, mode)


@router.post("/text")
async def document_text(file: UploadFile = File(...)):
    output, _ = await run_in_threadpool(dispatch, await read_document(file), Path(file.filename or "").suffix.lower())
    return output


@router.post("/export")
async def document_export(file: UploadFile = File(...), texts: str = Form(...), mode: str = Form(...)):
    try:
        translations = json.loads(texts)
    except ValueError as error:
        raise HTTPException(422, "无法读取译文") from error
    if (mode not in ("bilingual", "translated") or not isinstance(translations, list) or
            len(translations) > 2500 or any(not isinstance(text, str) or not text.strip() for text in translations)):
        raise HTTPException(422, "译文或文档导出方式无效")
    data, mime = await run_in_threadpool(
        dispatch, await read_document(file), Path(file.filename or "").suffix.lower(), translations, mode,
    )
    return Response(data, media_type=mime)
