import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from huggingface_hub.errors import LocalEntryNotFoundError
from PIL import Image, ImageDraw

from backend.app import app
from backend.ocr.manga_ocr_engine import (
    _detect_text_direction,
    _vertical_column_bounds,
    get_engine,
    recognize,
)


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

    def test_vertical_columns_are_ordered_right_to_left(self):
        image = Image.new("RGB", (120, 240), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 10, 40, 230), fill="black")
        draw.rectangle((70, 10, 90, 230), fill="black")

        self.assertEqual(
            _vertical_column_bounds(image),
            [(70, 91), (20, 41)],
        )

    def test_direction_detection_compares_square_glyph_spacing(self):
        horizontal = Image.new("L", (180, 60), 242)
        vertical = Image.new("L", (60, 180), 242)
        horizontal_draw = ImageDraw.Draw(horizontal)
        vertical_draw = ImageDraw.Draw(vertical)
        for index in range(5):
            horizontal_draw.rectangle((12 + index * 30, 18, 29 + index * 30, 35), fill=48)
            vertical_draw.rectangle((18, 12 + index * 30, 35, 29 + index * 30), fill=48)
        for x, y in ((3, 5), (56, 9), (97, 52), (165, 6), (42, 49)):
            horizontal_draw.point((x, y), fill=188)
        for x, y in ((5, 3), (9, 56), (52, 97), (6, 165), (49, 42)):
            vertical_draw.point((x, y), fill=188)

        self.assertEqual(_detect_text_direction(horizontal), "horizontal")
        self.assertEqual(_detect_text_direction(vertical), "vertical")

    def test_direction_detection_returns_unknown_for_single_glyph(self):
        image = Image.new("L", (48, 48), 255)
        ImageDraw.Draw(image).rectangle((12, 12, 35, 35), fill=0)

        self.assertIsNone(_detect_text_direction(image))

    @patch("backend.ocr.manga_ocr_engine.get_engine")
    def test_recognizes_vertical_columns_right_to_left(self, engine_factory):
        image = Image.new("RGB", (140, 240), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 10, 40, 230), fill="black")
        draw.rectangle((70, 10, 99, 230), fill="black")
        engine = engine_factory.return_value
        engine.side_effect = lambda crop: "right" if crop.width > 50 else "left"

        self.assertEqual(recognize(image), ["rightleft"])
        self.assertEqual(engine.call_count, 2)

    @patch("backend.ocr.manga_ocr_engine.MangaOcr")
    @patch("backend.ocr.manga_ocr_engine.snapshot_download")
    def test_engine_loads_cached_model_snapshot(self, snapshot_mock, manga_ocr_mock):
        get_engine.cache_clear()
        snapshot_mock.return_value = "cached-model-path"
        try:
            engine = get_engine()
        finally:
            get_engine.cache_clear()

        snapshot_mock.assert_called_once_with(
            "kha-white/manga-ocr-base",
            local_files_only=True,
        )
        manga_ocr_mock.assert_called_once_with("cached-model-path")
        self.assertIs(engine, manga_ocr_mock.return_value)

    @patch("backend.ocr.manga_ocr_engine.MangaOcr")
    @patch("backend.ocr.manga_ocr_engine.snapshot_download")
    def test_engine_downloads_model_when_cache_is_missing(self, snapshot_mock, manga_ocr_mock):
        get_engine.cache_clear()
        snapshot_mock.side_effect = [
            LocalEntryNotFoundError("model not cached"),
            "downloaded-model-path",
        ]
        try:
            engine = get_engine()
        finally:
            get_engine.cache_clear()

        self.assertEqual(snapshot_mock.call_count, 2)
        snapshot_mock.assert_any_call("kha-white/manga-ocr-base", local_files_only=True)
        snapshot_mock.assert_any_call("kha-white/manga-ocr-base")
        manga_ocr_mock.assert_called_once_with("downloaded-model-path")
        self.assertIs(engine, manga_ocr_mock.return_value)

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