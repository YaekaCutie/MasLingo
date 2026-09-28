from fastapi import FastAPI, File, UploadFile, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from .image.decode import decode_image
from .ocr.manga_ocr_engine import recognize
from .translation.gemini_translator import translate_batch, test_model, GeminiError

DEFAULT_MODEL = "gemini-3.8-flash"

app = FastAPI(title="Manga Translator Gemini Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.get("/health")
def health():
    return {"ok": True, "backend": "ready", "default_model": DEFAULT_MODEL}

@app.post("/api/test-gemini")
def test_gemini(
    x_gemini_api_key: str | None = Header(default=None),
    x_gemini_model: str | None = Header(default=None)
):
    try:
        return {"ok": True, **test_model(
            x_gemini_api_key or "",
            x_gemini_model or DEFAULT_MODEL
        )}
    except GeminiError as e:
        raise HTTPException(502, str(e))

@app.post("/api/translate-image")
async def translate_image(
    image: UploadFile = File(...),
    x_gemini_api_key: str | None = Header(default=None),
    x_gemini_model: str | None = Header(default=None),
    x_gemini_auto_fallback: bool = Header(default=True)
):
    if not x_gemini_api_key:
        raise HTTPException(401, "未配置 Gemini API Key")
    raw = await image.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "图片过大")

    try:
        img = decode_image(raw)
        text = recognize(img).strip()
        items = [x.strip() for x in text.splitlines() if x.strip()]
        model = x_gemini_model or DEFAULT_MODEL
        translations, used_model = translate_batch(
            items, x_gemini_api_key, model, image=img,
            auto_fallback=x_gemini_auto_fallback
        )
        return {
            "ok": True,
            "model": used_model,
            "requested_model": model,
            "fallback_used": used_model != model,
            "items": translations
        }
    except GeminiError as e:
        raise HTTPException(502, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))