import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from backend.translation.local_translator import _translate_single, translate_texts


class LocalTranslatorTests(unittest.TestCase):
    @patch("backend.translation.local_translator.urllib_request.urlopen")
    def test_translates_full_japanese_text_from_japanese_to_simplified_chinese(self, urlopen):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps([
            [["今天天气很好。", "今日は晴れです。", None, None]]
        ]).encode("utf-8")
        urlopen.return_value = response

        self.assertEqual(translate_texts(["今日は晴れです。"]), ["今天天气很好。"])

        query = parse_qs(urlsplit(urlopen.call_args.args[0].full_url).query)
        self.assertEqual(query["sl"], ["ja"])
        self.assertEqual(query["tl"], ["zh-CN"])
        self.assertEqual(query["q"], ["今日は晴れです。"])

    @patch("backend.translation.local_translator.time.sleep")
    @patch("backend.translation.local_translator.urllib_request.urlopen")
    def test_retries_rate_limit_and_honors_retry_after(self, urlopen, sleep):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps([
            [["你好。", "こんにちは。", None, None]]
        ]).encode("utf-8")
        urlopen.side_effect = [
            HTTPError("", 429, "rate limited", {"Retry-After": "1"}, None),
            response,
        ]

        self.assertEqual(_translate_single("こんにちは。"), "你好。")

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1.0)

    @patch("backend.translation.local_translator.time.sleep")
    @patch("backend.translation.local_translator.urllib_request.urlopen")
    def test_reports_rate_limit_after_bounded_retries(self, urlopen, sleep):
        urlopen.side_effect = HTTPError("", 429, "rate limited", {"Retry-After": "0"}, None)

        with self.assertRaisesRegex(RuntimeError, "请求过于频繁"):
            _translate_single("こんにちは。")

        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(sleep.call_count, 2)


if __name__ == "__main__":
    unittest.main()
