---
title: MasLingo OCR
emoji: 📖
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 8001
pinned: false
---

# MasLingo OCR backend

Shared OCR backend for the [MasLingo](https://github.com/YaekaCutie/MasLingo)
browser extension. It runs MangaOCR on CPU and exposes a small FastAPI surface:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness plus current OCR concurrency (always exempt from rate limiting) |
| POST | `/api/recognize-image` | OCR one cropped region |
| POST | `/api/recognize-page` | Detect text regions in a screenshot, then OCR each |
| POST | `/api/translate-text` | `none` (echo) / `free-translate` / `openai-compatible` |

## Privacy

Images are used only to produce OCR text for the request that carried them.
Request bodies are not logged and images are not persisted. Translation is
opt-in per request; when enabled, the recognized text is forwarded to the
service the client selected.

## Configuration

Set these as Space variables (Settings → Variables and secrets):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAS_RATE_LIMIT_REQUESTS` | `0` (off) | Requests per IP per window |
| `MAS_RATE_LIMIT_WINDOW` | `60` | Window length in seconds |
| `MAS_OCR_CONCURRENCY` | `2` | OCR jobs allowed at once |
| `MAS_TORCH_THREADS` | `0` (all cores) | Threads per OCR job |
| `MAS_ENABLE_FREE_TRANSLATE` | `1` | Set `0` to refuse the shared Google endpoint |
| `MAS_PRELOAD_MODEL` | `1` | Load the model at startup |
| `MAS_ALLOWED_ORIGINS` | `*` | CORS origins, comma separated |

This Space is a thin wrapper; the source of truth is the repository above.
