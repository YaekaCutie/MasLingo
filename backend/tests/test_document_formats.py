import io
import unittest
from unittest.mock import patch
from zipfile import ZIP_STORED, ZipFile

from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from backend.document import dispatch
from backend.document_formats import DRAW, XLS
from backend.tests.test_document import sample


def package(parts):
    stream = io.BytesIO()
    with ZipFile(stream, "w") as output:
        for name, content in parts.items():
            output.writestr(name, content)
    return stream.getvalue()


class FormatTests(unittest.TestCase):
    def text(self, data, suffix):
        return dispatch(data, suffix)[0]["texts"]

    def export(self, data, suffix, mode="translated"):
        texts = self.text(data, suffix)
        return dispatch(data, suffix, [f"译 {text}" for text in texts], mode)[0]

    def test_excel_keeps_formulas_and_translates_both_string_types(self):
        ns = XLS[1:-1]
        data = package({
            "xl/workbook.xml": "<workbook/>",
            "xl/sharedStrings.xml": f'<sst xmlns="{ns}"><si><t>Heading</t></si></sst>',
            "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{ns}"><sheetData><row>'
                '<c t="s"><v>0</v></c><c t="inlineStr"><is><t>Inline</t></is></c>'
                '<c t="str"><f>SUM(B1:B2)</f><v>cached text</v></c></row></sheetData></worksheet>',
        })
        self.assertEqual(self.text(data, ".xlsx"), ["Heading", "Inline"])
        with ZipFile(io.BytesIO(self.export(data, ".xlsx", "bilingual"))) as output:
            self.assertIn("Heading ｜ 译 Heading", output.read("xl/sharedStrings.xml").decode())
            sheet = output.read("xl/worksheets/sheet1.xml").decode()
            self.assertIn("Inline ｜ 译 Inline", sheet)
            self.assertIn("<f>SUM(B1:B2)</f><v>cached text</v>", sheet)

    def test_powerpoint_adds_translation_inside_original_shape(self):
        ns = DRAW[1:-1]
        data = package({
            "ppt/presentation.xml": "<presentation/>",
            "ppt/slides/slide1.xml": f'<slide xmlns:a="{ns}"><a:p><a:r><a:rPr b="1"/>'
                '<a:t>Heading</a:t></a:r><a:endParaRPr/></a:p></slide>',
            "ppt/media/image1.png": b"original-image",
        })
        with ZipFile(io.BytesIO(self.export(data, ".pptx", "bilingual"))) as output:
            slide = output.read("ppt/slides/slide1.xml").decode()
            self.assertIn('<a:t>Heading</a:t></a:r><a:br/>', slide)
            self.assertIn('<a:rPr b="1"/><a:t>译 Heading</a:t>', slide)
            self.assertEqual(output.read("ppt/media/image1.png"), b"original-image")

    def test_odf_and_epub_preserve_package_mimetype(self):
        content = """<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
          xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
          xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
          <text:p>Heading</text:p><table:table-cell table:formula="of:=1+1"><text:p>Cached</text:p>
          </table:table-cell></office:document-content>"""
        cases = [
            (f".{suffix}", f"application/vnd.oasis.opendocument.{kind}", "content.xml", content)
            for suffix, kind in [("odt", "text"), ("ods", "spreadsheet"), ("odp", "presentation")]
        ] + [(".epub", "application/epub+zip", "Book/chapter.xhtml",
              '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Heading</p></body></html>')]
        for suffix, mime, part, text in cases:
            with self.subTest(suffix=suffix):
                data = package({"mimetype": mime, part: text, "image.png": b"original-image"})
                self.assertEqual(self.text(data, suffix), ["Heading"])
                with ZipFile(io.BytesIO(self.export(data, suffix))) as output:
                    self.assertEqual(output.infolist()[0].filename, "mimetype")
                    self.assertEqual(output.infolist()[0].compress_type, ZIP_STORED)
                    self.assertIn("译 Heading", output.read(part).decode())
                    self.assertEqual(output.read("image.png"), b"original-image")

    def test_text_formats_keep_syntax_and_timing(self):
        self.assertEqual(self.export(b"Heading\n", ".txt", "bilingual").decode(), "Heading\n译 Heading\n")
        md = self.export(b"# Heading\n\nRead `code`\n\n```js\nconst value = 1\n```\n", ".md").decode()
        self.assertIn("# 译 Heading", md)
        self.assertIn("`code`", md)
        self.assertIn("const value = 1", md)
        html = self.export(b'<p><a href="https://example.org">Heading</a></p><script>const value=1;</script>', ".html").decode()
        self.assertIn('href="https://example.org">译 Heading', html)
        self.assertIn("const value=1;", html)
        for suffix, text in ((".csv", "Heading,1e5,=SUM(A1)\r\n"), (".tsv", "Heading\t1e5\t=SUM(A1)\r\n")):
            self.assertEqual(self.text(text.encode(), suffix), ["Heading"])
            self.assertIn("=SUM(A1)", self.export(text.encode(), suffix).decode("utf-8-sig"))
        for suffix, header, separator in ((".srt", "1\r\n", ","), (".vtt", "WEBVTT\n\n", ".")):
            timing = f"00:00:01{separator}000 --> 00:00:02{separator}100"
            data = f"{header}{timing}\nHeading\n".encode()
            self.assertEqual(self.text(data, suffix), ["Heading"])
            self.assertIn(f"{timing}\n译 Heading", self.export(data, suffix).decode())

    def test_pdf_keeps_original_page_in_bilingual_mode_and_uses_ocr_for_scans(self):
        stream = io.BytesIO()
        canvas = Canvas(stream)
        canvas.drawString(72, 720, "Original PDF")
        canvas.showPage()
        canvas.drawImage(ImageReader(Image.new("RGB", (120, 70), "white")), 72, 650)
        canvas.save()
        data = stream.getvalue()
        with patch("backend.document_pdf.scanned_lines", return_value=["Recognized words"]) as recognize:
            self.assertEqual(self.text(data, ".pdf"), ["Original PDF", "Recognized words"])
            self.assertEqual(recognize.call_args.args[1], 1)
            bilingual = PdfReader(io.BytesIO(self.export(data, ".pdf", "bilingual")))
            self.assertEqual(len(bilingual.pages), 4)
            self.assertIn("Original PDF", bilingual.pages[0].extract_text())
            self.assertIn("译 Original PDF", bilingual.pages[1].extract_text())
            translated = PdfReader(io.BytesIO(self.export(data, ".pdf")))
            self.assertEqual(len(translated.pages), 2)
            self.assertIn("译 Recognized words", translated.pages[1].extract_text())
            for output in (bilingual, translated):
                self.assertTrue(all("Translation ·" not in page.extract_text() for page in output.pages))

    def test_pdf_reads_scanned_body_even_with_selectable_watermark(self):
        stream = io.BytesIO()
        canvas = Canvas(stream, pagesize=(300, 400))
        image = ImageReader(Image.new("RGB", (300, 400), "white"))
        canvas.beginForm("image")
        canvas.drawImage(image, 0, 0)
        canvas.endForm()
        canvas.doForm("image")
        canvas.drawString(20, 20, "Watermark")
        canvas.showPage()
        canvas.scale(0.1, 0.1)
        canvas.doForm("image")
        canvas.drawString(200, 800, "Selectable caption")
        canvas.save()

        with patch("backend.document_pdf.ocr") as recognize:
            recognize.return_value.return_value = ([[None, "Scanned question and answer choices", 1]], None)
            self.assertEqual(self.text(stream.getvalue(), ".pdf"), [
                "Scanned question and answer choices", "Selectable caption",
            ])
            recognize.return_value.assert_called_once()

    def test_pdf_with_permissions_password_can_be_translated(self):
        stream = io.BytesIO()
        canvas = Canvas(stream)
        canvas.drawString(72, 720, "Original PDF")
        canvas.save()
        for password in ("", "open-password"):
            with self.subTest(requires_password=bool(password)):
                writer = PdfWriter(clone_from=io.BytesIO(stream.getvalue()))
                writer.encrypt(password, "owner-password", permissions_flag=UserAccessPermissions.PRINT)
                encrypted = io.BytesIO()
                writer.write(encrypted)
                data = encrypted.getvalue()
                if password:
                    with self.assertRaises(HTTPException) as error:
                        self.text(data, ".pdf")
                    self.assertEqual(error.exception.status_code, 422)
                    self.assertIn("打开密码", error.exception.detail)
                else:
                    self.assertEqual(self.text(data, ".pdf"), ["Original PDF"])
                    bilingual = PdfReader(io.BytesIO(self.export(data, ".pdf", "bilingual")))
                    self.assertEqual(len(bilingual.pages), 2)
                    self.assertIn("Original PDF", bilingual.pages[0].extract_text())
                    self.assertIn("译 Original PDF", bilingual.pages[1].extract_text())

    def test_legacy_route_converts_to_modern_and_back(self):
        with patch("backend.document_legacy.libreoffice", return_value="soffice"), \
                patch("backend.document_legacy.convert", side_effect=[sample(), sample(), b"legacy output"]) as convert:
            texts = self.text(b"legacy source", ".doc")
            output, mime = dispatch(b"legacy source", ".doc", ["译 " + text for text in texts], "translated")
            self.assertEqual(output, b"legacy output")
            self.assertEqual(mime, "application/msword")
            self.assertEqual([call.args[4] for call in convert.call_args_list], ["docx", "docx", "doc:MS Word 97"])
