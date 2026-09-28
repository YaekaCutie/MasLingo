from fastapi import FastAPI, File, UploadFile, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from .image.decode import decode_image
from .ocr.paddle_ocr_engine import recognize
from .translation.ollama_vision_translator import DEFAULT_MODEL, OllamaError, test_connection, translate_batch

app = FastAPI(title="Manga Translator PaddleOCR + Ollama Vision Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.get("/health")
def health():
    return {"ok": True, "backend": "ready", "translation": "ollama-local-vision", "default_model": DEFAULT_MODEL}

@app.post("/api/test-ollama")
def test_ollama(x_ollama_model: str | None = Header(default=None)):
    try:
        return {"ok": True, **test_connection(x_ollama_model or DEFAULT_MODEL)}
    except OllamaError as e:
        raise HTTPException(503, str(e))

@app.post("/api/translate-image")
async def translate_image(
    image: UploadFile = File(...),
    x_ollama_model: str | None = Header(default=None)
):
    raw = await image.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "图片过大")

    try:
        img = decode_image(raw)
        items = recognize(img)
        model = x_ollama_model or DEFAULT_MODEL
        translations = translate_batch(items, img, model)
        return {
            "ok": True,
            "model": model,
            "requested_model": model,
            "items": translations
        }
    except OllamaError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))