// On-device text-region detection: a port of backend/ocr/bubble_detector.py.
//
// Without this, "auto-detect the page" is the one feature that still needs the
// backend, which would mean the extension is only truly install-and-use for
// manual selection. The port is deliberate rather than a reinvention so that
// on-device results match what the server produced; tools/regions_parity_test.mjs
// compares the two box-for-box.
//
// Algorithm (unchanged from the Python original):
//   1. downscale to at most 1600px, grayscale
//   2. build four ink masks: solid dark, solid light, and local-contrast
//      variants in both polarities
//   3. erode by 3 to drop isolated panel strokes, then dilate to join glyph
//      strokes into components
//   4. keep components that look like text (size, area, ink density)
//   5. merge boxes that share a reading line, pad, and de-duplicate
//   6. separately propose closed light speech balloons as whole-bubble crops

import { resampleGray } from "./engine.js";

export const MAX_TEXT_REGIONS = 24;
const MAX_REGION_AREA_RATIO = 0.05;
const MAX_DARK_TEXT_CONTEXT_AREA_RATIO = 0.08;
const DETECTION_MAX_SIDE = 1600;

/**
 * Separable min/max (erode/dilate) filter with a square kernel.
 *
 * Uses a monotonic deque so the cost is O(pixels) rather than O(pixels ×
 * radius). The contrast kernel reaches radius 15 on a 1600px page, and the
 * naive version made this the single slowest part of whole-page detection
 * (3.4s of an 8.9s run). Results are identical either way: the window is
 * clipped at the borders exactly as before.
 */
function minMaxFilter(source, width, height, radius, wantMaximum) {
  if (radius <= 0) return source;
  const horizontal = new Uint8Array(width * height);
  const result = new Uint8Array(width * height);
  const deque = new Int32Array(Math.max(width, height));
  // `>=` / `<=` pop equal values so the deque always holds the newest index.
  const outranks = wantMaximum ? (a, b) => a >= b : (a, b) => a <= b;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let x = 0; x < width; x += 1) {
      const upto = Math.min(width - 1, x + radius);
      while (next <= upto) {
        const value = source[row + next];
        while (tail > head && outranks(value, source[row + deque[tail - 1]])) tail -= 1;
        deque[tail] = next;
        tail += 1;
        next += 1;
      }
      const from = x - radius;
      while (deque[head] < from) head += 1;
      horizontal[row + x] = source[row + deque[head]];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let y = 0; y < height; y += 1) {
      const upto = Math.min(height - 1, y + radius);
      while (next <= upto) {
        const value = horizontal[next * width + x];
        while (tail > head && outranks(value, horizontal[deque[tail - 1] * width + x])) tail -= 1;
        deque[tail] = next;
        tail += 1;
        next += 1;
      }
      const from = y - radius;
      while (deque[head] < from) head += 1;
      result[y * width + x] = horizontal[deque[head] * width + x];
    }
  }

  return result;
}

/**
 * Connected components over a boolean mask, using the same row-run + union-find
 * approach as the Python original. Boxes are half-open: [left, top, right, bottom).
 */
function connectedComponents(mask, width, height) {
  const parents = [];
  const boxes = [];
  let previous = [];

  const root = (label) => {
    while (parents[label] !== label) {
      parents[label] = parents[parents[label]];
      label = parents[label];
    }
    return label;
  };

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const runs = [];
    let x = 0;
    while (x < width) {
      if (!mask[row + x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < width && mask[row + x]) x += 1;
      runs.push([start, x]);
    }

    const current = [];
    let previousIndex = 0;
    for (const [start, end] of runs) {
      while (previousIndex < previous.length && previous[previousIndex][1] < start) {
        previousIndex += 1;
      }
      const overlaps = [];
      let scan = previousIndex;
      while (scan < previous.length && previous[scan][0] <= end) {
        overlaps.push(root(previous[scan][2]));
        scan += 1;
      }

      let label;
      if (overlaps.length > 0) {
        label = overlaps[0];
        for (const other of overlaps.slice(1)) {
          const otherRoot = root(other);
          const labelRoot = root(label);
          if (otherRoot !== labelRoot) {
            parents[otherRoot] = labelRoot;
            const merged = boxes[labelRoot];
            const incoming = boxes[otherRoot];
            merged[0] = Math.min(merged[0], incoming[0]);
            merged[1] = Math.min(merged[1], incoming[1]);
            merged[2] = Math.max(merged[2], incoming[2]);
            merged[3] = Math.max(merged[3], incoming[3]);
          }
        }
        label = root(label);
        const box = boxes[label];
        box[0] = Math.min(box[0], start);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], end);
        box[3] = Math.max(box[3], y + 1);
      } else {
        label = parents.length;
        parents.push(label);
        boxes.push([start, y, end, y + 1]);
      }
      current.push([start, end, label]);
    }
    previous = current;
  }

  const unique = new Map();
  boxes.forEach((box, index) => {
    const label = root(index);
    const existing = unique.get(label);
    if (!existing) {
      unique.set(label, [box[0], box[1], box[2], box[3]]);
      return;
    }
    existing[0] = Math.min(existing[0], box[0]);
    existing[1] = Math.min(existing[1], box[1]);
    existing[2] = Math.max(existing[2], box[2]);
    existing[3] = Math.max(existing[3], box[3]);
  });
  return [...unique.values()];
}

