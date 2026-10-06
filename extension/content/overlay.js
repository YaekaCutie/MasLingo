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

const OMT_overlay = (() => {
  const LAYER_ID = "omt-layer";
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
const OMT_detectionBox = (() => {
  const HOLD_MS = 500;
  const FADE_MS = 420;

  function create() {
    const node = document.createElement("div");
    node.className = "omt-box";
    const dashed = document.createElement("div");
    dashed.className = "omt-box-border omt-box-dashed";
    const solid = document.createElement("div");
    solid.className = "omt-box-border omt-box-solid";
    node.append(dashed, solid);
    return { node, solid };
  }

  /**
   * @param {Element} element image the region belongs to
   * @param {{left:number,top:number,width:number,height:number}} region normalised
   */
  function show(element, region) {
    const { node, solid } = create();
    const entry = OMT_overlay.anchor(node, element, region);
    node.classList.add("omt-box-visible");

    return {
      node,
      /** Work has started: let the dashed edge begin turning solid. */
      markProcessing() {
        solid.classList.add("omt-box-working");
      },
      /** Translation is in. Complete the border, hold, then disappear. */
      finish() {
        solid.classList.remove("omt-box-working");
        solid.classList.add("omt-box-solid-on");
        setTimeout(() => {
          node.classList.add("omt-box-fading");
          setTimeout(() => OMT_overlay.release(entry), FADE_MS);
        }, HOLD_MS);
      },
      /** Something went wrong: same exit, different colour. */
      fail() {
        solid.classList.remove("omt-box-working");
        node.classList.add("omt-box-failed");
        setTimeout(() => {
          node.classList.add("omt-box-fading");
          setTimeout(() => OMT_overlay.release(entry), FADE_MS);
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
const OMT_notice = (() => {
  let shown = false;
  let timer = null;

  function show(text, { once = true, kind = "info" } = {}) {
    if (once && shown) return;
    shown = true;
    let node = document.getElementById("omt-notice");
    if (!node) {
      node = document.createElement("div");
      node.id = "omt-notice";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(node);
    }
    node.className = `omt-notice omt-notice-${kind}`;
    node.textContent = text;
    requestAnimationFrame(() => node.classList.add("omt-notice-in"));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      node.classList.remove("omt-notice-in");
      timer = null;
    }, 2600);
  }

  function reset() {
    shown = false;
  }

  return { show, reset };
})();
