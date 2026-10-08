/* MasLingo — the material engine.
 *
 * Everything that makes the glass behave like glass rather than like a styled
 * div lives here: where the light is, what the material is currently doing, and
 * when it should stop doing anything at all.
 *
 * ==== Why a RAF loop instead of a CSS transition ====
 *
 * §5 of the specification asks for target → rAF → lerp(current, target) →
 * custom property, with inertia, no jump, and settling within 150–350ms of the
 * pointer stopping. A CSS transition cannot do that: it is a fixed curve starting
 * from wherever the value happened to be, so a fast flick and a slow drift ease
 * identically and the "inertia" is not inertia. The loop below carries velocity
 * implicitly — each frame closes a fixed fraction of the remaining gap, which is
 * an exponential approach that decelerates on its own.
 *
 * It also stops. When the gap closes below half a pixel the loop cancels itself
 * and writes one final value. An idle panel therefore runs no animation frames at
 * all, which is the other half of §19: the material should be still when nothing
 * is happening, rather than looping a highlight forever.
 */

globalThis.MAS_glass = (() => {
  /** Fraction of the remaining distance closed per frame (~250ms to settle). */
  const SMOOTHING = 0.18;
  const SETTLED_PX = 0.5;

  /** Whether the user asked for less movement (§21). */
  function reduced() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /** The material's resting light position: upper third, horizontally centred. */
  function rest(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height * 0.18 };
  }

  /**
   * Drive the specular spot from the pointer.
   *
   * Writes two custom properties per frame on one decorative element. Nothing
   * here reads layout per frame: the element's box is measured on pointer entry,
   * not on every move, so the page scrolling underneath the panel costs nothing.
   *
   * Returns a disposer.
   */
  function track(element) {
    if (!element) return () => {};

    let rect = element.getBoundingClientRect();
    const start = rest(element);
    const state = { tx: start.x, ty: start.y, cx: start.x, cy: start.y, raf: 0 };

    const write = () => {
      element.style.setProperty("--maslingo-mx", `${state.cx.toFixed(1)}px`);
      element.style.setProperty("--maslingo-my", `${state.cy.toFixed(1)}px`);
    };

    const frame = () => {
      const dx = state.tx - state.cx;
      const dy = state.ty - state.cy;
      if (Math.abs(dx) < SETTLED_PX && Math.abs(dy) < SETTLED_PX) {
        state.cx = state.tx;
        state.cy = state.ty;
        write();
        state.raf = 0;
        return;                       // idle: no further frames scheduled
      }
      state.cx += dx * SMOOTHING;
      state.cy += dy * SMOOTHING;
      write();
      state.raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (!state.raf) state.raf = requestAnimationFrame(frame);
    };

    const onEnter = () => {
      rect = element.getBoundingClientRect();
      setState(element, "hover");
    };
    const onMove = (event) => {
      state.tx = event.clientX - rect.left;
      state.ty = event.clientY - rect.top;
      kick();
    };
    const onLeave = () => {
      // Recedes rather than snapping back: the light withdraws.
      const home = rest(element);
      state.tx = home.x;
      state.ty = home.y;
      kick();
      setState(element, "idle");
    };

    write();
    element.addEventListener("pointerenter", onEnter, { passive: true });
    element.addEventListener("pointermove", onMove, { passive: true });
    element.addEventListener("pointerleave", onLeave, { passive: true });
    element.addEventListener("pointercancel", onLeave, { passive: true });

    return () => {
      element.removeEventListener("pointerenter", onEnter);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("pointercancel", onLeave);
      if (state.raf) cancelAnimationFrame(state.raf);
    };
  }

  /**
   * Set the material's interaction state.
   *
   * The stylesheet turns these into lighting changes — see `[data-state="..."]`
   * in glass.css. Naming the states in one place is what stops a hover response
   * and a drag response from being written twice, in two files, with slightly
   * different values.
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
    setTimeout(() => {
      element.classList.remove("maslingo-panel-settling");
      setState(element, "idle");
    }, 420);
  }

  /** Flip the morph that every material layer reads (§8). */
  function setMorph(element, collapsed) {
    if (!element) return;
    // Expanding runs longer than collapsing, per the timing table in §20.
    element.classList.toggle("maslingo-panel-expanding", !collapsed);
    element.classList.toggle("maslingo-panel-collapsed", collapsed);
    setTimeout(() => element.classList.remove("maslingo-panel-expanding"), 700);
  }

  return { reduced, track, setState, settle, setMorph };
})();
