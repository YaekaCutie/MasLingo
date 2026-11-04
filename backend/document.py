"""Translate the text in Word packages while keeping the original document parts."""

import io
import json
import re
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from lxml import etree
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api/document")
MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_EXPANDED_BYTES = 80 * 1024 * 1024
PART = re.compile(r"word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml")
NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SPACE = "{http://www.w3.org/XML/1998/namespace}space"


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


def xml(data):
    root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    if root.getroottree().docinfo.doctype:
        raise HTTPException(422, "Word 文档包含不支持的 XML 声明")
    return root


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


def split_text(text):
    """Split long runs into bounded requests and keep the split whitespace."""
    while len(text) > 1000:
        window = text[:1000]
        cut = max(window.rfind(" ", 500), window.rfind("。", 500) + 1,
                  window.rfind("！", 500) + 1, window.rfind("？", 500) + 1)
        cut = cut if cut >= 500 else 1000
        chunk = text[:cut]
        remainder = text[cut:]
        text = remainder.lstrip()
        yield chunk.strip(), remainder[:len(remainder) - len(text)]
    if text:
        yield text, ""


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
        with ZipFile(io.BytesIO(data)) as source:
            items = source.infolist()
            names = set(source.namelist())
            if len(items) > 2000 or sum(item.file_size for item in items) > MAX_EXPANDED_BYTES:
                raise HTTPException(413, "Word 文档内部资源过大")
            if len(names) != len(items) or any(
                item.flag_bits & 1 or "\\" in item.filename or item.filename.startswith("/") or
                ".." in PurePosixPath(item.filename).parts or item.filename.startswith("_xmlsignatures/")
                for item in items
            ):
                raise HTTPException(422, "不支持加密、签名或结构异常的 Word 文档")
            types = xml(source.read("[Content_Types].xml"))
            if "word/document.xml" not in names or not any(
                part.get("PartName") == "/word/document.xml" and part.get("ContentType") == MIME + ".main+xml"
                for part in types
            ):
                raise HTTPException(422, "请选择 Word .docx 文档")
            texts = []
            changed_parts = {}
            total_chars = 0
            for item in items:
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
                        trimmed = original.strip()
                        result = original
                        if trimmed and any(char.isalpha() for char in trimmed):
                            pieces = []
                            for text, separator in split_text(trimmed):
                                index = len(texts)
                                texts.append(text)
                                total_chars += len(text)
                                if len(texts) > 2500 or total_chars > 200000:
                                    raise HTTPException(413, "文档超过 2,500 个翻译片段或 20 万字符")
                                if translations is not None:
                                    if index >= len(translations):
                                        raise HTTPException(422, "译文数量与文档不匹配")
                                    pieces.append(translations[index].strip() + separator)
                            if translations is not None:
                                result = original[:len(original) - len(original.lstrip())] + "".join(pieces)
                                result += original[len(original.rstrip()):]
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
                    changed_parts[item.filename] = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
            if translations is None:
                return {"texts": texts}
            if len(translations) != len(texts):
                raise HTTPException(422, "译文数量与文档不匹配")
            output = io.BytesIO()
            with ZipFile(output, "w", compression=ZIP_DEFLATED) as target:
                for item in items:
                    content = changed_parts[item.filename] if item.filename in changed_parts else source.read(item)
                    target.writestr(item.filename, content)
            return output.getvalue()
    except (BadZipFile, KeyError, RuntimeError, etree.XMLSyntaxError, ValueError) as error:
        raise HTTPException(422, "无法读取该 Word .docx 文档") from error


async def read_document(file):
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "Word 文档不能超过 15 MB")
    return data


@router.post("/text")
async def document_text(file: UploadFile = File(...)):
    return await run_in_threadpool(process, await read_document(file))


@router.post("/export")
async def document_export(file: UploadFile = File(...), texts: str = Form(...), mode: str = Form(...)):
    try:
        translations = json.loads(texts)
    except ValueError as error:
        raise HTTPException(422, "无法读取译文") from error
    if (mode not in ("bilingual", "translated") or not isinstance(translations, list) or
            len(translations) > 2500 or any(not isinstance(text, str) or not text.strip() for text in translations)):
        raise HTTPException(422, "译文或文档导出方式无效")
    data = await run_in_threadpool(process, await read_document(file), translations, mode)
    return Response(data, media_type=MIME)
