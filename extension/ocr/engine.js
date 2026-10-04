// On-device manga OCR: the same model the server runs, executed in the browser.
//
// Why this exists: hosting the backend needs a cloud account (and a credit
// card), while running it locally means the user installs Python. Running the
// model in the extension removes both — nothing to host, nothing to install,
// and page screenshots never leave the machine.
//
// The model is the community ONNX export of kha-white/manga-ocr-base
// (int8: 83 MB encoder + 28 MB decoder). It was verified to reproduce the
// PyTorch pipeline word-for-word; see docs/BROWSER_OCR_FEASIBILITY.md and
// tools/onnx_parity_test.py.
//
// Deliberately NOT built on transformers.js: the decoder's vocabulary is
// character-level Japanese (6144 entries) and the published tokenizer config is
// a MeCab-backed BertJapaneseTokenizer, which cannot run in a browser. A flat
// id -> character table plus the loop below is both simpler and correct.

import { VOCAB } from "./vocab.js";

export const IMAGE_SIZE = 224;
export const IMAGE_MEAN = 0.5;
export const IMAGE_STD = 0.5;
const RESCALE_FACTOR = 1 / 255;

export const DECODER_START_TOKEN_ID = 2;
export const EOS_TOKEN_ID = 3;
export const DEFAULT_MAX_TOKENS = 300;
// Greedy is the default because it is what actually reproduces the reference
// export: on three probe crops its token sequence matched the verified ONNX
// run exactly (the only difference from the fp32 server model was one
// low-confidence trailing "：" that int8 quantisation turns into EOS), while
// num_beams=4 deviated earlier in the sequence and cost 2x the time.
// Beam search is still available via options.numBeams for experimentation.
export const DEFAULT_NUM_BEAMS = 1;
export const DEFAULT_LENGTH_PENALTY = 2.0;
export const DEFAULT_NO_REPEAT_NGRAM_SIZE = 3;

/**
 * PIL's "L" conversion (ITU-R 601-2), which is what manga-ocr does before
 * anything else: `img.convert("L").convert("RGB")`. Getting this wrong is one
 * of the two ways a naive port silently produces garbage.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image RGBA
 * @returns {Float32Array} one luminance value per pixel
 */
export function toGrayscale(image) {
  const { data, width, height } = image;
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] =
      (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Resample one axis of a row-major 2D array with a triangle filter whose
 * support scales with the downscale factor, so large crops are antialiased
 * instead of point-sampled (this is what PIL's BILINEAR does).
 *
 * @param {Float32Array} source rows x cols, row-major
 * @param {number} rows
 * @param {number} cols
 * @param {boolean} horizontal true: resample each row (cols -> targetLength)
 *                             false: resample each column (rows -> targetLength)
 * @param {number} targetLength
 */
function resampleAxis(source, rows, cols, horizontal, targetLength) {
  const outRows = horizontal ? rows : targetLength;
  const outCols = horizontal ? targetLength : cols;
  const target = new Float32Array(outRows * outCols);

  const lineLength = horizontal ? cols : rows; // samples along the resampled axis
  const lineCount = horizontal ? rows : cols; // independent lines

  const scale = lineLength / targetLength;
  const filterScale = Math.max(1, scale);
  const support = filterScale; // triangle kernel radius is 1

  for (let line = 0; line < lineCount; line += 1) {
    for (let index = 0; index < targetLength; index += 1) {
      const center = (index + 0.5) * scale - 0.5;
      const start = Math.max(0, Math.floor(center - support + 0.5));
      const end = Math.min(lineLength - 1, Math.ceil(center + support - 0.5));

      let weightSum = 0;
      let accumulator = 0;
      for (let sample = start; sample <= end; sample += 1) {
        const weight = Math.max(0, 1 - Math.abs((sample - center) / filterScale));
        if (weight === 0) continue;
        const value = horizontal ? source[line * cols + sample] : source[sample * cols + line];
        accumulator += value * weight;
        weightSum += weight;
      }
      const value = weightSum > 0 ? accumulator / weightSum : 0;
      if (horizontal) {
        target[line * outCols + index] = value;
      } else {
        target[index * outCols + line] = value;
      }
    }
  }
  return target;
}

function resizeBilinear(gray, width, height, size) {
  if (width === size && height === size) {
    return Float32Array.from(gray);
  }
  const horizontal = resampleAxis(gray, height, width, true, size); // height x size
  return resampleAxis(horizontal, height, size, false, size); // size x size
}

/**
 * RGBA image -> NCHW float32 tensor [1, 3, 224, 224], rescale + normalise,
 * exactly as ViTImageProcessor does with mean/std 0.5.
 */
export function buildPixelValues(image) {
  const gray = toGrayscale(image);
  const resized = resizeBilinear(gray, image.width, image.height, IMAGE_SIZE);

  const plane = IMAGE_SIZE * IMAGE_SIZE;
  const tensor = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index += 1) {
    const value = (resized[index] * RESCALE_FACTOR - IMAGE_MEAN) / IMAGE_STD;
    tensor[index] = value;
    tensor[plane + index] = value;
    tensor[2 * plane + index] = value;
  }
  return tensor;
}

/** ids -> text (special tokens are empty strings in the table). */
export function decodeIds(ids) {
  let text = "";
  for (const id of ids) {
    if (id >= 0 && id < VOCAB.length) text += VOCAB[id];
  }
  return text;
}

const HALFWIDTH_KANA = "｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ";
const FULLWIDTH_KANA = "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜";

/**
 * Port of manga_ocr.ocr.post_process: drop whitespace, normalise ellipses,
 * then convert halfwidth ASCII/digits/kana to fullwidth (jaconv.h2z).
 * Applied after the model, not before.
 */
export function postProcess(text) {
  let out = text.replace(/\s+/g, "");
  out = out.replace(/\u2026/g, "...");
  out = out.replace(/[・.]{2,}/g, (match) => ".".repeat(match.length));

  let converted = "";
  for (const character of out) {
    const code = character.codePointAt(0);
    const kanaIndex = HALFWIDTH_KANA.indexOf(character);
    if (kanaIndex !== -1) {
      converted += FULLWIDTH_KANA[kanaIndex];
    } else if (code >= 0x21 && code <= 0x7e) {
      converted += String.fromCodePoint(code + 0xfee0);
    } else {
      converted += character;
    }
  }
  return converted;
}

/**
 * Create the two ONNX sessions.
 *
 * @param {object} ort onnxruntime-web (browser) or onnxruntime-node (tests)
 * @param {{encoder: Uint8Array|string, decoder: Uint8Array|string, numThreads?: number, wasmPaths?: string}} options
 */
export async function createOcrEngine(ort, options) {
  if (ort.env?.wasm) {
    // Single-threaded avoids requiring cross-origin isolation
    // (SharedArrayBuffer) inside the extension.
    ort.env.wasm.numThreads = options.numThreads ?? 1;
    if (options.wasmPaths) ort.env.wasm.wasmPaths = options.wasmPaths;
  }
  const sessionOptions = options.executionProviders
    ? { executionProviders: options.executionProviders }
    : {};
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(options.encoder, sessionOptions),
    ort.InferenceSession.create(options.decoder, sessionOptions),
  ]);
  return { ort, encoder, decoder, lastRun: null };
}