/** Mirrors _share_text_line in the Python original. */
function shareTextLine(first, second) {
  const [leftA, topA, rightA, bottomA] = first;
  const [leftB, topB, rightB, bottomB] = second;
  const widthA = rightA - leftA;
  const heightA = bottomA - topA;
  const widthB = rightB - leftB;
  const heightB = bottomB - topB;

  const overlapX = Math.max(0, Math.min(rightA, rightB) - Math.max(leftA, leftB));
  const overlapY = Math.max(0, Math.min(bottomA, bottomB) - Math.max(topA, topB));
  const gapX = Math.max(0, Math.max(leftA, leftB) - Math.min(rightA, rightB));
  const gapY = Math.max(0, Math.max(topA, topB) - Math.min(bottomA, bottomB));
  const scaleRatio = Math.max(
    widthA / widthB,
    widthB / widthA,
    heightA / heightB,
    heightB / heightA,
  );

  const sameReadingLine =
    scaleRatio <= 2.0 &&
    gapX <= Math.max(12, Math.round(Math.min(heightA, heightB) * 0.12)) &&
    overlapY / Math.min(heightA, heightB) >= 0.3;

  const minimumWidth = Math.min(widthA, widthB);
  const horizontalSegments = widthA >= heightA * 0.9 && widthB >= heightB * 0.9;
  const verticalGapFactor = minimumWidth >= 50 && horizontalSegments ? 1.4 : 0.3;
  const sameVerticalBlock =
    scaleRatio <= 2.5 &&
    gapY <= Math.max(12, Math.round(minimumWidth * verticalGapFactor)) &&
    overlapX / Math.min(widthA, widthB) >= 0.55;

  return sameReadingLine || sameVerticalBlock;
}

function overlaps(candidate, existing) {
  const [left, top, right, bottom] = candidate;
  const [eLeft, eTop, eRight, eBottom] = existing;
  const width = Math.max(0, Math.min(right, eRight) - Math.max(left, eLeft));
  const height = Math.max(0, Math.min(bottom, eBottom) - Math.max(top, eTop));
  return width * height;
}

const areaOf = ([left, top, right, bottom]) => (right - left) * (bottom - top);

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image RGBA
 * @param {number} limit
 * @returns {Array<{left: number, top: number, right: number, bottom: number}>} source-image pixels
 */
