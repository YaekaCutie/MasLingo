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
PaddleOCR Japanese OCR
  ↓
Split multiple OCR lines
  ↓
ONE local Ollama vision request with OCR text + image
  ↓
JSON array preserving order
  ↓
Chrome overlay

Settings:
Options UI → chrome.storage.local
                     ↓
               background worker
                     ↓
          local backend request header

Security model:
- OCR and translation run locally; the image and text are not sent to a cloud API.
- The extension sends only the selected Ollama model name to the local FastAPI backend.
- Ollama listens on the local machine at `127.0.0.1:11434` by default.
