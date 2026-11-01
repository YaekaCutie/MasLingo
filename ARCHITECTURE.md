# Architecture

## Automatic manga translation

1. Content scripts discover visible or nearby images/canvases and obtain their original pixels.
2. Images wider than 1600px are reduced by width. Long images are sent as overlapping bands, each at most 1600px high after scaling, so their text is not shrunk to fit the full strip height.
3. The local backend runs the pinned comic text detector with ONNX Runtime (CPU). It retains RGB colour information and groups the unexpanded DB line rectangles by spacing before recovering glyph fringes. This splits coarse blocks that span separate balloons or paragraphs. Glyph evidence bounds the OCR margins, keeping nearby balloon outlines out of small-kana crops.
4. MangaOCR reads each group. A rejected Japanese reading from a neural crop gets one retry with two extra pixels of OCR context; this does not enlarge the erasure rectangle or relax confidence filtering. Overlapping bands are deduplicated before translation.
5. The backend estimates repair risk from local texture and glyph-mask coverage. Flat backgrounds use their local colour; smooth gradients use OpenCV inpainting inside the glyph mask. A bounded, flat balloon interior can override texture contributed by its outline, while constraining the repair to its interior. The response contains a transparent repair PNG and its exact rectangle. Textured or uncertain regions return no repair image and carry `safe: false`; this is a conservative heuristic, not a guarantee of reconstruction quality.
6. The configured provider translates the batch. The extension anchors the repair and translated text to the original image, retaining fractional CSS coordinates. For uncertain repairs it preserves the original lettering and shows a collapsible translation beside it. Captions prefer image gutters, avoid other text, and support pointer dragging or keyboard movement with a numbered source marker, source highlight and connector. Font size and grid are fitted together; automatic manga prefers vertical layout when text wraps, rotating dashes but retaining the Han numeral 一. Source changes invalidate old results; stopping cancels pending startup/settings reads and prevents follow-up translation requests and late painting.

Manual selection and the one-shot visible-page action capture the active tab. An inactive sender, a tab switched during capture, or an iframe requesting screenshot fallback is rejected. Manual single-region OCR retains the browser pixel-mask renderer; automatic image translation uses the backend repair layer.

## Local runtime

`setup-local.ps1` creates the Windows environment, installs CPU dependencies, and initializes both models. `start-backend.ps1` starts from the repository directory and listens on loopback. Failed model preload fails startup, rather than presenting a healthy endpoint with unusable OCR.

The detector weights are downloaded once and validated by SHA-256. `MAS_TEXT_DETECTOR_MODEL` selects a predownloaded copy; `MAS_TEXT_DETECTOR=heuristic` opts into the legacy Pillow/NumPy detector. Model source and notices are in `THIRD_PARTY_NOTICES.md`.

## Translation and data

Translation is off by default. Most providers are called directly by the extension; the backend provider uses `/api/translate-text`. Settings and optional keys are in `chrome.storage.local`. The source checkout has no hosted OCR URL and falls back to loopback. Configuring a remote OCR backend sends image pixels to that destination. Choosing a remote translator sends recognized text to that provider.

Manga OCR has a known Japanese source language. Kanji-only strings such as `用事` and `若様` must therefore reach the translator instead of being guessed as Chinese and skipped. Webpage translation with an automatic source still suppresses text already in the target language; an explicitly identical source and target is also skipped.

The OCR backend does not persist request images or log recognized text. Repair layers contain only repaired pixels; unmasked artwork stays transparent and remains supplied by the page.

## Limits and validation

MangaOCR is Japanese-only and may invent Japanese from non-Japanese watermarks. Small text, unusual layouts, textured art and mask errors remain possible. Reconstruction cannot recover the original detail hidden behind printed text. Ordinary dialogue and narration are the target; sound effects and artistic lettering are outside the acceptance scope.

`tools/evaluate_text_pipeline.py` generates labelled colour, dark, gradient, embedded and vertical fixtures, then measures detector coverage, residual text error and background changes. `tools/evaluate_repair_policy.py` isolates repair risk using known clean backgrounds and exact glyph masks. `deploy/check-auto-lifecycle.mjs` verifies actual DOM/canvas rendering, image changes, stopping, bounded retries, long-image bands, and adjacent captions with scrolling, pointer interaction and narrow layouts. `deploy/check-japanese-ocr-translation.mjs` exercises production service-worker handlers for kanji-only Japanese and same-language web text. Backend unit tests run without models or network. Testing a loaded extension on Windows remains separate from these checks.

`tools/evaluate_manga_pages.py page.jpg --out /tmp/manga-review` exercises the running local OCR HTTP endpoint on real local images. It saves full responses, numbered detection boxes, individual crops and an erasure-only composite for inspection without calling a translation provider. Keep private originals and generated results outside the repository.
