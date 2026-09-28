# Architecture

Chrome Extension
  ↓
User selects region
  ↓
captureVisibleTab + crop
  ↓
POST multipart image + X-Ollama-Model
  ↓
Local FastAPI
  ↓
PaddleOCR detects ordered text regions
  ↓
MangaOCR recognizes Japanese text from each region
  ↓
One local Ollama text request with ordered OCR strings
  ↓
Validate JSON translations and preserve item order
  ↓
Chrome overlay

Settings:
Options UI → chrome.storage.local
                     ↓
               background worker
                     ↓
          local backend request header

Security model:
- OCR and translation run locally; images and text are not sent to a cloud API.
- The image is processed only by the local backend OCR pipeline and is not sent to Ollama.
- Ollama receives only OCR text and translation instructions.
- The extension sends only the selected Ollama model name to the local FastAPI backend.
- Ollama listens on the local machine at `127.0.0.1:11434` by default.

Limitations:
- Text-only translation cannot use visual context for character voice, names, or omitted phrases.
- OCR recognition order is right-to-left by region center, then top-to-bottom.
