import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import app


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


if __name__ == "__main__":
    unittest.main()