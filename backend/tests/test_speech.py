import io
import os
import unittest
import wave
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.speech import router


def wav(seconds=1, amplitude=0):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(np.full(int(16000 * seconds), amplitude, dtype=np.int16).tobytes())
    return output.getvalue()


class SpeechTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.env = patch.dict(os.environ, {"MAS_ENABLE_SPEECH": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def post(self, data, language=None):
        fields = {"language": language} if language is not None else None
        return self.client.post("/api/transcribe-audio", data=fields, files={"audio": ("audio.wav", data, "audio/wav")})

    def test_disabled_by_default(self):
        with patch.dict(os.environ, {"MAS_ENABLE_SPEECH": "0"}):
            self.assertEqual(self.post(wav()).status_code, 503)

    def test_bounds_and_invalid_media(self):
        for data, status in [(b"", 400), (b"not audio", 415), (b"x" * (2 * 1024 * 1024 + 1), 413), (wav(13), 413)]:
            self.assertEqual(self.post(data).status_code, status)

    def test_silence_does_not_load_model(self):
        with patch("backend.speech.model") as model:
            self.assertEqual(self.post(wav()).json()["text"], "")
            model.assert_not_called()

    def test_transcript_and_timestamps(self):
        with patch("backend.speech.model") as model:
            model.return_value.transcribe.return_value = (iter([
                SimpleNamespace(start=0.1, end=0.9, text=" Hello. ", no_speech_prob=0.1),
                SimpleNamespace(start=0.9, end=1.0, text="hallucination", no_speech_prob=0.9),
            ]), SimpleNamespace(language="en"))
            result = self.post(wav(amplitude=5000)).json()
            self.assertEqual(result, {"text": "Hello.", "language": "en", "segments": [{"start": 0.1, "end": 0.9, "text": "Hello."}]})
            self.assertIsNone(model.return_value.transcribe.call_args.kwargs["language"])

    def test_explicit_language(self):
        with patch("backend.speech.model") as model:
            model.return_value.supported_languages = ["en", "ja"]
            model.return_value.transcribe.return_value = (iter([]), SimpleNamespace(language="ja"))
            self.assertEqual(self.post(wav(amplitude=5000), "ja").json()["language"], "ja")
            self.assertEqual(model.return_value.transcribe.call_args.kwargs["language"], "ja")
            self.assertEqual(self.post(wav(amplitude=5000), "fr").status_code, 422)
            self.assertEqual(self.post(wav(amplitude=5000), "invalid").status_code, 422)


if __name__ == "__main__":
    unittest.main()
