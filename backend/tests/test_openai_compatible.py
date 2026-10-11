import json
import unittest
import urllib.request as urllib_request
from unittest.mock import MagicMock, patch

from backend.translation.openai_compatible import (
    _GuardedRedirectHandler,
    translate_texts,
)


class OpenAICompatibleTests(unittest.TestCase):
    @patch("backend.translation.openai_compatible._opener.open")
    def test_posts_chat_completions_request_and_parses_numbered_lines(self, open_mock):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": "1. 你好\n2. 再见"}}]
        }).encode("utf-8")
        open_mock.return_value = response

        translations = translate_texts(
            ["こんにちは", "さようなら"],
            "http://127.0.0.1:11434/v1/chat/completions",
            "local-model",
            "",
        )

        self.assertEqual(translations, ["你好", "再见"])
        request = open_mock.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual(request.get_method(), "POST")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "local-model")
        self.assertIn("こんにちは", payload["messages"][1]["content"])
        self.assertIn("简体中文", payload["messages"][0]["content"])
        self.assertIn("结合本批所有条目理解上下文", payload["messages"][0]["content"])
        self.assertEqual(payload["temperature"], 0.1)
        self.assertNotIn("Authorization", request.headers)

    @patch("backend.translation.openai_compatible._opener.open")
    def test_sends_api_key_as_bearer_authorization(self, open_mock):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": "你好"}}]
        }).encode("utf-8")
        open_mock.return_value = response

        translate_texts(
            ["こんにちは"],
            "https://api.example.com/v1/chat/completions",
            "test-model",
            "test-secret",
        )

        request = open_mock.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer test-secret")

    def test_requires_endpoint_and_model(self):
        with self.assertRaisesRegex(RuntimeError, "接口地址和模型"):
            translate_texts(["こんにちは"], "", "", "")


class RedirectGuardTests(unittest.TestCase):
    """A redirect is a second URL the caller never named — it gets checked too."""

    def test_redirect_to_link_local_address_is_refused(self):
        handler = _GuardedRedirectHandler()
        request = urllib_request.Request("https://gateway.example.com/v1/chat/completions")

        with self.assertRaisesRegex(RuntimeError, "重定向"):
            handler.redirect_request(
                request, None, 302, "Found", {},
                "http://169.254.169.254/latest/meta-data",
            )

    def test_normal_loopback_redirect_is_allowed(self):
        handler = _GuardedRedirectHandler()
        request = urllib_request.Request("http://127.0.0.1:8001/v1/chat/completions")

        redirected = handler.redirect_request(
            request, None, 301, "Moved", {},
            "http://127.0.0.1:11434/v1/chat/completions",
        )

        self.assertEqual(
            redirected.full_url, "http://127.0.0.1:11434/v1/chat/completions"
        )


if __name__ == "__main__":
    unittest.main()
