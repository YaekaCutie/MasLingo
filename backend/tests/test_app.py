import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import app
from backend.ocr.manga_ocr_engine import recognize


class AppTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_rejects_empty_upload(self):
        response = self.client.post(
            "/api/recognize-image",
            files={"image": ("empty.png", b"", "image/png")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("图片内容", response.json()["detail"])

    def test_rejects_oversized_upload(self):
        response = self.client.post(
            "/api/recognize-image",
            files={"image": ("large.png", b"x" * (15 * 1024 * 1024 + 1), "image/png")},
        )

        self.assertEqual(response.status_code, 413)

    def test_rejects_invalid_image(self):
        response = self.client.post(
            "/api/recognize-image",
            files={"image": ("not-image.txt", b"not an image", "text/plain")},
        )

        self.assertEqual(response.status_code, 415)

    def test_health_reports_mangaocr(self):
        response = self.client.get(
            "/health",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ocr"], "mangaocr")

    @patch("backend.app.recognize", return_value=["こんにちは"])
    def test_recognizes_valid_image(self, recognize):
        image = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-image",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["items"], [{"text": "こんにちは"}])
        recognize.assert_called_once()

    @patch("backend.ocr.manga_ocr_engine.MangaOcr")
    def test_recognize_splits_multiline_output(self, mock_manga_ocr):
        mock_manga_ocr.return_value.return_value = "  first line\n\n second line  "

        result = recognize(Image.new("RGB", (64, 64), "white"))

        self.assertEqual(result, ["first line", "second line"])

    @patch("backend.app.translate_texts", return_value=["你好", "测试"])
    def test_translate_text_route(self, translate_texts_mock):
        response = self.client.post(
            "/api/translate-text",
            json={"texts": ["こんにちは", "テスト"]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["items"],
            [
                {"text": "こんにちは", "translated": "你好"},
                {"text": "テスト", "translated": "测试"},
            ],
        )
        translate_texts_mock.assert_called_once_with(["こんにちは", "テスト"])

    @patch("backend.translation.local_translator._translate_single", return_value="你好")
    def test_translate_mixed_text_preserves_non_japanese_segments(self, translate_single_mock):
        result = self.client.post(
            "/api/translate-text",
            json={"texts": ["下午好，先生。こんにちは"]},
        )

        self.assertEqual(result.status_code, 200)
        self.assertEqual(
            result.json()["items"][0]["translated"],
            "下午好，先生。你好",
        )
        translate_single_mock.assert_called_once_with("こんにちは")


if __name__ == "__main__":
    unittest.main()