export function detectTextRegions(image, limit = MAX_TEXT_REGIONS) {
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  if (!sourceWidth || !sourceHeight) return [];

  const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  // Grayscale, then downscale (the Python original resizes and converts in one go).
  const fullGray = new Float32Array(sourceWidth * sourceHeight);
  for (let index = 0; index < fullGray.length; index += 1) {
    const offset = index * 4;
    fullGray[index] =
      (image.data[offset] * 299 + image.data[offset + 1] * 587 + image.data[offset + 2] * 114) / 1000;
  }
  const resized = resampleGray(fullGray, sourceWidth, sourceHeight, width, height);
  const gray = Uint8Array.from(resized, (value) => Math.max(0, Math.min(255, Math.round(value))));

  const contrastKernel = Math.max(11, Math.min(31, (Math.round(Math.max(width, height) / 40) | 1)));
  const contrastRadius = (contrastKernel - 1) / 2;
  const localMaximum = minMaxFilter(gray, width, height, contrastRadius, true);
  const localMinimum = minMaxFilter(gray, width, height, contrastRadius, false);

  const maskLength = width * height;
  const inkMasks = [];
  const push = (predicate) => {
    const mask = new Uint8Array(maskLength);
    for (let index = 0; index < maskLength; index += 1) mask[index] = predicate(index) ? 1 : 0;
    inkMasks.push(mask);
  };
  push((i) => gray[i] < 185);
  push((i) => gray[i] > 235);
  push((i) => localMaximum[i] - gray[i] > 36 && gray[i] >= 40 && gray[i] < 235);
  push((i) => gray[i] - localMinimum[i] > 36 && gray[i] > 20 && gray[i] <= 235);

  const radius = Math.max(4, Math.min(5, Math.round(Math.max(width, height) / 500)));
  const kernel = (radius + 2) * 2 + 1;
  const dilationRadius = (kernel - 1) / 2;

  const candidates = [];
  const bubbleCandidates = [];
  const minimumInk = Math.max(16, Math.round(width * height * 0.000004));

  // Whole light balloons, kept separate from the morphology grouping so that
  // large illustration areas stay excluded.
  const lightMask = new Uint8Array(maskLength);
  for (let index = 0; index < maskLength; index += 1) lightMask[index] = gray[index] > 230 ? 1 : 0;
  for (const [left, top, right, bottom] of connectedComponents(lightMask, width, height)) {
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    const boxArea = boxWidth * boxHeight;
    if (boxWidth < 24 || boxHeight < 24) continue;
    if (boxArea < width * height * 0.015 || boxArea > width * height * 0.18) continue;
    if (!(boxWidth / boxHeight >= 0.35 && boxWidth / boxHeight <= 1.7)) continue;

    let darkInkCount = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (gray[y * width + x] < 185) darkInkCount += 1;
      }
    }
    const darkInkRatio = darkInkCount / boxArea;
    if (darkInkCount < minimumInk) continue;
    if (!(darkInkRatio >= 0.02 && darkInkRatio <= 0.7)) continue;
    bubbleCandidates.push([left, top, right, bottom, darkInkCount]);
  }

  inkMasks.forEach((ink, maskIndex) => {
    // Erode by 3 to drop isolated strokes, then dilate to join glyphs.
    const eroded = minMaxFilter(ink, width, height, 1, false);
    const dilated = minMaxFilter(eroded, width, height, dilationRadius, true);
    const grouped = new Uint8Array(maskLength);
    for (let index = 0; index < maskLength; index += 1) grouped[index] = dilated[index] > 0.5 ? 1 : 0;

    for (const [left, top, right, bottom] of connectedComponents(grouped, width, height)) {
      const boxWidth = right - left;
      const boxHeight = bottom - top;
      const boxArea = boxWidth * boxHeight;
      if (boxWidth < 8 || boxHeight < 8) continue;
      if (boxWidth > width * 0.92 || boxHeight > height * 0.92) continue;
      if (boxArea > width * height * MAX_REGION_AREA_RATIO) continue;

      let inkCount = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          if (ink[y * width + x]) inkCount += 1;
        }
      }
      if (inkCount < minimumInk) continue;
      if (inkCount / boxArea > 0.78) continue;

      if (maskIndex === 1) {
        let dark = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            if (gray[y * width + x] < 185) dark += 1;
          }
        }
        if (dark / boxArea < 0.35) continue;
      }

      const padding = Math.max(2, Math.round(Math.min(boxWidth, boxHeight) * 0.08));
      candidates.push([
        Math.max(0, left - padding),
        Math.max(0, top - padding),
        Math.min(width, right + padding),
        Math.min(height, bottom + padding),
        inkCount,
      ]);
    }
  });

  // Keep the most text-like boxes, then group those sharing a reading line.
  candidates.sort((a, b) => b[4] - a[4]);
  const uniqueCandidates = [];
  for (const candidate of candidates) {
    const area = areaOf(candidate);
    let duplicate = false;
    for (const existing of uniqueCandidates) {
      if (overlaps(candidate, existing) / Math.min(area, areaOf(existing)) > 0.65) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    uniqueCandidates.push(candidate);
    if (uniqueCandidates.length === limit) break;
  }

  const parents = uniqueCandidates.map((_, index) => index);
  const root = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  uniqueCandidates.forEach((candidate, index) => {
    for (let other = 0; other < index; other += 1) {
      if (shareTextLine(candidate, uniqueCandidates[other])) {
        parents[root(index)] = root(other);
      }
    }
  });

  const groups = new Map();
  uniqueCandidates.forEach((candidate, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  });

  const grouped = [];
  for (const group of groups.values()) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    let inkTotal = 0;
    for (const [gLeft, gTop, gRight, gBottom, inkCount] of group) {
      left = Math.min(left, gLeft);
      top = Math.min(top, gTop);
      right = Math.max(right, gRight);
      bottom = Math.max(bottom, gBottom);
      inkTotal += inkCount;
    }
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    if (boxWidth * boxHeight > width * height * MAX_REGION_AREA_RATIO) continue;

    const tallTextBlock = boxHeight > boxWidth * 1.5;
    let paddingX = Math.max(2, Math.round(boxWidth * (tallTextBlock ? 0.46 : 0.22)));
    let paddingY = Math.max(2, Math.round(boxHeight * (tallTextBlock ? 0.02 : 0.22)));
    if (
      (boxWidth + 2 * paddingX) * (boxHeight + 2 * paddingY) >
      width * height * MAX_REGION_AREA_RATIO
    ) {
      let lower = 0;
      let upper = 1;
      for (let step = 0; step < 20; step += 1) {
        const ratio = (lower + upper) / 2;
        const scaledX = Math.round(paddingX * ratio);
        const scaledY = Math.round(paddingY * ratio);
        const paddedArea = (boxWidth + 2 * scaledX) * (boxHeight + 2 * scaledY);
        if (paddedArea <= width * height * MAX_REGION_AREA_RATIO) lower = ratio;
        else upper = ratio;
      }
      paddingX = Math.round(paddingX * lower);
      paddingY = Math.round(paddingY * lower);
    }
    grouped.push([
      Math.max(0, left - paddingX),
      Math.max(0, top - paddingY),
      Math.min(width, right + paddingX),
      Math.min(height, bottom + paddingY),
      inkTotal,
    ]);
  }

  // Dark panels with light lettering get vertical context so trailing words survive.
  const expanded = [];
  for (const [left, top, right, bottom, inkCount] of grouped) {
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    const boxArea = boxWidth * boxHeight;
    let newTop = top;
    let newBottom = bottom;
    if (boxArea >= width * height * 0.035 && boxArea <= width * height * MAX_REGION_AREA_RATIO) {
      let darkPixels = 0;
      let lightPixels = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const value = gray[y * width + x];
          if (value < 70) darkPixels += 1;
          if (value > 235) lightPixels += 1;
        }
      }
      const darkBackground = darkPixels / boxArea;
      const lightInk = lightPixels / boxArea;
      const contextTop = Math.round(boxHeight * 0.15);
      const contextBottom = Math.round(boxHeight * 0.35);
      const expandedArea = boxWidth * (boxHeight + contextTop + contextBottom);
      if (
        darkBackground >= 0.55 &&
        lightInk >= 0.06 &&
        expandedArea <= width * height * MAX_DARK_TEXT_CONTEXT_AREA_RATIO
      ) {
        newTop = Math.max(0, top - contextTop);
        newBottom = Math.min(height, bottom + contextBottom);
      }
    }
    expanded.push([left, newTop, right, newBottom, inkCount]);
  }

  bubbleCandidates.sort((a, b) => b[4] - a[4]);
  const proposals = [...bubbleCandidates, ...expanded];
  const finalCandidates = [];
  const finalIsBubble = [];
  proposals.forEach((candidate, proposalIndex) => {
    if (finalCandidates.length === limit) return;
    const isBubble = proposalIndex < bubbleCandidates.length;
    const area = areaOf(candidate);
    let duplicate = false;
    finalCandidates.forEach((existing, existingIndex) => {
      const threshold = isBubble || finalIsBubble[existingIndex] ? 0.45 : 0.65;
      if (overlaps(candidate, existing) / Math.min(area, areaOf(existing)) > threshold) {
        duplicate = true;
      }
    });
    if (duplicate) return;
    finalCandidates.push(candidate);
    finalIsBubble.push(isBubble);
  });

  finalCandidates.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
  const factorX = sourceWidth / width;
  const factorY = sourceHeight / height;
  return finalCandidates.map(([left, top, right, bottom]) => ({
    left: Math.max(0, Math.floor(left * factorX)),
    top: Math.max(0, Math.floor(top * factorY)),
    right: Math.min(sourceWidth, Math.ceil(right * factorX)),
    bottom: Math.min(sourceHeight, Math.ceil(bottom * factorY)),
  }));
}
