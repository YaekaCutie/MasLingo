"""Optional, bounded local speech transcription for live video captions."""
import asyncio
import io
import os
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

router = APIRouter()
MAX_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 12
_slot = asyncio.Lock()


@lru_cache(maxsize=1)
def model():
    from faster_whisper import WhisperModel
    return WhisperModel(
        os.getenv("MAS_SPEECH_MODEL", "base"), device="cpu", compute_type="int8",
        cpu_threads=max(1, int(os.getenv("MAS_SPEECH_THREADS", "2"))),
        download_root=os.getenv("MAS_SPEECH_CACHE", ".hf/speech"),
    )


def decode(data):
    """Stop decoding at the duration bound, including malicious containers."""
    import av
    chunks = []
    total = 0
    try:
        with av.open(io.BytesIO(data)) as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in container.decode(audio=0):
                if frame.samples / frame.sample_rate > MAX_SECONDS:
                    raise HTTPException(413, "音频片段不能超过 12 秒")
                for sample in resampler.resample(frame):
                    total += sample.samples
                    if total > MAX_SECONDS * 16000:
                        raise HTTPException(413, "音频片段不能超过 12 秒")
                    chunks.append(sample.to_ndarray().flatten())
            for sample in resampler.resample(None):
                total += sample.samples
                if total > MAX_SECONDS * 16000:
                    raise HTTPException(413, "音频片段不能超过 12 秒")
                chunks.append(sample.to_ndarray().flatten())
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(415, "无法读取音频片段") from error
    if not chunks:
        raise HTTPException(400, "音频为空")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(data, language=None):
    samples = decode(data)
    if np.max(np.abs(samples)) < 0.002:
        return {"text": "", "segments": [], "language": ""}
    recognizer = model()
    if language and language not in recognizer.supported_languages:
        raise HTTPException(422, "当前语音模型不支持选择的源语言")
    segments, info = recognizer.transcribe(
        samples, language=language, beam_size=1, vad_filter=True, condition_on_previous_text=False,
        vad_parameters={"min_silence_duration_ms": 350},
    )
    result = [{"start": s.start, "end": s.end, "text": s.text.strip()}
              for s in segments if s.text.strip() and s.no_speech_prob < 0.7]
    return {"text": " ".join(s["text"] for s in result), "segments": result, "language": info.language}


@router.post("/api/transcribe-audio")
async def transcribe_audio(
    audio: UploadFile = File(...), language: str | None = Form(None, pattern=r"^[a-z]{2,3}$")
):
    if os.getenv("MAS_ENABLE_SPEECH", "0") != "1":
        raise HTTPException(503, "语音识别未启用：安装 backend/requirements-speech.txt 并设置 MAS_ENABLE_SPEECH=1")
    data = await audio.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "音频片段不能超过 2 MB")
    if not data:
        raise HTTPException(400, "音频为空")
    # Do not accumulate a stale queue on slow CPUs or shared deployments.
    if _slot.locked():
        raise HTTPException(429, "语音识别繁忙，请稍后重试")
    async with _slot:
        try:
            return await run_in_threadpool(transcribe, data, language)
        except HTTPException:
            raise
        except ImportError as error:
            raise HTTPException(503, "请安装 backend/requirements-speech.txt 后重启后端") from error
        except Exception as error:
            raise HTTPException(503, "语音模型加载或识别失败，请检查模型缓存及后端日志") from error
