"""Original-format editors for office packages, ebooks, and text documents."""

import csv
import io
import re
from copy import deepcopy

from fastapi import HTTPException
from lxml import etree, html

from .document_common import PARSE_ERRORS, SPACE, TextMap, open_package, write_package, xml, xml_bytes

XLS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DRAW = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
ODF_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
ODF_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
ODF_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
ODF_NAMES = {".odt": "text", ".ods": "spreadsheet", ".odp": "presentation"}
MIMES = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".epub": "application/epub+zip", ".pdf": "application/pdf",
    ".html": "text/html", ".htm": "text/html", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
    ".srt": "application/x-subrip", ".vtt": "text/vtt",
    **{suffix: f"application/vnd.oasis.opendocument.{name}" for suffix, name in ODF_NAMES.items()},
}
INLINE_MARKUP = re.compile(r"(`[^`]*`|!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|[\[\]*_~|]+|<[^>]+>|https?://[^\s<>]+)")
MD_PREFIX = re.compile(r"^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)")
SKIP_HTML = {"script", "style", "code", "pre", "textarea", "template", "svg", "math", "noscript"}


def with_original(original, translated, mode, separator=" ｜ "):
    if mode == "bilingual" and translated != original:
        trailing = original[len(original.rstrip()):]
        return original.rstrip() + separator + translated.strip() + trailing
    return translated


def local_name(node):
    return etree.QName(node).localname.lower() if node is not None and isinstance(node.tag, str) else ""


def edit_text_tree(element, mapping, mode, skip):
    def change(node, attribute):
        original = getattr(node, attribute)
        if original:
            translated = with_original(original, mapping.apply(original), mode)
            if translated != original:
                setattr(node, attribute, translated)
                return True
        return False
    changed = change(element, "text")
    for child in element:
        if isinstance(child.tag, str) and not skip(child):
            changed |= edit_text_tree(child, mapping, mode, skip)
        changed |= change(child, "tail")
    return changed


def run_groups(parent, ns):
    """Join adjacent pieces of the same character style before translating."""
    nodes = []
    style = None
    for run in parent:
        direct = run.tag == ns + "t"
        text = run if direct else run.find(ns + "t") if run.tag == ns + "r" else None
        props = None if direct or text is None else run.find(ns + "rPr")
        key = etree.tostring(props, with_tail=False) if props is not None else None
        if nodes and (text is None or key != style):
            yield nodes
            nodes = []
        if text is not None:
            nodes.append(text)
            style = key
    if nodes:
        yield nodes


def replace_runs(nodes, text):
    nodes[0].text = text
    if text != text.strip():
        nodes[0].set(SPACE, "preserve")
    for node in nodes[1:]:
        node.text = ""


def edit_sheet(root, mapping, mode):
    for container in root.iter():
        if container.tag not in (XLS + "si", XLS + "is"):
            continue
        if container.tag == XLS + "is" and container.getparent().find(XLS + "f") is not None:
            continue
        for nodes in run_groups(container, XLS):
            original = "".join(node.text or "" for node in nodes)
            result = mapping.apply(original)
            if result != original:
                replace_runs(nodes, with_original(original, result, mode))


def edit_slide(root, mapping, mode):
    for paragraph in root.iter(DRAW + "p"):
        translated = []
        changed = False
        for nodes in run_groups(paragraph, DRAW):
            original = "".join(node.text or "" for node in nodes)
            result = mapping.apply(original)
            changed |= result != original
            if mode == "translated" and result != original:
                replace_runs(nodes, result)
            translated.append((nodes[0].getparent(), result))
        if changed and mode == "bilingual":
            end = paragraph.find(DRAW + "endParaRPr")
            index = paragraph.index(end) if end is not None else len(paragraph)
            paragraph.insert(index, etree.Element(DRAW + "br"))
            for index, (source, text) in enumerate(translated, index + 1):
                run = etree.Element(DRAW + "r")
                properties = source.find(DRAW + "rPr")
                if properties is not None:
                    run.append(deepcopy(properties))
                etree.SubElement(run, DRAW + "t").text = text
                paragraph.insert(index, run)


