import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy import configure_hosted_backend as config


class HostedConfigTests(unittest.TestCase):
    def test_keeps_capture_and_translation_permissions_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            original = ["<all_urls>", "https://api.openai.com/*"]
            manifest.write_text(json.dumps({"host_permissions": original}))
            with patch.object(config, "MANIFEST", manifest):
                hosts = config.update_manifest("https://ocr.example.com")
                self.assertEqual(hosts, config.update_manifest("https://ocr.example.com"))
            for host in [*original, *config.LOCAL_HOSTS, "https://ocr.example.com/*"]:
                self.assertIn(host, hosts)


if __name__ == "__main__":
    unittest.main()
