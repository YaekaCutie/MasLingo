// One contextual toolbar. Controls proxy the owning translator's real nodes.
(() => {
  if (globalThis.MAS_quick) return;
  let current = null,
    frame = null;
  const own = (node) =>
    node?.closest?.("[data-maslingo-quick]") ||
    node?.getRootNode?.()?.host?.matches?.("[data-maslingo-quick]");
  function hide(owner) {
    if (!current || (owner && current.options.owner !== owner)) return;
    current.observer?.disconnect();
    current.host.remove();
    current = null;
  }
  function sourceRects(options) {
    if (options.rect) return [options.rect()];
    const range = document.createRange();
    range.selectNodeContents(options.element);
    return [...range.getClientRects()].filter((r) => r.width && r.height);
  }
  function place() {
    frame = null;
    if (!current) return;
    const { host, options, expanded } = current;
    if (!options.element?.isConnected) {
      hide();
      return;
    }
    // A selection may end mid-line. Put its badge at the reading block's
    // end so the button cannot sit on the following unselected words.
    const blockRange = document.createRange();
    blockRange.selectNodeContents(options.element);
    const rects = expanded
      ? sourceRects(options)
      : [...blockRange.getClientRects()].filter((r) => r.width && r.height);
    const rect =
      (!expanded && options.badgeRect?.()) ||
      rects.at(-1) ||
      options.element.getBoundingClientRect();
    if (!expanded) {
      const size = 24,
        gap = 4;
      let left = rect.right + gap,
        top = rect.bottom - size;
      if (left + size > innerWidth - 4) {
        const block = options.element.getBoundingClientRect();
        if (block.left >= size + gap + 4) left = block.left - size - gap;
        else {
          left = innerWidth - size - 4;
          top = rect.bottom + gap;
        }
      }
      host.style.left = `${Math.max(4, left)}px`;
      host.style.top = `${Math.max(4, top)}px`;
      host.style.visibility =
        rect.bottom > 0 && rect.top < innerHeight && top + size <= innerHeight
          ? "visible"
          : "hidden";
      return;
    }
    const bar = host.shadowRoot.querySelector(".bar"),
      hint = host.shadowRoot.querySelector(".scroll-hint");
    hint.hidden = bar.scrollWidth <= bar.clientWidth + 1;
    if (options.inline) return;
    const bounds = options.rect?.() || options.element.getBoundingClientRect();
    const height = host.getBoundingClientRect().height;
    const top =
      bounds.top >= height + 10 ? bounds.top - height - 7 : bounds.bottom + 7;
    host.style.visibility =
      bounds.bottom > 0 &&
      bounds.top < innerHeight &&
      top >= 4 &&
      top + height <= innerHeight - 4
        ? "visible"
        : "hidden";
    host.style.top = `${top}px`;
    host.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - host.getBoundingClientRect().width - 8))}px`;
  }
  function setExpanded(value, focus = false) {
    if (!current) return;
    const { host, options } = current,
      root = host.shadowRoot;
    current.expanded = value;
    root.querySelector(".shell").hidden = !value;
    root.querySelector(".mini").hidden = value;
    root.querySelector(".mini").setAttribute("aria-expanded", String(value));
    host.dataset.expanded = String(value);
    host.style.cssText =
      value && options.inline
        ? "display:block!important;position:relative!important;margin:4px 0!important;max-width:100%!important;clear:both;"
        : `display:block!important;position:fixed!important;z-index:2147483646!important;margin:0!important;${value ? "max-width:calc(100vw - 16px)!important;" : "width:24px!important;max-width:24px!important;height:24px!important;"}visibility:hidden;`;
    if (value && options.inline) {
      if (
        ["TD", "TH", "LI", "DD", "DT", "CAPTION"].includes(
          options.element.tagName,
        )
      )
        options.element.append(host);
      else options.element.after(host);
    } else document.documentElement.append(host);
    current.sync();
    if (focus)
      (value
        ? root.querySelector("select,button:not(.mini)")
        : root.querySelector(".mini")
      )?.focus({ preventScroll: true });
  }
  function schedule() {
    if (frame === null) frame = requestAnimationFrame(place);
  }
  function show(options) {
    if (current?.options.owner === options.owner) {
      current.sync();
      schedule();
      return;
    }
    if (current?.options.selection && !options.selection) return;
    hide();
    const host = document.createElement("div");
    host.dataset.maslingoQuick = "1";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial;color-scheme:light;font:12px/1.5 'Segoe UI','Microsoft YaHei',system-ui;color:#223047}
      *{box-sizing:border-box}button,select{font:inherit;color:inherit}
      button,select{cursor:pointer}button{transition:background .15s,color .15s,border-color .15s,transform .15s}
      .mini{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid #d6e1f8;border-radius:8px;background:#f1f5ff;color:#285de5;font-size:11px;font-weight:650;line-height:1;animation:mini-in .15s ease-out}
      .mini:hover{background:#285de5;border-color:#285de5;color:#fff;transform:translateY(-1px)}.mini:active{transform:scale(.94)}
      .shell{width:max-content;max-width:100%;border:1px solid #dce4f0;border-radius:12px;background:#fff;overflow:hidden;animation:enter .17s ease-out;transform-origin:top left}
      .row{display:flex;align-items:center;max-width:100%;gap:2px;padding-right:4px}
      .bar{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;overflow-x:auto;padding:5px 6px;scrollbar-width:thin;scrollbar-color:#c7d4ec transparent;overscroll-behavior-x:contain}
      .field{position:relative;display:flex;align-items:center;gap:4px;flex:none;padding:0 2px 0 7px;border:1px solid transparent;border-radius:7px;background:#f5f7fb;color:#6c7b91;white-space:nowrap;transition:background .15s,border-color .15s}
      .field:hover{background:#edf2fb}.field:focus-within{border-color:#b9caf0;background:#f2f6ff}
      .field-label{font-size:10px;font-weight:500;letter-spacing:.1px}.field-label:empty{display:none}
      .field::after{content:'';position:absolute;right:8px;top:10px;width:4px;height:4px;border-right:1.3px solid #8190a6;border-bottom:1.3px solid #8190a6;transform:rotate(45deg);pointer-events:none}
      .field-provider,.field-display-mode{background:transparent}.field-provider:hover,.field-display-mode:hover{background:#f5f7fb}
      select{appearance:none;field-sizing:content;max-width:108px;min-height:26px;min-width:48px;margin:0;padding:3px 17px 3px 2px;border:0;border-radius:5px;background:transparent;color:#263750;outline:0;font-size:11px;text-overflow:ellipsis}
      .direction{flex:none;color:#8d9db4;font-size:12px;line-height:1}.divider{flex:none;width:1px;height:14px;margin:0 2px;background:#e5ebf4}
      button:not(.mini){display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;min-height:27px;padding:4px 8px;border:1px solid transparent;border-radius:7px;background:transparent;font-size:11px;font-weight:500;line-height:1.4}
      button.cover{background:#edf3ff;color:#285de5}button.cover:hover{background:#e1ebff;border-color:#cddbf9}button.cover[aria-pressed=true]{background:#285de5;color:#fff}button.cover:active{transform:scale(.97)}
      button.origin,button.retry{color:#285de5}button.origin:hover,button.retry:hover{background:#edf3ff;border-color:#dce4f0}
      button:disabled,select:disabled{opacity:.45;cursor:default}button.cover:disabled:hover{background:#edf3ff;border-color:transparent}
      button:focus-visible,.field:has(select:focus-visible){outline:2px solid #285de5;outline-offset:-2px}
      button.close{width:25px;min-height:25px;margin:0;padding:5px;color:#8493a9;border-radius:7px}button.close:hover{background:#f0f4fa;color:#285de5}svg{display:block;width:12px;height:12px;flex:none;pointer-events:none}
      .preview{margin:1px 7px 7px;padding:6px 9px;border-left:2px solid #c8d8fa;border-radius:0 6px 6px 0;background:#f7f9fd;max-width:620px;max-height:80px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.75;color:#31415a}
      .scroll-hint{padding:0 9px 3px;color:#66758b;font-size:10px;text-align:right}
      .preview:empty,[hidden]{display:none!important}@keyframes enter{from{opacity:0;transform:translateY(-3px) scale(.985)}to{opacity:1;transform:none}}@keyframes mini-in{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
    </style><button class="mini" type="button" aria-label="展开翻译操作" aria-expanded="false" title="展开翻译操作">译</button><div class="shell" hidden><div class="row"><div class="bar" role="toolbar" aria-label="当前文字翻译操作"></div></div><div class="scroll-hint" hidden>左右滚动查看更多选项</div><div class="preview" role="status" aria-live="polite"></div></div>`;
    const bar = root.querySelector(".bar"),
      preview = root.querySelector(".preview");
    const proxies = [];
    for (const control of options.controls) {
      if (!control) continue;
      const proxy = document.createElement(control.tagName.toLowerCase());
      const key = control.classList.contains("src")
        ? "src"
        : control.classList.contains("lang")
          ? "lang"
          : control.classList.contains("provider")
            ? "provider"
            : "display-mode";
      if (key === "lang" && control.tagName === "SELECT") {
        const arrow = document.createElement("span");
        arrow.className = "direction";
        arrow.textContent = "→";
        arrow.setAttribute("aria-hidden", "true");
        bar.append(arrow);
      }
      if (key === "provider" && control.tagName === "SELECT") {
        const divider = document.createElement("span");
        divider.className = "divider";
        divider.setAttribute("aria-hidden", "true");
        bar.append(divider);
      }
      proxy.className = control.className;
      proxy.setAttribute(
        "aria-label",
        control.getAttribute("aria-label") ||
          control.title ||
          control.textContent,
      );
      if (control.tagName === "SELECT") {
        const label = document.createElement("label"),
          text = document.createElement("span");
        label.className = `field field-${key}`;
        text.className = "field-label";
        text.textContent =
          key === "lang" ? "目标" : control.dataset.quickLabel || "";
        label.append(text, proxy);
        bar.append(label);
        proxy.onchange = () => {
          control.value = proxy.value;
          control.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
        };
      } else {
        proxy.type = "button";
        proxy.onclick = () => {
          control.click();
          refresh();
        };
        bar.append(proxy);
      }
      let buttonLabel = null;
      if (control.tagName === "BUTTON") {
        if (control.classList.contains("cover"))
          proxy.innerHTML =
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h9m-2-2 2 2-2 2M13 11H4m2-2-2 2 2 2"/></svg>';
        buttonLabel = document.createElement("span");
        proxy.append(buttonLabel);
      }
      proxies.push({ control, proxy, buttonLabel, signature: "" });
    }
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>';
    close.title = "收起操作条";
    close.setAttribute("aria-label", "收起翻译操作条");
    close.onclick = () => setExpanded(false, true);
    root.querySelector(".mini").onclick = () => setExpanded(true, true);
    root.querySelector(".row").append(close);
    function refresh() {
      for (const pair of proxies) {
        const { control, proxy } = pair;
        if (control.tagName === "SELECT") {
          const signature = control.innerHTML;
          if (pair.signature !== signature) {
            proxy.replaceChildren(
              ...[...control.options].map((o) => {
                const n = new Option(o.text, o.value);
                n.disabled = o.disabled;
                return n;
              }),
            );
            pair.signature = signature;
          }
          proxy.value = control.value;
        } else {
          pair.buttonLabel.textContent = control.textContent;
          const pressed = control.getAttribute("aria-pressed");
          if (pressed !== null) proxy.setAttribute("aria-pressed", pressed);
        }
        proxy.disabled = control.disabled;
        proxy.title = control.title;
        proxy.hidden = control.hidden;
      }
      preview.textContent = options.preview?.() || "";
      schedule();
    }
    const observer = new MutationObserver(refresh);
    observer.observe(options.observe, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    current = { host, options, observer, sync: refresh, expanded: false };
    setExpanded(false);
    // Keep page click-to-turn handlers away from native controls. Preserve a
    // range on button presses; selects keep their native keyboard behaviour.
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
    ])
      host.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "mousedown" && e.composedPath()[0]?.tagName === "BUTTON")
          e.preventDefault();
      });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (current?.expanded) setExpanded(false, true);
        else hide(options.owner);
      }
    });
    refresh();
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (
        current &&
        !e.composedPath().includes(current.host) &&
        !current.options.element.contains(e.target)
      )
        hide();
    },
    true,
  );
  for (const type of ["resize", "scroll"])
    window.addEventListener(type, schedule, { passive: true, capture: true });
  window.addEventListener("pagehide", () => hide());
  globalThis.MAS_quick = {
    show,
    hide,
    refresh(owner) {
      if (!owner || current?.options.owner === owner) current?.sync();
    },
    isOwn: own,
  };
})();