def edit_odf(root, mapping, mode):
    block_tags = {ODF_TEXT + "p", ODF_TEXT + "h"}
    for paragraph in root.iter(*block_tags):
        if any(local_name(ancestor) in {"tracked-changes", "deletion"} for ancestor in paragraph.iterancestors()):
            continue
        cell = next(paragraph.iterancestors(ODF_TABLE + "table-cell"), None)
        if cell is not None and (cell.get(ODF_TABLE + "formula") or cell.get(ODF_OFFICE + "value-type") not in (None, "string")):
            continue
        changed = edit_text_tree(paragraph, mapping, mode, lambda node: node.tag in block_tags or local_name(node) in {"tracked-changes", "deletion"})
        if cell is not None and changed:
            cell.attrib.pop(ODF_OFFICE + "string-value", None)


def edit_html(root, mapping, mode):
    for node in root.iter():
        if local_name(node) == "body" or (local_name(node) == "title" and local_name(node.getparent()) == "head"):
            edit_text_tree(node, mapping, mode, lambda child: local_name(child) in SKIP_HTML)


def package_format(data, suffix, mapping, mode):
    with open_package(data) as package:
        if suffix == ".xlsx":
            package.getinfo("xl/workbook.xml")
            names = [name for name in package.namelist() if
                     name == "xl/sharedStrings.xml" or re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)]
            editor = edit_sheet
        elif suffix == ".pptx":
            package.getinfo("ppt/presentation.xml")
            names = [name for name in package.namelist() if re.fullmatch(r"ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml", name)]
            editor = edit_slide
        elif suffix in ODF_NAMES:
            if package.read("mimetype").decode("ascii").strip() != MIMES[suffix]:
                raise HTTPException(422, "OpenDocument 文件类型与后缀不匹配")
            names = ["content.xml"]
            if "styles.xml" in package.namelist():
                names.append("styles.xml")
            editor = edit_odf
        else:
            if package.read("mimetype").strip() != b"application/epub+zip":
                raise HTTPException(422, "无效的 EPUB 文件")
            names = [name for name in package.namelist() if name.lower().endswith((".xhtml", ".html", ".htm"))]
            editor = edit_html
        changes = {}
        for name in names:
            root = xml(package.read(name), allow_doctype=suffix == ".epub")
            editor(root, mapping, mode)
            if mapping.translations is not None:
                changes[name] = xml_bytes(root)
        return write_package(package, changes) if mapping.translations is not None else None


def plain_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            text = data.decode(encoding)
            if "\0" not in text:
                return text, "utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8"
        except UnicodeError:
            continue
    raise HTTPException(422, "无法读取文本编码，请另存为 UTF-8")


def delimited(text, suffix, mapping, mode):
    delimiter = "\t" if suffix == ".tsv" else ","
    if suffix == ".csv":
        try:
            delimiter = csv.Sniffer().sniff(text[:4096], delimiters=",;\t").delimiter
        except csv.Error:
            pass
    result = io.StringIO(newline="")
    writer = csv.writer(result, delimiter=delimiter, lineterminator="\r\n" if "\r\n" in text else "\n")
    for row in csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True):
        cells = []
        for cell in row:
            value = cell.strip()
            if not value or value.startswith("=") or re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?", value):
                cells.append(cell)
            else:
                updated = with_original(cell, mapping.apply(cell), mode, "\n")
                # Keep translations from turning text cells into spreadsheet formulas.
                cells.append("'" + updated if updated != cell and updated.lstrip().startswith(("=", "+", "-", "@")) else updated)
        writer.writerow(cells)
    return result.getvalue()


