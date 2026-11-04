"""Shared validation and text mapping for document formats."""

import io
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile

from fastapi import HTTPException
from lxml import etree

MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_EXPANDED_BYTES = 80 * 1024 * 1024
SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def xml(data, *, allow_doctype=False):
    root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    info = root.getroottree().docinfo
    if info.doctype and (not allow_doctype or (info.internalDTD is not None and info.internalDTD.entities())):
        raise HTTPException(422, "文档包含不支持的 XML 声明")
    return root


def xml_bytes(root):
    return etree.tostring(root.getroottree(), encoding="UTF-8", xml_declaration=True)


def split_text(text):
    """Split long text into bounded requests and keep the split whitespace."""
    while len(text) > 1000:
        window = text[:1000]
        cut = max(window.rfind(" ", 500), window.rfind("。", 500) + 1,
                  window.rfind("！", 500) + 1, window.rfind("？", 500) + 1)
        cut = cut if cut >= 500 else 1000
        chunk, remainder = text[:cut], text[cut:]
        text = remainder.lstrip()
        stripped = chunk.rstrip()
        yield stripped, chunk[len(stripped):] + remainder[:len(remainder) - len(text)]
    if text:
        yield text, ""


class TextMap:
    def __init__(self, translations):
        self.translations = translations
        self.texts = []
        self.total_chars = 0

    def apply(self, original):
        trimmed = original.strip()
        if not trimmed or not any(char.isalpha() for char in trimmed):
            return original
        pieces = []
        for text, separator in split_text(trimmed):
            index = len(self.texts)
            self.texts.append(text)
            self.total_chars += len(text)
            if len(self.texts) > 2500 or self.total_chars > 200000:
                raise HTTPException(413, "文档超过 2,500 个翻译片段或 20 万字符")
            if self.translations is not None:
                if index >= len(self.translations):
                    raise HTTPException(422, "译文数量与文档不匹配")
                pieces.append(self.translations[index].strip() + separator)
        if self.translations is None:
            return original
        return original[:len(original) - len(original.lstrip())] + "".join(pieces) + original[len(original.rstrip()):]

    def validate(self):
        if self.translations is not None and len(self.translations) != len(self.texts):
            raise HTTPException(422, "译文数量与文档不匹配")


def open_package(data):
    package = ZipFile(io.BytesIO(data))
    items = package.infolist()
    try:
        if len(items) > 2000 or sum(item.file_size for item in items) > MAX_EXPANDED_BYTES:
            raise HTTPException(413, "文档内部资源过大")
        if len(set(package.namelist())) != len(items) or any(
            item.flag_bits & 1 or "\\" in item.filename or item.filename.startswith("/") or
            ".." in PurePosixPath(item.filename).parts or item.filename.startswith(("_xmlsignatures/", "META-INF/documentsignatures"))
            for item in items
        ):
            raise HTTPException(422, "不支持加密、签名或结构异常的文档")
    except HTTPException:
        package.close()
        raise
    return package


def write_package(source, changes):
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as target:
        if "mimetype" in source.namelist():
            target.writestr("mimetype", source.read("mimetype"), compress_type=ZIP_STORED)
        for item in source.infolist():
            if item.filename != "mimetype":
                data = changes[item.filename] if item.filename in changes else source.read(item)
                target.writestr(item.filename, data)
    return output.getvalue()


PARSE_ERRORS = (BadZipFile, KeyError, RuntimeError, etree.XMLSyntaxError, ValueError)
