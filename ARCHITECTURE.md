# Architecture

Chrome Extension
  ↓
User selects region
  ↓
captureVisibleTab + crop
  ↓
POST multipart image
  ↓
Local FastAPI
  ↓
MangaOCR recognizes Japanese text from the selected region
  ↓
Return recognized text to the extension
  ↓
Chrome overlay

Settings:
Options UI → chrome.storage.local
                     ↓
               background worker
                     ↓
          local backend request header

Security model:
- OCR runs locally; images are sent only to the local FastAPI process.
- No cloud API, model server, API key, or external translation service is required.

Limitations:
- Each selected region is recognized as a single text item; the user should select one text area at a time.
- MangaOCR recognizes text but does not translate or redraw the original image.
