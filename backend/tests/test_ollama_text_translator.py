import json
import unittest
from unittest.mock import patch

from backend.translation.ollama_text_translator import OllamaError, translate_batch


class OllamaTextTranslatorTests(unittest.TestCase):
    @patch("backend.translation.ollama_text_translator._request")
    def test_batch_is_text_only_and_preserves_order(self, request):
        items = ["おはよう", "ありがとう"]
        translations = ["早上好", "谢谢"]
        request.return_value.json.return_value = {
            "message": {"content": json.dumps({"translations": translations})}
        }

        result = translate_batch(items, "qwen2.5:7b")

        payload = request.call_args.kwargs["json"]
        self.assertEqual(request.call_args.args, ("POST", "/api/chat"))
        self.assertNotIn("images", payload["messages"][1])
        self.assertEqual(json.loads(payload["messages"][1]["content"]), {"ocr_items": items})
        self.assertEqual(
            result,
            [
                {"source_text": items[0], "translated_text": translations[0]},
                {"source_text": items[1], "translated_text": translations[1]},
            ],
        )

    @patch("backend.translation.ollama_text_translator._request")
    def test_rejects_translation_count_mismatch(self, request):
        request.return_value.json.return_value = {
            "message": {"content": '{"translations":["只翻译了一条"]}'}
        }

        with self.assertRaisesRegex(OllamaError, "条目数量"):
            translate_batch(["一", "二"])


if __name__ == "__main__":
    unittest.main()