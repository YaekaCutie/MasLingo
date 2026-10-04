// Pixel transport helpers.
//
// chrome.runtime.sendMessage serialises its payload as JSON, so a
// Uint8ClampedArray arrives on the other side as a plain object with numeric
// keys — silently, and with plausible-looking output rather than an error.
// (Observed: the engine received NaN pixels and "recognised" the wrong text.)
// Typed arrays do survive worker.postMessage, which uses structured clone, so
// only the service-worker -> offscreen hop needs encoding.

/** @returns {{width: number, height: number, base64: string}} */
export function encodeImageData(imageData) {
  const bytes = new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset,
    imageData.data.byteLength,
  );
  let binary = "";
  const chunk = 0x8000; // avoid blowing the argument limit of String.fromCharCode
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return { width: imageData.width, height: imageData.height, base64: btoa(binary) };
}

/** @returns {{data: Uint8ClampedArray, width: number, height: number}} */
export function decodeImageData({ width, height, base64 }) {
  const binary = atob(base64);
  const data = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    data[index] = binary.charCodeAt(index);
  }
  return { data, width, height };
}

/** Base64 for raw bytes (used for compressed payloads such as PNG). */
export function encodeBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function decodeBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Copy a half-open [left, top, right, bottom) box out of an RGBA image. */
export function cropImageData(image, left, top, right, bottom) {
  const boxWidth = Math.max(1, Math.min(image.width, right) - Math.max(0, left));
  const boxHeight = Math.max(1, Math.min(image.height, bottom) - Math.max(0, top));
  const fromX = Math.max(0, left);
  const fromY = Math.max(0, top);
  const data = new Uint8ClampedArray(boxWidth * boxHeight * 4);

  for (let y = 0; y < boxHeight; y += 1) {
    const sourceStart = ((fromY + y) * image.width + fromX) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + boxWidth * 4), y * boxWidth * 4);
  }
  return { data, width: boxWidth, height: boxHeight };
}

/** Same rule as the backend's _has_readable_text: at least 4 letters/digits. */
export function hasReadableText(text) {
  const matches = String(text).match(/[\p{L}\p{N}]/gu);
  return (matches ? matches.length : 0) >= 4;
}
