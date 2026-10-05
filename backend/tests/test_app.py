import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from huggingface_hub.errors import LocalEntryNotFoundError
from PIL import Image, ImageDraw

from backend.app import app
from backend.ocr.bubble_detector import MAX_TEXT_REGIONS
from backend.ocr.manga_ocr_engine import (
    _detect_text_direction,
    _vertical_column_bounds,
    get_engine,
    recognize,
    recognize_detailed,
)


def detailed(*texts, direction="horizontal"):
    """The shape recognize_detailed returns, so the mocks stay readable."""
    return {"texts": list(texts), "direction": direction}


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

    @patch("backend.app.recognize_detailed", return_value=detailed("こんにちは"))
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

    @patch(
        "backend.app.recognize_detailed",
        return_value=detailed("こんにちは", direction="vertical"),
    )
    def test_recognize_image_reports_the_direction_it_used(self, _recognize):
        # The front end typesets from this value, so it has to survive the hop.
        image = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-image",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.json()["direction"], "vertical")

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

    def test_direction_detection_handles_light_text_on_dark_background(self):
        image = Image.new("L", (60, 180), 12)
        draw = ImageDraw.Draw(image)
        for index in range(5):
            draw.rectangle((18, 12 + index * 30, 35, 29 + index * 30), fill=245)

        self.assertEqual(_detect_text_direction(image), "vertical")

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

    @patch("backend.ocr.manga_ocr_engine.get_engine")
    def test_splits_light_vertical_text_into_columns(self, engine_factory):
        image = Image.new("RGB", (140, 240), (12, 12, 12))
        draw = ImageDraw.Draw(image)
        for left in (20, 70):
            for top in range(15, 220, 35):
                draw.rectangle((left, top, left + 18, top + 18), fill=(245, 245, 245))
        engine_factory.return_value.side_effect = ["right", "left"]

        result = recognize(image)

        self.assertEqual(result, ["rightleft"])
        self.assertEqual(engine_factory.return_value.call_count, 2)

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
            json={"texts": ["こんにちは", "テスト"], "mode": "free-translate"},
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

    @patch("backend.translation.local_translator._translate_single", return_value="今天天气很好。你好")
    def test_google_translation_receives_full_japanese_sentence(self, translate_single_mock):
        source = "今日は晴れです。こんにちは"
        result = self.client.post(
            "/api/translate-text",
            json={"texts": [source], "mode": "free-translate"},
        )

        self.assertEqual(result.status_code, 200)
        self.assertEqual(
            result.json()["items"][0]["translated"],
            "今天天气很好。你好",
        )
        translate_single_mock.assert_called_once_with(source)

    @patch("backend.app.translate_texts")
    def test_translation_is_disabled_by_default(self, translate_texts_mock):
        response = self.client.post(
            "/api/translate-text",
            json={"texts": ["こんにちは"]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"][0]["translated"], "こんにちは")
        translate_texts_mock.assert_not_called()

    @patch("backend.app.translate_openai_compatible", return_value=["你好"])
    def test_openai_compatible_translation_mode(self, translate_mock):
        response = self.client.post(
            "/api/translate-text",
            json={
                "texts": ["こんにちは"],
                "mode": "openai-compatible",
                "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
                "model": "local-model",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"][0]["translated"], "你好")
        translate_mock.assert_called_once_with(
            ["こんにちは"],
            "http://127.0.0.1:11434/v1/chat/completions",
            "local-model",
            "",
        )

    @patch("backend.app.detect_text_regions", return_value=[(10, 12, 60, 55)])
    @patch("backend.app.recognize_detailed", return_value=detailed("こんにちは"))
    def test_recognize_page_detects_and_recognizes_regions(self, recognize_mock, detect_mock):
        image = io.BytesIO()
        Image.new("RGB", (100, 80), "white").save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-page",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["items"],
            [{
                "text": "こんにちは",
                "bbox": {"left": 10, "top": 12, "right": 60, "bottom": 55},
                "direction": "horizontal",
            }],
        )
        detect_mock.assert_called_once()
        self.assertEqual(detect_mock.call_args.kwargs, {"limit": MAX_TEXT_REGIONS})
        recognize_mock.assert_called_once()

    @patch(
        "backend.app.recognize_detailed",
        side_effect=[detailed("first phrase from panel"), detailed("second line says hello")],
    )
    def test_recognize_page_returns_multiple_focused_multiword_items(self, recognize_mock):
        page = Image.new("RGB", (1000, 700), (235, 235, 235))
        draw = ImageDraw.Draw(page)
        for x in range(100, 880, 7):
            draw.line((x, 100, x, 560), fill=(65, 65, 65), width=1)
        for y in range(100, 560, 7):
            draw.line((100, y, 880, y), fill=(65, 65, 65), width=1)
        for left, top in ((170, 180), (650, 440)):
            for row in range(2):
                for column in range(6):
                    x, y = left + column * 24, top + row * 32
                    draw.rectangle((x, y, x + 13, y + 21), fill="black")
        image = io.BytesIO()
        page.save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-page",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertEqual(
            [item["text"] for item in items],
            ["first phrase from panel", "second line says hello"],
        )
        self.assertEqual(len(items), 2)
        self.assertTrue(all(
            item["bbox"]["right"] - item["bbox"]["left"] < 250
            and item["bbox"]["bottom"] - item["bbox"]["top"] < 120
            for item in items
        ))
        self.assertEqual(recognize_mock.call_count, 2)

    @patch(
        "backend.app.detect_text_regions",
        return_value=[(10, 10, 60, 30), (80, 10, 130, 30), (150, 10, 220, 60)],
    )
    @patch(
        "backend.app.recognize_detailed",
        side_effect=[detailed("．．．"), detailed("人間"), detailed("こんにちは、世界")],
    )
    def test_page_ocr_discards_short_visual_noise_but_keeps_dialogue(
        self, recognize_mock, _detect_mock
    ):
        image = io.BytesIO()
        Image.new("RGB", (240, 80), "white").save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-page",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [item["text"] for item in response.json()["items"]],
            ["こんにちは、世界"],
        )
        self.assertEqual(recognize_mock.call_count, 3)

    @patch(
        "backend.app.detect_text_regions",
        side_effect=lambda image, limit: [(0, 0, 20, 20)] * limit,
    )
    @patch("backend.app.recognize_detailed", return_value=detailed("こんにちは"))
    def test_recognize_page_ocr_calls_respect_region_limit(self, recognize_mock, _detect_mock):
        image = io.BytesIO()
        Image.new("RGB", (100, 80), "white").save(image, format="PNG")

        response = self.client.post(
            "/api/recognize-page",
            files={"image": ("manga.png", image.getvalue(), "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["items"]), MAX_TEXT_REGIONS)
        self.assertEqual(recognize_mock.call_count, MAX_TEXT_REGIONS)


if __name__ == "__main__":
    unittest.main()