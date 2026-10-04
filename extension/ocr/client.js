// Service-worker-side façade over the on-device OCR engine.
//
// The engine cannot run here (see ocr/offscreen.html for the two spec reasons),
// so this module creates the offscreen document on demand and forwards work to
// it. Every failure path rejects, and the caller falls back to the backend.

import { encodeImageData } from "./pixels.js";

const OFFSCREEN_PATH = "ocr/offscreen.html";

let ready = null;
let state = { state: "idle", error: null, lastMs: null, loadMs: null, recognitions: 0 };

export function getOcrStatus() {
  return { ...state };
}

async function hasOffscreen() {
  if (!chrome.offscreen?.hasDocument) return false;
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // Literally what the document does: it spawns the OCR worker.
    reasons: ["WORKERS"],
    justification:
      "在本地运行 OCR 模型：MV3 的 service worker 既不能动态 import（onnxruntime-web 的 wasm 后端需要），也不能创建 Worker，因此必须在 offscreen document 里托管识别 worker。识别在用户设备上完成，截图不会离开本机。",
  });
}

function send(type, payload = {}, { allowCreate = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "offscreen", type, ...payload }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response) {
        reject(new Error("offscreen 无响应"));
        return;
      }
      resolve(response);
    });
  });
}

/** Create the offscreen document and load the model ahead of the first request. */
export function warmUp() {
  if (!ready) {
    ready = (async () => {
      state = { ...state, state: "loading", error: null };
      await ensureOffscreen();
      // The document may still be evaluating its script, so retry briefly
      // rather than failing the user's first recognition.
      let lastError = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        let response;
        try {
          response = await send("OCR_WARMUP");
        } catch (error) {
          // The document is still starting up; that is worth retrying.
          lastError = error;
          await new Promise((done) => setTimeout(done, 250));
          continue;
        }
        if (!response.ok) {
          // The worker answered and reported a real failure (missing assets,
          // wasm not supported, …). Retrying cannot help, and the user is
          // waiting, so surface it immediately.
          throw new Error(response.error || "端上 OCR 初始化失败");
        }
        state = { ...state, state: "ready", loadMs: response.loadMs ?? null };
        return response;
      }
      throw lastError || new Error("offscreen 未就绪");
    })().catch((error) => {
      ready = null; // allow a retry on the next recognition
      state = { ...state, state: "failed", error: String(error?.message || error) };
      throw error;
    });
  }
  return ready;
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {Promise<{text: string, ids: number[], milliseconds: number}>}
 */
export async function recognizeImageData(imageData) {
  await warmUp();
  const encoded = encodeImageData(imageData);
  const response = await send("OCR_RECOGNIZE", { imageData: encoded });
  if (!response.ok) {
    state = { ...state, state: "failed", error: response.error };
    throw new Error(response.error || "端上识别失败");
  }
  state = {
    ...state,
    state: "ready",
    lastMs: response.milliseconds ?? null,
    loadMs: response.loadMs ?? state.loadMs,
    recognitions: state.recognitions + 1,
  };
  return { text: response.text, ids: response.ids || [], milliseconds: response.milliseconds };
}

/**
 * Whole-page recognition on-device: detect text regions, then OCR each.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {Promise<{items: Array<{text: string, bbox: object}>, regionCount: number, detectMs: number, milliseconds: number}>}
 */
export async function recognizePageImageData(imageData) {
  await warmUp();
  const encoded = encodeImageData(imageData);
  const response = await send("OCR_RECOGNIZE_PAGE", { imageData: encoded });
  if (!response.ok) {
    state = { ...state, state: "failed", error: response.error };
    throw new Error(response.error || "端上整页识别失败");
  }
  state = {
    ...state,
    state: "ready",
    lastMs: response.milliseconds ?? null,
    loadMs: response.loadMs ?? state.loadMs,
    recognitions: state.recognitions + (response.items?.length || 0),
  };
  return response;
}
