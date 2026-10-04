# Space-specific variant of deploy/Dockerfile.
#
# Differences from the main image, and why:
#   * it lives at the Space repository root, because the Hugging Face Docker
#     SDK only looks for ./Dockerfile;
#   * it does not pin USER to a custom uid, because Spaces run containers under
#     a platform-assigned user (commonly uid 1000) and a mismatched owner makes
#     the model cache unwritable at runtime.
#
# Keep this in sync with deploy/Dockerfile when the backend changes.

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    OMP_NUM_THREADS=2 \
    OMT_TORCH_THREADS=1 \
    OMT_OCR_CONCURRENCY=2 \
    OMT_PRELOAD_MODEL=1

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip \
 && pip install -r /app/backend/requirements.txt

# Bake the weights in so a cold start only has to load them, not download them.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base')"

COPY backend /app/backend

# Spaces may run the container as uid 1000; make both trees writable by it.
RUN chmod -R 777 /app /models

EXPOSE 8001

CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]
