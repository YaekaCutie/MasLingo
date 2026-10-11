/* MasLingo — the material engine.
 *
 * The material is flat acrylic now: a tinted, blurred fill with a noise pass,
 * closed by a 1px border, with no light of its own. What remains here is the
 * behaviour rather than the paint:
 *
 *   track      bind the pane's hover state; there is no highlight to move
 *   setState   one vocabulary for idle / hover / dragging
 *   settle     the short recovery after a drag
 *   setMorph   the expanded/collapsed shape, read by CSS
 *
 * The previous version ran a requestAnimationFrame loop that eased a specular
 * spot toward the pointer. That loop is gone with the specular: a flat surface
 * answers interaction with a fill step and a border step (see [data-state] in
 * glass.css), which are plain CSS transitions — an idle panel now runs no
 * frames for its material at all.
 */

globalThis.MAS_glass = (() => {
  /**
   * Bind the pane's interaction states.
   *
   * Nothing here measures or schedules: hover and drag are answered by tint and
   * border changes in the stylesheet. `refresh` is kept because callers have
   * always been able to say "the pane moved" after a layout change; on a flat
   * material that is a no-op rather than a stale measurement.
   */
  function track(element) {
    if (!element) return { refresh() {}, dispose() {} };

    const onEnter = () => setState(element, "hover");
    const onMove = () => setState(element, "hover");
    const onLeave = () => setState(element, "idle");

    element.addEventListener("pointerenter", onEnter, { passive: true });
    element.addEventListener("pointermove", onMove, { passive: true });
    element.addEventListener("pointerleave", onLeave, { passive: true });
    element.addEventListener("pointercancel", onLeave, { passive: true });

    return {
      refresh() {},
      dispose() {
        element.removeEventListener("pointerenter", onEnter);
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerleave", onLeave);
        element.removeEventListener("pointercancel", onLeave);
      },
    };
  }

  /**
   * Set the material's interaction state.
   *
   * The stylesheet turns these into fill and border changes — see
   * `[data-state="..."]` in glass.css. Naming the states in one place is what
   * stops a hover response and a drag response from being written twice, in two
   * files, with slightly different values.
   */
  function setState(element, next) {
    if (!element) return;
    if (element.dataset.state === next) return;
    // A drag outranks a hover: the pointer is still over the pane while it is
    // being moved, but "dragging" is the more specific truth.
    if (element.dataset.state === "dragging" && next === "hover") return;
    element.dataset.state = next;
  }

  /**
   * The short recovery after a drag (§6: 180–350ms, ease-out, no real bounce).
   *
   * Driven by a class so the keyframes and the reduced-motion opt-out stay in the
   * stylesheet. Reading offsetWidth between removing and re-adding discards the
   * previous run; without it a quick second drag would not restart the animation.
   */
  function settle(element) {
    if (!element) return;
    element.classList.remove("maslingo-panel-settling");
    void element.offsetWidth;
    element.classList.add("maslingo-panel-settling");
    // The timer is stored on the element so a fresh settle can cancel the
    // previous one. Left alone, re-grabbing the pane within the settle window let
    // the old timer fire mid-drag: it stripped the settling class the new release
    // had just added, and — worse — pushed the material to "idle" while the pane
    // was still being moved, killing the border lift and the thickening.
    if (element.__maslingoSettle) clearTimeout(element.__maslingoSettle);
    element.__maslingoSettle = setTimeout(() => {
      element.__maslingoSettle = 0;
      element.classList.remove("maslingo-panel-settling");
      // Only if no drag has started in the meantime.
      if (element.dataset.state !== "dragging") setState(element, "idle");
    }, 420);
  }

  /** Flip the morph the pane's width and radius read. */
  function setMorph(element, collapsed) {
    if (!element) return;
    // Expanding runs longer than collapsing, per the timing table in §20.
    element.classList.toggle("maslingo-panel-expanding", !collapsed);
    element.classList.toggle("maslingo-panel-collapsed", collapsed);
    // Cleared before re-arming: an uncleared timer from an earlier toggle would
    // strip this class mid-transition, silently retiming the running morph from
    // the 460ms expand curve back to the 320ms collapse one.
    if (element.__maslingoExpand) clearTimeout(element.__maslingoExpand);
    element.__maslingoExpand = setTimeout(() => {
      element.__maslingoExpand = 0;
      element.classList.remove("maslingo-panel-expanding");
    }, 700);
  }

  return { track, setState, settle, setMorph };
})();
