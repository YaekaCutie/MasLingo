// Extension page that runs the OCR engine on-device.
//
// This exists so the engine can be exercised inside a real Chrome with real
// WASM (see deploy/check-ondevice-ocr.mjs). The production wiring will be an
// offscreen document, because a Manifest V3 service worker is torn down after
// ~30s idle and loading a 111 MB model would be repeated constantly.
//
// Everything it needs is inside the package: the wasm runtime in vendor/ort
// and the int8 model in models/. Nothing is fetched from the network.

import { createOcrEngine, recognize } from "./engine.js";

const status = document.getElementById("status");
const preview = document.getElementById("preview");

function report(text) {
  status.textContent = text;
}

// Exposed so a test driver can await readiness and call into the engine.
const controller = {
  ready: null,
  timings: {},
  lastText: null,
  error: null,
};

async function loadModelFile(path) {
  const url = chrome.runtime.getURL(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function init() {
  const started = Date.now();
  const ort = globalThis.ort;
  if (!ort) throw new Error("onnxruntime-web did not load (vendor/ort missing?)");

  const wasmPaths = chrome.runtime.getURL("vendor/ort/");
  report("loading model weights…");

  const [encoder, decoder] = await Promise.all([
    loadModelFile("models/encoder.onnx"),
    loadModelFile("models/decoder.onnx"),
  ]);
  controller.timings.modelBytes = encoder.byteLength + decoder.byteLength;
  controller.timings.loadMs = Date.now() - started;

  report("creating sessions…");
  const sessionStarted = Date.now();
  const engine = await createOcrEngine(ort, {
    encoder,
    decoder,
    numThreads: 1,
    wasmPaths,
  });
  controller.timings.sessionMs = Date.now() - sessionStarted;

  controller.engine = engine;
  report(`ready in ${controller.timings.loadMs} ms (weights) + ${controller.timings.sessionMs} ms (sessions)`);
  return engine;
}

/** Load an image from inside the extension into ImageData. */
async function loadImageData(path) {
  const image = new Image();
  image.src = chrome.runtime.getURL(path);
  await image.decode();

  preview.width = image.naturalWidth;
  preview.height = image.naturalHeight;
  const context = preview.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, preview.width, preview.height);
}

controller.recognizePath = async (path) => {
  await controller.ready;
  const imageData = await loadImageData(path);
  const result = await recognize(controller.engine, imageData);
  controller.lastText = result.text;
  controller.timings.inferenceMs = result.milliseconds;
  controller.timings.tokens = result.ids.length;
  report(`text: ${result.text}\ninference: ${result.milliseconds} ms, ${result.ids.length} tokens`);
  return result;
};

controller.ready = init().catch((error) => {
  controller.error = String(error && error.message ? error.message : error);
  report(`error: ${controller.error}`);
  throw error;
});

globalThis.OMT_OCR = controller;
