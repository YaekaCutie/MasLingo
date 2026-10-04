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
