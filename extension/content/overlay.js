// Overlay layer: everything the extension paints lives in here.
//
// Two rules shape this file.
//
// 1. Positions are in *document* coordinates, never viewport coordinates. A
//    viewport-anchored overlay slides off the drawing as soon as the page
//    scrolls; anchored in document space it stays glued to the artwork, which is
//    what the user actually wants. Nothing has to be recomputed for ordinary
//    window scrolling — only when layout or an inner scroller moves the target.
//
// 2. The detection box and the translated result are separate objects. The box
//    is progress feedback and always goes away; the result is the deliverable
//    and stays. Removing one must never remove the other.

const MAS_overlay = (() => {
  const LAYER_ID = "maslingo-layer";
  let layer = null;
  let repositionQueued = false;
  /** @type {Set<{node: HTMLElement, target: Element|null, place: Function}>} */
  const anchored = new Set();

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(layer);
    return layer;
  }

  /** Bounding box of an element in document coordinates. */
  function documentRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * The part of an element that actually shows the picture.
   *
   * `object-fit: contain` letterboxes the image inside its box, so mapping a
   * detected box straight onto the element rect would misplace every overlay on
   * any site that uses it — which is most manga readers.
   */
  function contentRect(element, naturalWidth, naturalHeight) {
    const box = documentRect(element);
    if (!naturalWidth || !naturalHeight) return box;

    let fit = "fill";
    try {
      fit = getComputedStyle(element).objectFit || "fill";
    } catch {
      /* detached element */
    }
    if (fit === "fill" || fit === "none") return box;

    const scale = fit === "cover"
      ? Math.max(box.width / naturalWidth, box.height / naturalHeight)
      : Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width,
      height,
    };
  }

  function place(node, rect) {
    node.style.left = `${Math.round(rect.left)}px`;
    node.style.top = `${Math.round(rect.top)}px`;
    node.style.width = `${Math.round(rect.width)}px`;
    node.style.height = `${Math.round(rect.height)}px`;
  }

  /**
   * Keep a node aligned with a region of an element.
   *
   * `region` is normalised (0-1) within the *image*, so the same numbers work at
   * any display size and survive a window resize without re-running detection.
   */
  function anchor(node, element, region) {
    const entry = {
      node,
      target: element,
      place() {
        const natural = {
          width: element.naturalWidth || element.videoWidth || 0,
          height: element.naturalHeight || element.videoHeight || 0,
        };
        const box = contentRect(element, natural.width, natural.height);
        if (!box.width || !box.height) return;
        place(node, {
          left: box.left + region.left * box.width,
          top: box.top + region.top * box.height,
          width: Math.max(1, region.width * box.width),
          height: Math.max(1, region.height * box.height),
        });
      },
    };
    ensureLayer().appendChild(node);
    anchored.add(entry);
    entry.place();
    return entry;
  }

  function release(entry) {
    anchored.delete(entry);
    entry.node.remove();
  }

  /**
   * Re-place everything that is still on screen.
   *
   * Driven by rAF so a burst of scroll events costs one pass, and it only runs
   * while something is anchored — an idle page pays nothing.
   */
  function reposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      for (const entry of [...anchored]) {
        if (!entry.node.isConnected) {
          anchored.delete(entry);
          continue;
        }
        if (entry.target && !entry.target.isConnected) {
          // The page replaced the image (SPA re-render): drop the overlay rather
          // than leave it floating over unrelated content.
          release(entry);
          continue;
        }
        entry.place();
      }
    });
  }

  return {
    ensureLayer,
    documentRect,
    contentRect,
    place,
    anchor,
    release,
    reposition,
    count: () => anchored.size,
  };
})();

/**
 * The detection box: immediate feedback that a region was found, then a quiet
 * progress indicator that gets out of the way.
 *
 * The whole rectangle appears at once, dashed — no growing, no stretching, no
 * animating into shape. The moment a region is known the user is shown exactly
 * where it is and how big it is. While the reading and translation run, the
 * dashed edge cross-fades towards solid; when the translation lands the box
 * completes, holds briefly and fades out.
 *
 * Dashed and solid are separate elements because `border-style` cannot be
 * interpolated: switching it on one element snaps, cross-fading two blends.
 */
