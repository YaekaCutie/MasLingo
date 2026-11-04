import io
import json
import unittest
from zipfile import ZipFile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from lxml import etree

from backend.document import MIME, NS, router, w


def sample():
    output = io.BytesIO()
    with ZipFile(output, "w") as doc:
        doc.writestr("[Content_Types].xml", f"""<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/word/document.xml" ContentType="{MIME}.main+xml"/>
        </Types>""")
        doc.writestr("word/document.xml", f"""<w:document xmlns:w="{NS}"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
          xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
          xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">
          <w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
              <w:r><w:t xml:space="preserve">Project </w:t></w:r><w:r><w:t>update</w:t></w:r>
            </w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Budget</w:t></w:r>
              <w:r><w:t xml:space="preserve"> approved </w:t></w:r>
              <w:hyperlink r:id="rId9"><w:r><w:t>details</w:t></w:r></w:hyperlink>
              <w:r><w:tab/><w:t>123</w:t></w:r>
            </w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
              <w:r><w:instrText> PAGE </w:instrText></w:r>
              <w:r><w:fldChar w:fldCharType="separate"/></w:r>
              <w:r><w:t>Page field</w:t></w:r>
              <w:r><w:fldChar w:fldCharType="end"/></w:r>
              <w:r><w:drawing/><w:t>Caption</w:t></w:r>
            </w:p>
          </w:body>
        </w:document>""")
        doc.writestr("word/header1.xml", f'<w:hdr xmlns:w="{NS}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>')
        doc.writestr("word/media/image1.png", b"unchanged-image")
        doc.writestr("word/_rels/document.xml.rels", b"unchanged-relationships")
    return output.getvalue()


class DocumentTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.files = {"file": ("sample.docx", sample(), MIME)}
        self.translations = ["项目更新", "预算", "已批准", "详情", "说明", "页眉"]

    def test_extracts_styled_groups_and_skips_fields(self):
        response = self.client.post("/api/document/text", files=self.files)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["texts"], ["Project update", "Budget", "approved", "details", "Caption", "Header"])

    def exported(self, mode):
        response = self.client.post("/api/document/export", files=self.files,
                                    data={"texts": json.dumps(self.translations), "mode": mode})
        self.assertEqual(response.status_code, 200, response.text if not response.is_success else "")
        self.assertEqual(response.headers["content-type"], MIME)
        return ZipFile(io.BytesIO(response.content))

    def test_translated_replaces_text_and_keeps_structure(self):
        with self.exported("translated") as doc:
            xml = etree.fromstring(doc.read("word/document.xml"))
            self.assertEqual([text.text for text in xml.iter(w("t")) if text.text],
                             ["项目更新", "预算", " 已批准 ", "详情", "123", "Page field", "说明"])
            self.assertEqual(len(list(xml.iter(w("drawing")))), 1)
            self.assertIsNotNone(xml.find(f".//{w('tbl')}"))
            link = xml.find(f".//{w('hyperlink')}")
            self.assertEqual(link.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"), "rId9")
            self.assertEqual(link.find(f".//{w('t')}").text, "详情")
            self.assertEqual(xml.find(f".//{w('pStyle')}").get(w("val")), "Heading1")
            self.assertEqual(xml.find(f".//{w('b')}/..").getparent().find(w("t")).text, "预算")
            self.assertIn("w14", xml.nsmap)
            self.assertIn("页眉", doc.read("word/header1.xml").decode())
            self.assertEqual(doc.read("word/media/image1.png"), b"unchanged-image")
            self.assertEqual(doc.read("word/_rels/document.xml.rels"), b"unchanged-relationships")

    def test_bilingual_keeps_original_with_an_extra_line(self):
        with self.exported("bilingual") as doc:
            xml = etree.fromstring(doc.read("word/document.xml"))
            title = next(xml.iter(w("p")))
            self.assertEqual([node.text for node in title.iter(w("t"))], ["Project ", "update", "项目更新"])
            self.assertEqual(len(list(title.iter(w("br")))), 1)
            self.assertEqual(len(list(xml.iter(w("drawing")))), 1)
            links = list(xml.iter(w("hyperlink")))
            self.assertEqual([link.find(f".//{w('t')}").text for link in links], ["details", "详情"])
            self.assertEqual(dict(links[0].attrib), dict(links[1].attrib))

    def test_invalid_file_and_translation_count(self):
        result = self.client.post("/api/document/text", files={"file": ("broken.docx", b"invalid", MIME)})
        self.assertEqual(result.status_code, 422)
        result = self.client.post("/api/document/export", files=self.files,
                                  data={"texts": '["partial"]', "mode": "translated"})
        self.assertEqual(result.status_code, 422)
