# Architecture

Chrome Extension
  ↓
User selects region
  ↓
captureVisibleTab + crop
  ↓
POST multipart image + X-Gemini-API-Key + X-Gemini-Model
  ↓
Local FastAPI
  ↓
Manga OCR
  ↓
Split multiple OCR lines
  ↓
ONE Gemini generateContent request
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
- API Key is not hard-coded in extension source.
- API Key is not stored in backend/.env by default.
- Backend receives the key per request and forwards it to Google.
