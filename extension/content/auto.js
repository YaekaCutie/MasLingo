// Auto translate: find manga on the page, read it, translate it, paint it back.
//
// The unit of work is an <img> (or canvas), not a viewport. That choice decides
// everything else:
//
//   * the picture's own bytes are fetched, so detection sees the whole page even
//     when only part of it is on screen, and works while the tab is in the
//     background — a screenshot cannot do either;
//   * results are anchored to the element in document coordinates, so they
//     follow the artwork when the page scrolls instead of drifting off it;
//   * "have I done this already?" has a stable answer: the image plus the region
//     inside it. Scrolling never re-triggers work that is already done.
//
// Queueing, retries and state live here. Painting is shared with manual mode.

const OMT_auto = (() => {
  const STATE = { DETECTED: "DETECTED", PROCESSING: "PROCESSING", TRANSLATED: "TRANSLATED", FAILED: "FAILED" };
  const MAX_ATTEMPTS = 2;
  /** Anything smaller is an avatar, a bullet or a decoration, not a page. */
  const MIN_IMAGE_SIDE = 260;
  /** Bound on the dedup memory; results themselves are kept in the DOM. */
  const MAX_TRACKED_REGIONS = 2000;
  const OCR_MAX_SIDE = 1600;

  let enabled = false;
  let concurrency = 1;
  let running = 0;
  /**
   * Image-level failures by cause.
   *
   * These are not the same thing and must not be reported as one: a picture the
   * browser would not hand over ("unreadable") says nothing about the backend,
   * and a search-results page is full of pictures that will never load.
   */
  const imageFailures = { unreadable: 0, ocr: 0, other: 0 };
  /** What the translation source turned out to be; "none" means text was left
   *  untranslated, which the status must not report as a success. */
  let translationMode = null;
  /** Counters for the diagnostics panel. Without these, "nothing happened" is
   *  indistinguishable from "nothing was ever considered", and the user is left
   *  guessing at a page that simply does nothing. */
  const seen = { collected: 0, candidates: 0, enqueued: 0 };
  let lastError = null;
  const queue = [];
  /** regionId -> { state, attempts } */
  const tracked = new Map();
  const elementIds = new WeakMap();
  let nextElementId = 1;
  let visibilityObserver = null;
  let sizeObserver = null;
  let mutationObserver = null;
  let mutationTimer = null;
  const pendingElements = new Set();
  /** Pictures already handed to the queue, by media key. */
  const processed = new WeakMap();
  const inFlight = new Set();

  // --- identity -------------------------------------------------------------

  function elementId(element) {
    if (!elementIds.has(element)) elementIds.set(element, nextElementId++);
    return elementIds.get(element);
  }

  /**
   * A stable name for the picture, from what the element already knows.
   *
   * The URL alone is not enough: a reader that swaps `src` on the same element
   * between pages would look identical, and one image reused in two places would
   * collide. Size and the element's identity disambiguate both.
   */
  function mediaKey(element) {
    const src = element.currentSrc || element.src || element.getAttribute?.("src") || "";
    const width = element.naturalWidth || element.width || 0;
    const height = element.naturalHeight || element.height || 0;
    return { src, width, height, key: `${src}|${width}x${height}|${elementId(element)}` };
  }

  /**
   * Region id: image identity plus the box, quantised to 0.5% of the picture.
   *
   * Detection is not bit-exact between runs — a state change elsewhere in the
   * page can shift a box by a pixel — so the id must tolerate small differences
   * or the same text would be translated twice.
   */
  function regionIdFor(key, area) {
    const q = (value) => Math.round(value * 200);
    return `${key}#${q(area.left)},${q(area.top)},${q(area.width)},${q(area.height)}`;
  }

  function track(id, state) {
    tracked.set(id, { state, attempts: tracked.get(id)?.attempts || 0 });
    if (tracked.size > MAX_TRACKED_REGIONS) {
      // Drop the oldest finished entries only. Evicting an unfinished one would
      // let the same region be queued twice.
      for (const [key, value] of tracked) {
        if (key === id) continue;
        if (value.state === STATE.TRANSLATED || value.state === STATE.FAILED) {
          tracked.delete(key);
          if (tracked.size <= MAX_TRACKED_REGIONS) break;
        }
      }
    }
  }

  // --- discovery ------------------------------------------------------------

  function isCandidate(element) {
    if (!element || !element.isConnected) return false;
    if (element.closest("#omt-layer")) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_SIDE || rect.height < MIN_IMAGE_SIDE) return false;
    // A manga page is portrait-ish or at worst square-ish; wide banners are not.
    return rect.width / rect.height < 3;
  }

  function collect(root) {
    const found = [];
    const selector = "img, canvas, [role='img'], [style*='background-image']";
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      // No size judgement here either. Filtering by size at collect time was the
      // actual bug behind "detected the manga, then did nothing for nine
      // minutes": the picture was small at that instant, so it was never even
      // handed to the observers that would have noticed it grow.
      if (node.matches?.(selector)) found.push(node);
      const nested = node.querySelectorAll?.(selector);
      if (nested) for (const child of nested) found.push(child);
    };
    if (root === document) {
      walk(document.documentElement);
    } else {
      walk(root);
    }
    return found;
  }

  /** Scan without rescanning the world: only newly added subtrees are walked. */
  function scan(root = document) {
    if (!enabled) return;
    for (const element of collect(root)) observe(element);
  }

  function observe(element) {
    if (pendingElements.has(element)) return;
    pendingElements.add(element);
    seen.collected += 1;
    // Size is deliberately NOT judged here. A picture that is still laying out —
    // Bing's image viewer, a lazy loader, anything behind a CSS transition — is
    // small at this instant and would be rejected for good: the scan happens
    // once, and nothing looks at it again. It is judged when it becomes visible,
    // and re-judged every time it resizes.
    visibilityObserver?.observe(element);
    sizeObserver?.observe(element);
  }

  /** Is any part of this element near the viewport? */
  function onScreen(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const margin = 400;
    return (
      rect.bottom > -margin &&
      rect.top < window.innerHeight + margin &&
      rect.right > -margin &&
      rect.left < window.innerWidth + margin
    );
  }

  /**
   * Take a picture under consideration — this is the only path into the queue.
   *
   * Called when an element becomes visible and whenever it resizes, so an image
   * that grows into a manga page is picked up the moment it does.
   */
  function consider(element) {
    if (!enabled || !element.isConnected) return;
    if (!isCandidate(element)) return;
    const media = mediaKey(element);
    if (processed.get(element) === media.key) return;
    seen.candidates += 1;
    visibilityObserver?.unobserve(element);
    sizeObserver?.unobserve(element);
    pendingElements.delete(element);
    enqueue(element, media);
  }

  function onVisible(entries) {
    if (!enabled) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      // Stays observed when it is not a candidate yet: it may still grow.
      consider(entry.target);
    }
  }

  function onResize(entries) {
    if (!enabled) return;
    for (const entry of entries) {
      if (!onScreen(entry.target)) continue;
      consider(entry.target);
    }
  }

  // --- queue ----------------------------------------------------------------

  function enqueue(element, media) {
    if (!enabled) return;
    if (inFlight.has(element)) return;
    if (queue.some((task) => task.element === element)) return;
    // Remembered now so a resize mid-flight cannot queue the same picture twice;
    // cleared on failure so a genuine retry is still possible.
    processed.set(element, media.key);
    inFlight.add(element);
    seen.enqueued += 1;
    queue.push({ element, media, attempts: 0 });
    pump();
  }

  function pump() {
    while (enabled && running < concurrency && queue.length) {
      const task = queue.shift();
      running += 1;
      runTask(task)
        .catch((error) => console.warn("[OMT] 自动翻译任务异常：", error.message))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  /** Which kind of failure a thrown error represents. */
  function classify(error) {
    const message = String(error?.message || error);
    if (/图片|地址|bitmap|decode|decode|Failed to fetch|NetworkError/i.test(message)) {
      return "unreadable";
    }
    if (/OCR|后端|backend|fetch|Failed to fetch/i.test(message)) return "ocr";
    return "other";
  }

  async function runTask(task) {
    const { element } = task;
    if (!element.isConnected) return;

    let bitmap = null;
    try {
      bitmap = await loadBitmap(element);
      if (!bitmap || bitmap.width < MIN_IMAGE_SIDE || bitmap.height < MIN_IMAGE_SIDE) return;

      const key = task.media.key;
      const scale = Math.min(1, OCR_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const sendWidth = Math.max(1, Math.round(bitmap.width * scale));
      const sendHeight = Math.max(1, Math.round(bitmap.height * scale));

      const dataUrl = await toDataUrl(bitmap, sendWidth, sendHeight);
      const ocr = await chrome.runtime.sendMessage({ type: "AUTO_OCR", image: dataUrl });
      if (!ocr?.ok) throw new Error(ocr?.error || "OCR 失败");

      const fresh = [];
      for (const item of ocr.items || []) {
        const area = {
          left: item.bbox.left / sendWidth,
          top: item.bbox.top / sendHeight,
          width: (item.bbox.right - item.bbox.left) / sendWidth,
          height: (item.bbox.bottom - item.bbox.top) / sendHeight,
        };
        const id = regionIdFor(key, area);
        if (tracked.get(id)?.state === STATE.TRANSLATED) continue;
        track(id, STATE.DETECTED);
        fresh.push({ id, area, item, box: OMT_detectionBox.show(element, area) });
      }

      if (!fresh.length) return;

      // Each region appears as a small dot and then stretches into its box, one
      // after another. The box exists to answer one question — "what did it
      // find?" — so a stagger reads as "this one, and this one", where showing
      // them all at once would just be a flash.
      fresh.forEach((region, index) => {
        setTimeout(() => region.box.markReading(), 180 + Math.min(index, 14) * 55);
      });

      const texts = fresh.map((region) => region.item.text);
      const translation = await chrome.runtime.sendMessage({ type: "AUTO_TRANSLATE", texts });
      if (translation?.ok) translationMode = translation.mode || "configured";
      for (const region of fresh) track(region.id, STATE.PROCESSING);

      fresh.forEach((region, index) => {
        const translated = translation?.ok && translation.items?.[index]?.translated;
        if (!translation?.ok) {
          // Not silent: without this the only symptom is a count in the popup,
          // and there is nothing to act on.
          console.warn("[OMT] 翻译失败：", translation?.error || "未知原因");
          track(region.id, STATE.FAILED);
          region.box.fail();
          return;
        }
        try {
          paintRegion(element, bitmap, region, translated || region.item.text);
          track(region.id, STATE.TRANSLATED);
          region.box.finish();
        } catch (error) {
          console.warn("[OMT] 绘制失败：", error.message);
          track(region.id, STATE.FAILED);
          region.box.fail();
        }
      });
    } catch (error) {
      task.attempts += 1;
      if (task.attempts < MAX_ATTEMPTS) {
        // Retry once, then give up on this picture only. One bad image must not
        // stall the queue behind it.
        setTimeout(() => {
          if (enabled) {
            queue.push(task);
            pump();
          }
        }, 800 * task.attempts);
      } else {
        console.warn("[OMT] 放弃这张图片：", error.message);
        // Let it be considered again — the failure may have been transient, and
        // the picture may also have changed since.
        processed.delete(element);
        imageFailures[classify(error)] += 1;
        lastError = { message: String(error.message || error), at: Date.now(), src: task.media.src };
      }
      throw error;
    } finally {
      inFlight.delete(element);
      bitmap?.close?.();
    }
  }

  // --- pixels ---------------------------------------------------------------

  async function loadBitmap(element) {
    if (element.tagName === "CANVAS") {
      // A canvas the page drew cross-origin content into is tainted; reading it
      // throws, and there is nothing safe to do about that.
      return createImageBitmap(element);
    }
    const src = element.currentSrc || element.src;
    if (!src) {
      const background = getComputedStyle(element).backgroundImage.match(/url\(["']?([^"')]+)/);
      if (!background) throw new Error("没有可用的图片地址");
      return loadFromUrl(background[1]);
    }
    return loadFromUrl(src);
  }

  async function loadFromUrl(url) {
    // Fetched as bytes rather than drawn from the element: a cross-origin <img>
    // drawn straight into a canvas taints it, and every later getImageData()
    // would throw. Bytes from the extension are same-origin to the blob.
    //
    // The direct fetch only works for same-origin or CORS-enabled pictures. A
    // content script cannot use the extension's host permissions, so anything
    // else — which is most manga CDNs — has to go through the service worker.
    try {
      const response = await fetch(url, { credentials: "omit" });
      if (response.ok) return createImageBitmap(await response.blob());
    } catch {
      /* fall through to the service worker */
    }
    const relayed = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url });
    if (!relayed?.ok) throw new Error(relayed?.error || "图片读取失败");
    const blob = await (await fetch(relayed.dataUrl)).blob();
    return createImageBitmap(blob);
  }

  function toDataUrl(bitmap, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  }

  /**
   * Draw the translation over the region and anchor it to the picture.
   *
   * The padding matters: background reconstruction samples the pixels just
   * outside the text box to work out what the paper looks like, so a crop that
   * ends exactly at the text has nothing to sample.
   */
  function paintRegion(element, bitmap, region, text) {
    const source = {
      left: region.area.left * bitmap.width,
      top: region.area.top * bitmap.height,
      width: region.area.width * bitmap.width,
      height: region.area.height * bitmap.height,
    };
    const padX = Math.min(32, Math.max(6, source.width * 0.14));
    const padY = Math.min(32, Math.max(6, source.height * 0.14));
    const crop = {
      left: Math.max(0, source.left - padX),
      top: Math.max(0, source.top - padY),
      right: Math.min(bitmap.width, source.left + source.width + padX),
      bottom: Math.min(bitmap.height, source.top + source.height + padY),
    };
    crop.width = crop.right - crop.left;
    crop.height = crop.bottom - crop.top;
    if (crop.width < 2 || crop.height < 2) throw new Error("区域太小");

    const ratio = window.devicePixelRatio || 1;
    const displayed = element.getBoundingClientRect();
    const displayScale = displayed.width / bitmap.width || 1;

    const image = document.createElement("canvas");
    image.width = Math.max(1, Math.round(crop.width * displayScale * ratio));
    image.height = Math.max(1, Math.round(crop.height * displayScale * ratio));
    image.getContext("2d").drawImage(
      bitmap, crop.left, crop.top, crop.width, crop.height,
      0, 0, image.width, image.height,
    );

    const canvas = document.createElement("canvas");
    canvas.className = "omt-result";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", text);
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const core = {
      left: (source.left - crop.left) / crop.width,
      top: (source.top - crop.top) / crop.height,
      width: source.width / crop.width,
      height: source.height / crop.height,
    };
    // `rect` is the patch's size in CSS pixels; the renderer divides the canvas
    // size by it to recover the device pixel ratio, so it has to be the
    // on-screen size rather than the bitmap size.
    const rect = {
      width: crop.width * displayScale,
      height: crop.height * displayScale,
    };
    // Painting is shared with manual mode; see the OMT_render export in
    // content.js.
    OMT_render.drawTranslatedPatch(
      { canvas, context, image, patch: { core, rect }, direction: region.item.direction },
      text,
    );

    OMT_overlay.anchor(canvas, element, {
      left: crop.left / bitmap.width,
      top: crop.top / bitmap.height,
      width: crop.width / bitmap.width,
      height: crop.height / bitmap.height,
    });
  }

  // --- lifecycle ------------------------------------------------------------

  function attachObservers() {
    if (!visibilityObserver) {
      visibilityObserver = new IntersectionObserver(onVisible, {
        // Start a little early so the translation is ready by the time the
        // panel is actually being read, without scanning the whole document.
        rootMargin: "400px 0px",
      });
    }
    if (!sizeObserver) {
      // The reason this exists: a picture that reaches its real size after the
      // scan. Without it, anything still laying out at that moment is invisible
      // to auto translate forever.
      sizeObserver = new ResizeObserver(onResize);
    }
    if (!mutationObserver) {
      mutationObserver = new MutationObserver((records) => {
        // Coalesced: image galleries fire hundreds of mutations while loading.
        if (mutationTimer) return;
        mutationTimer = setTimeout(() => {
          mutationTimer = null;
          const roots = new Set();
          for (const record of records.splice(0)) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1) roots.add(node);
            }
          }
          for (const root of roots) scan(root);
        }, 250);
      });
    }
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function detachObservers() {
    visibilityObserver?.disconnect();
    sizeObserver?.disconnect();
    mutationObserver?.disconnect();
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = null;
    pendingElements.clear();
  }

  /**
   * Read settings, tolerating a frame where extension APIs are unreachable.
   *
   * A content script can land in a sandboxed iframe; `chrome.storage` is simply
   * absent there. Auto translate should stay off in that frame rather than throw
   * and take the rest of the script down with it.
   */
  async function readSettings(keys) {
    try {
      return (await chrome.storage.local.get(keys)) || {};
    } catch {
      return {};
    }
  }

  async function start() {
    if (enabled) return;
    const cfg = await readSettings(["autoConcurrency"]);
    concurrency = Math.min(3, Math.max(1, Number(cfg.autoConcurrency) || 1));
    enabled = true;
    imageFailures.unreadable = 0;
    imageFailures.ocr = 0;
    imageFailures.other = 0;
    attachObservers();
    scan(document);
    OMT_notice.reset();
    OMT_notice.show("已检测到漫画，正在自动翻译", { kind: "busy" });
  }

  function stop() {
    if (!enabled) return;
    enabled = false;
    detachObservers();
    queue.length = 0;
    // In-flight work is left to settle rather than aborted mid-request: the
    // results already painted are valid, and killing a fetch midway would only
    // leave a half-finished box behind.
  }

  /** Mirror the stored setting; called at startup and whenever it changes. */
  async function sync() {
    const cfg = await readSettings(["autoTranslate"]);
    if (cfg.autoTranslate) await start();
    else stop();
  }

  return {
    sync,
    start,
    stop,
    get enabled() { return enabled; },
    stats: () => ({
      enabled,
      queued: queue.length,
      running,
      translated: [...tracked.values()].filter((r) => r.state === STATE.TRANSLATED).length,
      failed: [...tracked.values()].filter((r) => r.state === STATE.FAILED).length,
      imageFailures: { ...imageFailures },
      translationMode,
      seen: { ...seen },
      lastError,
    }),
    /** Everything the popup needs to explain a page that does nothing. */
    diagnostics: () => ({
      enabled,
      concurrency,
      seen: { ...seen },
      queued: queue.length,
      running,
      anchored: OMT_overlay.count(),
      imageFailures: { ...imageFailures },
      lastError,
      translationMode,
    }),
  };
})();
