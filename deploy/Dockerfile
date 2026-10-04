# syntax=docker/dockerfile:1

# Shared OCR backend for OpenMangaTranslator.
#
# Built on the target machine (works on both linux/amd64 and linux/arm64), so
# pip resolves the native wheels: torch, numpy, Pillow and fugashi all publish
# aarch64 wheels, and the remaining sdist (unidic-lite) is pure Python.

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    OMP_NUM_THREADS=4 \
    OMT_TORCH_THREADS=4 \
    OMT_OCR_CONCURRENCY=2

WORKDIR /app

# Dependencies first so the (slow) layer is cached across code changes.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip \
 && pip install -r /app/backend/requirements.txt

# Bake the MangaOCR weights into the image: the first user request must not
# wait for a multi-hundred-MB download, and the container then needs no
# outbound network at runtime.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base')"

COPY backend /app/backend

RUN useradd --create-home --uid 10001 omt \
 && chown -R omt:omt /app /models
USER omt

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]
