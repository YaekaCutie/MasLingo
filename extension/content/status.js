/* MasLingo — the status surface.
 *
 * An independent glass pane in the lower right corner, built from the same five
 * material layers as the control window. §7 asks that separate glass elements
 * read as one material rather than as several unrelated cards, and sharing the
 * layer classes is how that is guaranteed rather than approximated.
 *
 * ==== Never rebuilt ====
 *
 * §11 asks that a content change update the existing surface instead of tearing
 * the DOM down and building it again. Rebuilding would restart the backdrop
 * filter on every message — a visible flash on the compositor — and would throw
 * away the entry animation, so the surface is created once, kept mounted, and
 * only its text, its state colour and its `data-kind` are written. Hiding is an
 * opacity change plus `visibility`, not a removal.
 *
 * ==== One line, four colours ====
 *
 * The text is replaced, never appended: a log next to the artwork is exactly what
 * this is meant not to be. Colour is limited to the four status values and is
 * only ever applied to the dot and the text — never to the pane's background.
 */

globalThis.MAS_status = (() => {
  let root = null;
  let timer = null;

  /** Whether this is the frame the user is looking at. */
  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;   // cross-origin parent: a subframe by definition
    }
  }

  function build() {
    const node = document.createElement("div");
    node.id = "maslingo-status";
    node.className = "maslingo-status maslingo-surface";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.dataset.kind = "info";
    // The five layers, in order. aria-hidden because they carry no meaning: the
    // role/status text below is the accessible content.
    node.innerHTML = `
      <div class="maslingo-glass__base" aria-hidden="true"></div>
      <div class="maslingo-glass__depth" aria-hidden="true"></div>
      <div class="maslingo-glass__edge" aria-hidden="true"></div>
      <div class="maslingo-glass__specular" aria-hidden="true"><i></i></div>
      <div class="maslingo-status-line">
        <span class="maslingo-status-dot" aria-hidden="true"></span>
        <span class="maslingo-status-text"></span>
      </div>
    `;
    return node;
  }

  function ensure() {
    // Top frame only. Auto translate runs in every frame, so without this gate
    // any iframe holding a large image grew its own status pane clipped inside
    // itself — two status surfaces for one run, and one per ad frame.
    if (!isTopFrame()) return null;
    if (root && root.isConnected) return root;
    root = build();
    // documentElement, not body: a page that replaces its body keeps the panel.
    document.documentElement.appendChild(root);
    return root;
  }

  /**
   * Show one line, or clear it.
   *
   * `kind` is the four-value status vocabulary — info / working / ok / error —
   * and it drives both the dot's colour and its one-shot animation.
   */
  function show(text, kind = "info") {
    let node;
    try {
      node = ensure();
    } catch {
      return;                       // extension APIs unreachable in this frame
    }
    if (!node) return;              // a subframe: nothing to show here

    if (!node) return;
    const line = node.querySelector(".maslingo-status-text");
    if (line.textContent !== text) line.textContent = text;

    // Only write when it changed: assigning an identical value still invalidates
    // style, and this runs on every progress step.
    if (node.dataset.kind !== kind) node.dataset.kind = kind;
    node.classList.toggle("maslingo-status-active", kind !== "info");

    if (timer) clearTimeout(timer);
    timer = null;

    if (!text) {
      hide();
      return;
    }

    node.classList.remove("maslingo-status-out");
    node.classList.add("maslingo-status-in");

    // Errors stay long enough to be read and acted on; progress does not need to
    // linger once it has been understood.
    const dwell = kind === "error" ? 9000 : 4200;
    timer = setTimeout(hide, dwell);
  }

  /** Fade out without unmounting. See the note above about never rebuilding. */
  function hide() {
    if (!root) return;
    if (timer) clearTimeout(timer);
    timer = null;
    root.classList.remove("maslingo-status-in");
    root.classList.add("maslingo-status-out");
  }

  /** Tear down for good — only used when the page is going away. */
  function destroy() {
    if (timer) clearTimeout(timer);
    timer = null;
    root?.remove();
    root = null;
  }

  return { show, hide, destroy, get element() { return root; } };
})();