/**
 * Tokens that would complete a repeated n-gram, mirroring the
 * `no_repeat_ngram_size` constraint in the model's generation_config.
 * Without it greedy decoding can loop on a punctuation mark (observed: six
 * trailing "．" where the beam-search pipeline emits "：").
 */
function bannedByNgram(ids, n) {
  const banned = new Set();
  if (n <= 0 || ids.length < n) return banned;
  const prefix = ids.slice(-(n - 1));
  for (let start = 0; start + n <= ids.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < n - 1; offset += 1) {
      if (ids[start + offset] !== prefix[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) banned.add(ids[start + n - 1]);
  }
  return banned;
}

/**
 * Beam search, matching the model's generation_config (num_beams=4,
 * length_penalty=2.0, no_repeat_ngram_size=3, early_stopping).
 *
 * Greedy decoding was tried first and is ~4x cheaper, but it stops one token
 * early on a low-confidence trailing glyph (observed: "...普通．．" instead of
 * "...普通．．："), so the beams are worth it here. Beams are advanced as one
 * batch, so a 4-beam step costs about the same as a single greedy step.
 */
async function beamSearch(engine, encoderHiddenStates, options) {
  const { numBeams, maxTokens, lengthPenalty, noRepeatNgramSize, prompt } = options;

  const encoderLength = encoderHiddenStates.dims[1];
  const hiddenSize = encoderHiddenStates.dims[2];

  // Expand the encoder output to the beam batch once; every step reuses it.
  const expanded = new Float32Array(numBeams * encoderLength * hiddenSize);
  for (let beam = 0; beam < numBeams; beam += 1) {
    expanded.set(encoderHiddenStates.data, beam * encoderLength * hiddenSize);
  }

  let beams = [{ ids: [...prompt], score: 0, done: false }];
  let finished = [];
  let vocabSize = 0;

  for (let step = 0; step < maxTokens; step += 1) {
    const active = beams.filter((beam) => !beam.done);
    if (active.length === 0) break;

    const batch = active.length;
    const sequenceLength = active[0].ids.length;
    const inputIds = new BigInt64Array(batch * sequenceLength);
    active.forEach((beam, index) => {
      beam.ids.forEach((id, position) => {
        inputIds[index * sequenceLength + position] = BigInt(id);
      });
    });

    const outputs = await engine.decoder.run({
      input_ids: new engine.ort.Tensor("int64", inputIds, [batch, sequenceLength]),
      encoder_hidden_states: new engine.ort.Tensor("float32", expanded.subarray(0, batch * encoderLength * hiddenSize), [
        batch,
        encoderLength,
        hiddenSize,
      ]),
    });
    const logits = outputs.logits ?? Object.values(outputs)[0];
    vocabSize = logits.dims[logits.dims.length - 1];
    const data = logits.data;

    const candidates = [];
    for (let index = 0; index < batch; index += 1) {
      const beam = active[index];
      const base = (index * sequenceLength + sequenceLength - 1) * vocabSize;

      // log_softmax over the final position
      let maximum = -Infinity;
      for (let token = 0; token < vocabSize; token += 1) {
        const value = data[base + token];
        if (value > maximum) maximum = value;
      }
      let denominator = 0;
      for (let token = 0; token < vocabSize; token += 1) {
        denominator += Math.exp(data[base + token] - maximum);
      }
      const logDenominator = Math.log(denominator);

      const banned = bannedByNgram(beam.ids, noRepeatNgramSize);
      for (let token = 0; token < vocabSize; token += 1) {
        if (banned.has(token)) continue;
        const score = beam.score + (data[base + token] - maximum - logDenominator);
        candidates.push({ ids: [...beam.ids, token], score, done: token === EOS_TOKEN_ID });
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    beams = [];
    for (const candidate of candidates) {
      if (beams.length >= numBeams) break;
      if (candidate.done) {
        // A finished hypothesis does not end the search: with early stopping
        // we wait for numBeams of them, otherwise the best continuation is
        // cut off and the text ends early.
        finished.push(candidate);
        continue;
      }
      beams.push(candidate);
    }
    if (beams.length === 0) break;
    if (options.earlyStopping && finished.length >= numBeams) break;
  }

  const pool = finished.length > 0 ? finished : beams;
  const scored = pool.map((beam) => {
    const length = Math.max(1, beam.ids.length - prompt.length);
    return { beam, normalised: beam.score / Math.pow(length, lengthPenalty) };
  });
  scored.sort((left, right) => right.normalised - left.normalised);
  return scored[0].beam.ids;
}

/**
 * Greedy decode (cheaper, slightly worse on trailing punctuation). Kept so the
 * caller can trade quality for speed on weak devices.
 */
async function greedySearch(engine, encoderHiddenStates, options) {
  const { maxTokens, noRepeatNgramSize, prompt } = options;
  const ids = [...prompt];

  for (let step = 0; step < maxTokens; step += 1) {
    const outputs = await engine.decoder.run({
      input_ids: new engine.ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      encoder_hidden_states: encoderHiddenStates,
    });
    const logits = outputs.logits ?? Object.values(outputs)[0];
    const { data, dims } = logits;
    const vocabSize = dims[dims.length - 1];
    const base = (dims[dims.length - 2] - 1) * vocabSize;
    const banned = bannedByNgram(ids, noRepeatNgramSize);

    let bestId = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < vocabSize; index += 1) {
      if (banned.has(index)) continue;
      const value = data[base + index];
      if (value > bestValue) {
        bestValue = value;
        bestId = index;
      }
    }
    if (bestId === EOS_TOKEN_ID) break;
    ids.push(bestId);
  }
  return ids;
}

/**
 * Recognise one cropped region.
 *
 * @param {object} engine from createOcrEngine
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image RGBA
 * @returns {Promise<{text: string, ids: number[], milliseconds: number}>}
 */
export async function recognize(engine, image, options = {}) {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const noRepeatNgramSize = options.noRepeatNgramSize ?? DEFAULT_NO_REPEAT_NGRAM_SIZE;
  const numBeams = options.numBeams ?? DEFAULT_NUM_BEAMS;
  const lengthPenalty = options.lengthPenalty ?? DEFAULT_LENGTH_PENALTY;
  const prompt = [DECODER_START_TOKEN_ID];
  const started = Date.now();

  const pixelValues = buildPixelValues(image);
  const encoderOutputs = await engine.encoder.run({
    pixel_values: new engine.ort.Tensor("float32", pixelValues, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
  });
  const encoderHiddenStates = encoderOutputs.last_hidden_state ?? Object.values(encoderOutputs)[0];

  const searchOptions = {
    maxTokens,
    noRepeatNgramSize,
    prompt,
    numBeams,
    lengthPenalty,
    earlyStopping: options.earlyStopping ?? true,
  };
  const ids =
    numBeams > 1
      ? await beamSearch(engine, encoderHiddenStates, searchOptions)
      : await greedySearch(engine, encoderHiddenStates, searchOptions);

  const generated = ids.slice(prompt.length);
  const text = postProcess(decodeIds(generated));
  const milliseconds = Date.now() - started;
  engine.lastRun = { ids: generated, milliseconds, numBeams };
  return { text, ids: generated, milliseconds };
}
