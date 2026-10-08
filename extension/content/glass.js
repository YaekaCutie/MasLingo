/* MasLingo — motion for the glass surfaces.
 *
 * Kept out of panel.js because these are properties of the material, not of the
 * panel: the notice and the toast may want the same pointer response later, and
 * `prefers-reduced-motion` has to be answered identically everywhere.
 *
 * Two rules the whole file follows, both from the specification:
 *   - high-frequency input never writes to the DOM directly. Pointer movement is
 *     coalesced to one write per animation frame, and that write is a custom
 *     property change on one element, which the compositor can absorb.
 *   - reduced motion means "less movement", not "no feedback". Where a state
 *     change would otherwise vanish, the transition duration collapses instead
 *     of the transition being removed.
 */

globalThis.MAS_glass = (() => {
  /** Whether the user asked for less movement. */
  function reduced() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /**
   * Coalesce calls to at most one per animation frame.
   *
   * `pointermove` fires far faster than the compositor can use — 120 Hz mice on
   * a 60 Hz display, and coalesced bursts after every scroll. Without this the
   * handler would write layout-affecting values several times per painted frame.
   */
  function rafThrottle(fn) {
    let handle = 0;
    let pending = null;
    return function throttled(...args) {
      pending = args;
      if (handle) return;
      handle = requestAnimationFrame(() => {
        handle = 0;
        const next = pending;
        pending = null;
        if (next) fn(...next);
      });
    };
  }

  /**
   * Make the pointer position drive a soft highlight inside `element`.
   *
   * Writes two custom properties, which `window.css` reads from a pseudo-element
   * transform — so the only thing that changes per frame is a transform on a
   * decorative node. Returns a disposer.
   */
  function follow(element) {
    if (!element) return () => {};
    const rest = () => {
      const rect = element.getBoundingClientRect();
      element.style.setProperty("--mas-gx", `${Math.round(rect.width / 2)}px`);
      element.style.setProperty("--mas-gy", `${Math.round(rect.height * .18)}px`);
    };
    if (reduced()) {
      rest();
      return () => {};
    }

    const onMove = rafThrottle((event) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      element.style.setProperty("--mas-gx", `${Math.round(event.clientX - rect.left)}px`);
      element.style.setProperty("--mas-gy", `${Math.round(event.clientY - rect.top)}px`);
    });
    const onLeave = rafThrottle(rest);

    element.addEventListener("pointermove", onMove, { passive: true });
    element.addEventListener("pointerleave", onLeave, { passive: true });
    element.addEventListener("pointercancel", onLeave, { passive: true });
    rest();

    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("pointercancel", onLeave);
    };
  }

  /**
   * The short recovery after a drag: the pane settles back rather than snapping.
   *
   * Driven by a class instead of an inline style so the keyframes — and the
   * reduced-motion opt-out — stay in the stylesheet.
   */
  function settle(element) {
    if (!element || reduced()) return;
    element.classList.remove("mas-panel-settling");
    // Reading offsetWidth discards the previous animation; without it, adding
    // the class back on a quick second drag would not restart it.
    void element.offsetWidth;
    element.classList.add("mas-panel-settling");
    setTimeout(() => element.classList.remove("mas-panel-settling"), 400);
  }

  return { reduced, rafThrottle, follow, settle };
})();
