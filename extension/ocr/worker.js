// Dedicated worker that owns the OCR engine.
//
// Why a worker rather than the service worker itself: onnxruntime-web's wasm
// backend dynamically imports its glue module, and dynamic import() is
// disallowed on ServiceWorkerGlobalScope by the HTML specification (verified:
// it fails with exactly that TypeError). A dedicated worker is a real worker
// context where import() is allowed, so the model can live here and survive
// across service worker wake-ups only as long as the worker does — reloading
// costs ~0.6s, which is acceptable.
//
// All it does is: build the engine once, then answer recognition requests.
//
// Note: a dedicated worker does NOT get the `chrome.*` extension APIs injected
// (verified — `chrome is not defined`), so asset paths are resolved from
// import.meta.url instead of chrome.runtime.getURL().

import * as ort from "../vendor/ort/ort.wasm.min.mjs";
import { createOcrEngine, recognize } from "./engine.js";
import { cropImageData, hasReadableText } from "./pixels.js";
import { MAX_TEXT_REGIONS, detectTextRegions } from "./regions.js";

const MODEL_BASE = new URL("../models/", import.meta.url);
const ORT_BASE = new URL("../vendor/ort/", import.meta.url);

let enginePromise = null;

async function loadModelFile(name) {
  const url = new URL(name, MODEL_BASE);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    // A missing file inside the extension surfaces as a bare network error.
    throw new Error(
      `无法读取模型文件 ${name}（${error.message}）。请先运行 python tools/fetch_ocr_assets.py 再重新加载扩展。`,
    );
  }
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function warmUp() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const started = Date.now();
      const [encoder, decoder] = await Promise.all([
        loadModelFile("encoder.onnx"),
        loadModelFile("decoder.onnx"),
      ]);
      const engine = await createOcrEngine(ort, {
        encoder,
        decoder,
        numThreads: 1,
        wasmPaths: ORT_BASE.href,
      });
      return { engine, loadMs: Date.now() - started };
    })().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

self.addEventListener("message", async (event) => {
  const request = event.data || {};
  const reply = (payload) => self.postMessage({ id: request.id, ...payload });

  try {
    if (request.type === "WARMUP") {
      const { loadMs } = await warmUp();
      reply({ ok: true, loadMs });
      return;
    }
    if (request.type === "RECOGNIZE") {
      const { engine, loadMs } = await warmUp();
      const result = await recognize(engine, request.imageData);
      reply({ ok: true, text: result.text, ids: result.ids, milliseconds: result.milliseconds, loadMs });
      return;
    }
    if (request.type === "RECOGNIZE_PAGE") {
      // Whole-page mode: detect text regions, then OCR each one. The detector
      // is the JavaScript port of backend/ocr/bubble_detector.py, verified to
      // return identical boxes (tools/regions_parity_test.mjs).
      const detected = Date.now();
      const regions = detectTextRegions(request.imageData, MAX_TEXT_REGIONS);
      const detectMs = Date.now() - detected;

      const { engine, loadMs } = await warmUp();
      const items = [];
      const recognitions = [];
      for (const region of regions) {
        const crop = cropImageData(request.imageData, region.left, region.top, region.right, region.bottom);
        const result = await recognize(engine, crop);
        recognitions.push(result.milliseconds);
        const text = (result.text || "").trim();
        if (!hasReadableText(text)) continue; // drop visual noise, as the backend does
        items.push({ text, bbox: region });
      }
      reply({
        ok: true,
        items,
        regionCount: regions.length,
        detectMs,
        loadMs,
        milliseconds: recognitions.reduce((total, value) => total + value, 0),
      });
      return;
    }
    reply({ ok: false, error: `unknown request: ${request.type}` });
  } catch (error) {
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
});
