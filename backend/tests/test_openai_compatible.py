import json
import unittest
from unittest.mock import MagicMock, patch

from backend.translation.openai_compatible import translate_texts


class OpenAICompatibleTests(unittest.TestCase):
    @patch("backend.translation.openai_compatible.urllib_request.urlopen")
    def test_posts_chat_completions_request_and_parses_numbered_lines(self, urlopen):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": "1. 你好\n2. 再见"}}]
        }).encode("utf-8")
        urlopen.return_value = response

        translations = translate_texts(
            ["こんにちは", "さようなら"],
            "http://127.0.0.1:11434/v1/chat/completions",
            "local-model",
            "",
        )

        self.assertEqual(translations, ["你好", "再见"])
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual(request.get_method(), "POST")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "local-model")
        self.assertIn("こんにちは", payload["messages"][1]["content"])
        self.assertIn("简体中文", payload["messages"][0]["content"])
        self.assertIn("结合本批所有条目理解上下文", payload["messages"][0]["content"])
        self.assertEqual(payload["temperature"], 0.1)
        self.assertNotIn("Authorization", request.headers)

    @patch("backend.translation.openai_compatible.urllib_request.urlopen")
    def test_sends_api_key_as_bearer_authorization(self, urlopen):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": "你好"}}]
        }).encode("utf-8")
        urlopen.return_value = response

        translate_texts(
            ["こんにちは"],
            "https://api.example.com/v1/chat/completions",
            "test-model",
            "test-secret",
        )

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer test-secret")

    def test_requires_endpoint_and_model(self):
        with self.assertRaisesRegex(RuntimeError, "接口地址和模型"):
            translate_texts(["こんにちは"], "", "", "")


if __name__ == "__main__":
    unittest.main()