const MAS_detectionBox = (() => {
  // §12's sequence, in milliseconds. Mirrored from marker.css, which owns the
  // transition durations — these exist so the *hold* can be scheduled after the
  // transition finishes rather than on top of it. A comment here and a token
  // there would drift, so check-material asserts the observed hold is at least
  // 400ms: if the two ever disagree, that assertion is what notices.
  const SOLIDIFY_MS = 440;
  const HOLD_MS = 500;
  const FADE_MS = 420;

  // When the current box's edge started turning solid, so `finish` can wait out
  // the remainder instead of starting the hold on top of it.
  let processingSince = 0;

  function create() {
    const node = document.createElement("div");
    node.className = "maslingo-box";
    const dashed = document.createElement("div");
    dashed.className = "maslingo-box-border maslingo-box-dashed";
    const solid = document.createElement("div");
    solid.className = "maslingo-box-border maslingo-box-solid";
    node.append(dashed, solid);
    return { node, solid };
  }

  /**
   * @param {Element} element image the region belongs to
   * @param {{left:number,top:number,width:number,height:number}} region normalised
   */
  function show(element, region) {
    const { node, solid } = create();
    const entry = MAS_overlay.anchor(node, element, region);
    node.classList.add("maslingo-box-visible");

    return {
      node,
      /**
       * Work has started: the dashed edge begins drifting towards solid.
       *
       * The class goes on the container, not on the border element. The stylesheet
       * reaches the two stacked borders with descendant selectors — that is how a
       * cross-fade between them is expressed, since `border-style` cannot be
       * interpolated — and a class on `solid` itself can never be its own
       * ancestor. Putting it there made both rules dead, which is why the box
       * stayed dashed and simply faded out: §12 phases 3 and 4 never happened.
       */
      markProcessing() {
        processingSince = performance.now();
        node.classList.add("maslingo-box-working");
      },
      /** Translation is in. Let the border finish, hold it, then disappear. */
      finish() {
        node.classList.remove("maslingo-box-working");
        node.classList.add("maslingo-box-solid-on");
        // §12 puts phase 3 (the edge completing, 350–550ms) *before* phase 5 (a
        // ~500ms hold), so the hold has to start once the edge is actually solid.
        // Counting it from here instead would spend almost all of it on the
        // transition: with a fast provider the border would be solid for about
        // 60ms before it began to fade.
        const elapsed = processingSince ? performance.now() - processingSince : SOLIDIFY_MS;
        const remaining = Math.max(0, SOLIDIFY_MS - elapsed);
        setTimeout(() => {
          node.classList.add("maslingo-box-fading");
          setTimeout(() => MAS_overlay.release(entry), FADE_MS);
        }, remaining + HOLD_MS);
      },
      /** Something went wrong: same exit, different colour. */
      fail() {
        node.classList.remove("maslingo-box-working");
        node.classList.add("maslingo-box-failed");
        setTimeout(() => {
          node.classList.add("maslingo-box-fading");
          setTimeout(() => MAS_overlay.release(entry), FADE_MS);
        }, HOLD_MS);
      },
    };
  }

  return { show };
})();

/**
 * One-shot notice in the top-right corner. Used instead of alert() and only
 * once per page, so it announces "auto translate is running" without becoming
 * noise on a long page.
 */
const MAS_notice = (() => {
  let shown = false;
  let timer = null;

  function show(text, { once = true, kind = "info" } = {}) {
    if (once && shown) return;
    shown = true;
    let node = document.getElementById("maslingo-notice");
    if (!node) {
      node = document.createElement("div");
      node.id = "maslingo-notice";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(node);
    }
    node.className = `maslingo-notice maslingo-notice-${kind}`;
    node.textContent = text;
    requestAnimationFrame(() => node.classList.add("maslingo-notice-in"));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      node.classList.remove("maslingo-notice-in");
      timer = null;
    }, 2600);
  }

  function reset() {
    shown = false;
  }

  return { show, reset };
})();
