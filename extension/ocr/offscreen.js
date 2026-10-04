// Offscreen document that hosts the OCR worker and relays service-worker
// requests to it. See offscreen.html for why the work cannot happen in the
// service worker itself.
//
// Protocol (from the service worker via chrome.runtime.sendMessage):
//   { target: "offscreen", type: "OCR_WARMUP" }                -> { ok, loadMs }
//   { target: "offscreen", type: "OCR_RECOGNIZE", imageData }  -> { ok, text, ... }
// Every reply carries the request id so the caller can match it up.

import { decodeBytes, decodeImageData } from "./pixels.js";

const worker = new Worker(chrome.runtime.getURL("ocr/worker.js"), { type: "module" });

let nextId = 1;
const pending = new Map();

worker.addEventListener("message", (event) => {
  const { id } = event.data || {};
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry(event.data);
});

worker.addEventListener("error", (event) => {
  const message = event.message || "识别 worker 出错";
  for (const entry of pending.values()) entry({ ok: false, error: message });
  pending.clear();
});

function askWorker(type, payload = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ id, type, ...payload });
  });
}

/** PNG bytes -> RGBA pixels. This document context has the decoding APIs. */
async function decodePng(base64) {
  const blob = new Blob([decodeBytes(base64)], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return imageData;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return undefined;

  if (message.type === "OCR_WARMUP") {
    askWorker("WARMUP").then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (message.type === "OCR_RECOGNIZE") {
    // The service worker had to base64 the pixels; worker.postMessage below is
    // structured clone, so the typed array survives that hop.
    const imageData = decodeImageData(message.imageData);
    askWorker("RECOGNIZE", { imageData }).then(sendResponse);
    return true;
  }
  if (message.type === "OCR_RECOGNIZE_PAGE") {
    // Whole-page payloads arrive as PNG rather than raw RGBA: a manga page is
    // ~6 MB of pixels but a few hundred KB compressed, and this hop goes
    // through JSON serialisation, where that difference is seconds.
    decodePng(message.png).then((imageData) => askWorker("RECOGNIZE_PAGE", { imageData })).then(sendResponse);
    return true;
  }
  return undefined;
});

// Tell the service worker we are up, so it does not have to guess when the
// freshly created document becomes responsive.
chrome.runtime.sendMessage({ target: "service-worker", type: "OFFSCREEN_READY" }).catch(() => {
  // Nobody listening yet is fine.
});
