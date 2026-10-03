# Architecture

## OCR flow

Chrome Extension
  ↓
User selects a region OR requests automatic visible-page recognition
  ↓
`captureVisibleTab` (plus crop for manual selection)
  ↓
Automatic: crop the largest visible image/canvas/video/background-image when it
occupies at least 8% and less than 80% of the viewport; otherwise fail and ask
the user to select the manga region manually rather than OCR page UI
  ↓
POST multipart image to local FastAPI
  ↓
Manual: MangaOCR recognizes the selected region
Automatic: local Pillow/NumPy dark/light text-ink grouping → MangaOCR per region.
Bright-ink candidates require a dark neighborhood, and tall vertical regions
retain additional horizontal context within the candidate-area limit.
  ↓
Chrome keeps a local screenshot crop for each OCR region. When translation is
enabled, it estimates the text-area background from nearby pixels, repairs the
original lettering in that crop, then draws fitted Chinese text onto a
transparent canvas aligned over the original image. This is an approximation,
not semantic bubble segmentation or full content-aware inpainting.

## Translation configuration

Options UI stores the mode and endpoint/model settings in `chrome.storage.local`.
An optional API key is also stored only in Chrome local extension storage. The
background worker sends the selected mode and settings to the loopback FastAPI
translation endpoint. The backend does not persist the key; in
`openai-compatible` mode it forwards the request to the configured endpoint.

Translation modes:

- `none` (default): return OCR text unchanged; no translation service request.
- `openai-compatible`: configured Chat Completions endpoint (local or remote).
- `free-translate`: existing free Google Translate interface, enabled only by
  an explicit user choice.

## Security model and limitations

- OCR and text-region grouping run locally; page screenshots go only to local
  FastAPI.
- Cloud translation is not part of the default OCR flow. Selecting a remote
  translator sends recognized text and, when provided, its key to that service.
- Automatic detection covers only the currently visible viewport. It groups
  nearby dark or light lettering heuristically, not semantic balloon contours,
  caps ink-group boxes at 5% of the input image area, and separately proposes
  up to 18%-area crops for enclosed light speech balloons with sufficient ink.
  It may miss or merge regions on complex pages. The extension prioritizes a
  dominant visible image/canvas/video element to exclude unrelated page UI and
  thumbnails.
- Existing result overlays are removed before the next capture so previous OCR
  results cannot contaminate subsequent screenshots.
- Direction detection compares both contrast polarities before deciding
  horizontal versus vertical layout; vertical columns are read right-to-left.
- OpenAI-compatible translation receives all OCR items together with manga
  localization instructions so the model can use neighboring lines as context.
- Manual selection remains available for difficult pages. The extension does
  not erase original text or redraw translations into the image.