def markdown_lines(text, mapping, mode):
    fence = ""
    front_matter = False
    lines = text.splitlines(keepends=True)
    if lines and lines[0].strip() == "---":
        front_matter = any(line.strip() in ("---", "...") for line in lines[1:])
    for index, line in enumerate(lines):
        trimmed = line.lstrip()
        if front_matter:
            if index and line.strip() in ("---", "..."):
                front_matter = False
            yield line
            continue
        marker = re.match(r"`{3,}|~{3,}", trimmed)
        if marker and (not fence or trimmed.startswith(fence)):
            fence = "" if fence else marker.group()
            yield line
            continue
        if fence or line.startswith(("    ", "\t")) or re.match(r"^\s*\[[^\]]+\]:", line):
            yield line
            continue
        prefix = MD_PREFIX.match(line)
        start = prefix.end() if prefix else 0
        parts = INLINE_MARKUP.split(line[start:])
        for i in range(0, len(parts), 2):
            parts[i] = with_original(parts[i], mapping.apply(parts[i]), mode)
        yield line[:start] + "".join(parts)


def subtitle_lines(text, suffix, mapping, mode):
    header = suffix == ".vtt"
    for block in re.split(r"((?:\r?\n){2,})", text):
        lines = block.splitlines(keepends=True)
        if header:
            if lines and lines[0].startswith("WEBVTT"):
                header = False
                yield block
                continue
            raise HTTPException(422, "无效的 WebVTT 字幕文件")
        if lines and lines[0].startswith(("NOTE", "STYLE", "REGION")):
            yield block
            continue
        timing = next((i for i, line in enumerate(lines[:2]) if re.match(r"^\d[\d:.,]*\s+-->\s+\d", line)), None)
        if timing is not None:
            for i in range(timing + 1, len(lines)):
                line = lines[i]
                parts = re.split(r"(<[^>]+>)", line)
                for j in range(0, len(parts), 2):
                    parts[j] = with_original(parts[j], mapping.apply(parts[j]), mode)
                lines[i] = "".join(parts)
            yield "".join(lines)
        else:
            yield block


def process_format(data, suffix, translations, mode):
    from .document_legacy import LEGACY, convert_legacy
    if suffix in LEGACY:
        return convert_legacy(data, suffix, translations, mode)
    if suffix not in MIMES:
        raise HTTPException(415, "不支持此文件格式，请查看文档翻译页面的格式列表")
    mapping = TextMap(translations)
    mime = MIMES[suffix]
    try:
        if suffix in (".xlsx", ".pptx", ".epub", *ODF_NAMES):
            output = package_format(data, suffix, mapping, mode)
        elif suffix == ".pdf":
            from .document_pdf import process_pdf
            output = process_pdf(data, mapping, mode)
        elif suffix in (".html", ".htm"):
            encoding = None
            if not re.search(br"<meta[^>]*charset", data[:8192], re.I):
                try:
                    data.decode("utf-8-sig")
                    encoding = "utf-8"
                except UnicodeError:
                    pass
            root = html.document_fromstring(data, parser=html.HTMLParser(no_network=True, encoding=encoding),
                                            ensure_head_body=True)
            edit_html(root, mapping, mode)
            for meta in list(root.iter("meta")):
                if "charset" in meta.attrib or meta.get("http-equiv", "").lower() == "content-type":
                    meta.getparent().remove(meta)
            root.find("head").insert(0, etree.Element("meta", charset="utf-8"))
            output = html.tostring(root, encoding="UTF-8", doctype="<!DOCTYPE html>")
        else:
            text, encoding = plain_text(data)
            if suffix in (".csv", ".tsv"):
                output = delimited(text, suffix, mapping, mode).encode("utf-8-sig")
            elif suffix in (".md", ".markdown"):
                output = "".join(markdown_lines(text, mapping, mode)).encode(encoding)
            elif suffix in (".srt", ".vtt"):
                output = "".join(subtitle_lines(text, suffix, mapping, mode)).encode(encoding)
            else:
                newline = "\r\n" if "\r\n" in text else "\n"
                output = "".join(with_original(line, mapping.apply(line), mode, newline) for line in text.splitlines(keepends=True)).encode(encoding)
    except PARSE_ERRORS + (csv.Error, etree.ParserError) as error:
        raise HTTPException(422, "文件损坏或内容与所选格式不匹配") from error
    if translations is None:
        return {"texts": mapping.texts}, mime
    mapping.validate()
    return output, mime
