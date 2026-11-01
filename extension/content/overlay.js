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
  let captionSequence = 0;
  /** @type {Set<{node: HTMLElement, target: Element|null, place: Function}>} */
  const anchored = new Set();

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.id = LAYER_ID;
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
    // The image itself can sit on fractional CSS pixels at browser zoom or a
    // responsive width. Rounding the repair independently leaves dark fringes.
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  }

  /**
   * Keep a node aligned with a region of an element.
   *
   * `region` is normalised (0-1) within the *image*, so the same numbers work at
   * any display size and survive a window resize without re-running detection.
   */
  function anchor(node, element, region, options = {}) {
    const entry = {
      node,
      target: element,
      region,
      onRelease:options.onRelease,
      place() {
        const natural = {
          width: element.naturalWidth || element.videoWidth || 0,
          height: element.naturalHeight || element.videoHeight || 0,
        };
        const box = contentRect(element, natural.width, natural.height);
        if (!box.width || !box.height) return;
        if (options.place) {
          place(node, options.place(box, region, node));
          return;
        }
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
    if (!anchored.delete(entry)) return;
    entry.node.remove();
    entry.onRelease?.();
  }

  function releaseTarget(element) {
    for (const entry of [...anchored]) {
      if (entry.target === element) release(entry);
    }
  }

  /** Keep the original drawing intact and put uncertain repairs beside it. */
  function caption(element, region, text, options = {}) {
    const sourceId = String(++captionSequence);
    const accent = ["#0e7490","#7c3aed","#a16207"][(captionSequence-1)%3];
    const sourceNode = document.createElement("div");
    sourceNode.id = `maslingo-caption-source-${sourceId}`;
    sourceNode.className = "maslingo-caption-source";
    sourceNode.dataset.sourceId = sourceId;
    sourceNode.style.setProperty("--caption-accent",accent);
    const sourceShadow = sourceNode.attachShadow({mode:"open"});
    sourceShadow.innerHTML = `<style>
      :host{position:absolute;display:block;pointer-events:none;z-index:2147483642;overflow:visible}
      .ring{position:absolute;inset:0;border:2px dashed var(--caption-accent);border-radius:4px;
        background:color-mix(in srgb,var(--caption-accent) 8%,transparent);opacity:0}
      :host([data-active="true"]) .ring{opacity:1}
      button{position:absolute;left:calc(100% + 3px);top:-20px;box-sizing:border-box;min-width:20px;height:20px;padding:0 4px;
        border:1px solid white;border-radius:10px;background:var(--caption-accent);color:white;
        font:600 11px/18px system-ui;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px #0003}
      svg{position:absolute;overflow:visible;pointer-events:none;opacity:0}
      path{fill:none;stroke:var(--caption-accent);stroke-width:1.5;stroke-dasharray:4 3}
      button:focus-visible{outline:2px solid var(--caption-accent);outline-offset:2px}
    </style><svg aria-hidden="true"><path></path></svg><div class="ring"></div><button type="button"></button>`;
    const pinButton = sourceShadow.querySelector("button");
    pinButton.textContent = sourceId;
    pinButton.setAttribute("aria-label",`显示译文 ${sourceId}`);
    pinButton.title = `显示译文 ${sourceId}`;
    const sourceEntry = anchor(sourceNode,element,region);
    const host = document.createElement("div");
    host.id = `maslingo-caption-${sourceId}`;
    host.className = "maslingo-result maslingo-adjacent-translation";
    host.dataset.collapsed = "false";
    host.dataset.sourceId = sourceId;
    host.style.setProperty("--caption-accent",accent);
    host.setAttribute("role", "note");
    host.setAttribute("aria-label", `译文 ${sourceId}，已保留原画`);
    host.setAttribute("aria-details",sourceNode.id);
    pinButton.setAttribute("aria-controls",host.id);
    const shadow = host.attachShadow({mode:"open"});
    shadow.innerHTML = `<style>
      :host { all:initial; position:absolute; display:block; box-sizing:border-box; pointer-events:auto; z-index:2147483642; }
      * { box-sizing:border-box; }
      .card { padding:7px 9px; border:1px solid rgba(30,35,45,.2); border-radius:8px;
        background:rgba(255,255,252,.96); color:#20242a; box-shadow:0 2px 8px rgba(0,0,0,.1);
        font:14px/1.5 "Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif; }
      .head { display:flex; align-items:center; justify-content:space-between; gap:4px; color:#69717a; font-size:11px; }
      .handle { display:flex;align-items:center;gap:3px;cursor:grab;touch-action:none;user-select:none;white-space:nowrap }
      :host([data-dragging="true"]) .handle {cursor:grabbing}
      .handle:focus-visible{outline:2px solid var(--caption-accent);border-radius:3px}
      button { border:0; border-radius:4px; background:transparent; color:#414852; cursor:pointer;
        padding:0 4px; font:16px/20px system-ui; }
      button:hover { background:#e9edf0; } button:focus-visible { outline:2px solid #2563eb; }
      .text { margin:4px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; max-height:160px; overflow:auto; }
      :host([data-collapsed="true"]) .text { display:none; }
      :host([data-collapsed="true"]) .handle-label {display:none}
      .source{font:11px/20px system-ui;color:var(--caption-accent);white-space:nowrap}
    </style><div class="card"><div class="head"><span class="handle" role="button" tabindex="0"><span aria-hidden="true">⠿</span><span class="handle-label">译文</span></span><button class="source" type="button"></button><button class="collapse" type="button" aria-expanded="true" aria-label="收起译文">−</button></div><p class="text"></p></div>`;
    shadow.querySelector(".text").textContent = text;
    const sourceButton = shadow.querySelector(".source");
    sourceButton.textContent = `原文 ${sourceId}`;
    sourceButton.title = options.sourceText ? `原文 ${sourceId}：${options.sourceText}` : `定位原文 ${sourceId}`;
    sourceButton.setAttribute("aria-label",`定位原文 ${sourceId}`);
    sourceButton.setAttribute("aria-controls",sourceNode.id);
    const handle = shadow.querySelector(".handle");
    handle.title = "拖动移动；双击或按 Home 恢复自动位置";
    handle.setAttribute("aria-label",`移动译文 ${sourceId}，方向键调整，Home 归位`);
    let manual = null,drag = null,active = false,flashTimer = null;
    const link = sourceShadow.querySelector("svg"),line = sourceShadow.querySelector("path");
    function activate(value) {
      active = value;
      sourceNode.dataset.active = String(value || Boolean(drag));
      link.style.opacity = value || manual || drag ? ".8" : "0";
    }
    function updateLink(box,area,rect) {
      const sx=box.left+area.left*box.width,sy=box.top+area.top*box.height;
      const pinRect=documentRect(pinButton);
      const start={x:pinRect.left+pinRect.width/2,y:pinRect.top+pinRect.height/2};
      const end={x:Math.max(rect.left,Math.min(start.x,rect.left+rect.width)),
        y:Math.max(rect.top,Math.min(start.y,rect.top+rect.height))};
      const x0=Math.min(start.x,end.x)-4,y0=Math.min(start.y,end.y)-4;
      link.style.left=`${x0-sx}px`;link.style.top=`${y0-sy}px`;
      link.setAttribute("width",Math.abs(start.x-end.x)+8);
      link.setAttribute("height",Math.abs(start.y-end.y)+8);
      line.setAttribute("d",`M${start.x-x0},${start.y-y0} L${end.x-x0},${end.y-y0}`);
      activate(active);
    }
    let entry;
    entry = anchor(host, element, region, {onRelease() {
      clearTimeout(flashTimer);
      release(sourceEntry);
    },place(box, area, node) {
      const left = window.scrollX + 8, right = window.scrollX + window.innerWidth - 8;
      const gutter = Math.max(box.left-left-8, right-box.left-box.width-8);
      let width = node.dataset.collapsed === "true" ? 104 : Math.min(210, Math.max(130, box.width * .34), window.innerWidth - 16);
      if (gutter >= 130) width = Math.min(width,gutter);
      node.style.width = `${width}px`;
      node.style.height = "auto";
      const height = node.getBoundingClientRect().height;
      const source = {left:box.left+area.left*box.width, top:box.top+area.top*box.height,
        width:area.width*box.width, height:area.height*box.height};
      const finish = rect => {updateLink(box,area,rect);return rect;};
      if (manual) return finish({left:Math.max(left,Math.min(box.left+manual.left*box.width,right-width)),
        top:Math.max(8,box.top+manual.top*box.height),width,height});
      const gap = 8;
      const candidates = [
        {left:source.left+source.width+gap,top:source.top},
        {left:source.left-width-gap,top:source.top},
        {left:source.left+source.width+gap,top:source.top+source.height-height},
        {left:source.left-width-gap,top:source.top+source.height-height},
        {left:source.left,top:source.top+source.height+gap},
        {left:source.left,top:source.top-height-gap},
      ];
      if (box.left-width-gap >= left) candidates.push({left:box.left-width-gap,top:source.top});
      if (box.left+box.width+width+gap <= right) candidates.push({left:box.left+box.width+gap,top:source.top});
      for (const candidate of candidates) {
        candidate.left = Math.max(left,Math.min(candidate.left,right-width));
        candidate.top = Math.max(8,candidate.top);
        candidate.width = width;
        candidate.height = height;
      }
      const overlap = (a,b) => Math.max(0,Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left)) *
        Math.max(0,Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top));
      const others = [...anchored].filter(e=>e.node!==node && e.node.classList.contains("maslingo-adjacent-translation"))
        .map(e=>documentRect(e.node));
      const protectedAreas = [...anchored].filter(e=>e.node!==node &&
        (e.node.classList.contains("maslingo-box") ||
         (e.node.classList.contains("maslingo-result") && !e.node.classList.contains("maslingo-adjacent-translation"))))
        .map(e=>documentRect(e.node));
      for (const other of anchored) {
        if (other.node!==node && other.target===element && other.node.classList.contains("maslingo-adjacent-translation")) {
          const r=other.region;
          protectedAreas.push({left:box.left+r.left*box.width,top:box.top+r.top*box.height,
            width:r.width*box.width,height:r.height*box.height});
        }
      }
      const score = candidate => overlap(candidate,source)*1000 +
        protectedAreas.reduce((sum,r)=>sum+overlap(candidate,r)*100,0) +
        others.reduce((sum,r)=>sum+overlap(candidate,r)*200,0) + overlap(candidate,box)*.5 +
        (Math.abs(candidate.left+width/2-source.left-source.width/2)+
         Math.abs(candidate.top+height/2-source.top-source.height/2))*2;
      candidates.sort((a,b)=>score(a)-score(b));
      return finish(candidates[0]);
    }});
    shadow.querySelector(".collapse").addEventListener("click", () => {
      const collapsed = host.dataset.collapsed !== "true";
      host.dataset.collapsed = String(collapsed);
      const button = shadow.querySelector(".collapse");
      button.textContent = collapsed ? "+" : "−";
      button.setAttribute("aria-expanded",String(!collapsed));
      button.setAttribute("aria-label",collapsed ? "展开译文" : "收起译文");
      entry.place();
    });
    function move(left,top) {
      const box=contentRect(element,element.naturalWidth||0,element.naturalHeight||0);
      if(!box.width||!box.height)return;
      manual={left:(left-box.left)/box.width,top:(top-box.top)/box.height};
      host.dataset.moved="true";
      entry.place();
    }
    function resetPosition() {
      manual=null;delete host.dataset.moved;entry.place();
    }
    handle.addEventListener("pointerdown",event=>{
      if (event.button!==0) return;
      event.preventDefault();
      handle.focus({preventScroll:true});
      const rect=documentRect(host);
      drag={id:event.pointerId,x:event.clientX+scrollX,y:event.clientY+scrollY,left:rect.left,top:rect.top};
      host.dataset.dragging="true";
      handle.setPointerCapture(event.pointerId);
      activate(true);
    });
    handle.addEventListener("pointermove",event=>{
      if (!drag || drag.id!==event.pointerId) return;
      move(drag.left+event.clientX+scrollX-drag.x,drag.top+event.clientY+scrollY-drag.y);
    });
    function finishDrag(event) {
      if (!drag || drag.id!==event.pointerId) return;
      drag=null;delete host.dataset.dragging;
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      activate(true);
    }
    handle.addEventListener("pointerup",finishDrag);
    handle.addEventListener("pointercancel",finishDrag);
    handle.addEventListener("dblclick",resetPosition);
    handle.addEventListener("keydown",event=>{
      if(event.key==="Home"){event.preventDefault();resetPosition();return;}
      const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(!direction)return;
      event.preventDefault();const r=documentRect(host),step=event.shiftKey?24:8;
      move(r.left+direction[0]*step,r.top+direction[1]*step);
    });
    function flash() {
      clearTimeout(flashTimer);activate(true);
      flashTimer=setTimeout(()=>activate(host.matches(":hover")||host.matches(":focus-within")),2200);
    }
    sourceButton.addEventListener("click",()=>{
      const r=documentRect(sourceNode);
      window.scrollTo({left:Math.max(0,r.left-innerWidth*.5),top:Math.max(0,r.top-innerHeight*.35),
        behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
      flash();
    });
    pinButton.addEventListener("click",()=>{host.scrollIntoView({block:"nearest",inline:"nearest"});sourceButton.focus({preventScroll:true});flash();});
    for(const type of ["pointerenter","focusin"])host.addEventListener(type,()=>activate(true));
    host.addEventListener("pointerleave",()=>{if(!host.matches(":focus-within")&&!drag)activate(false);});
    host.addEventListener("focusout",()=>queueMicrotask(()=>{if(!host.matches(":hover")&&!host.matches(":focus-within")&&!drag)activate(false);}));
    for (const node of [host,sourceNode]) for (const type of ["pointerdown","pointerup","pointermove","pointercancel","mousedown","mouseup","click","dblclick"]) {
      node.addEventListener(type,event=>event.stopPropagation());
    }
    return entry;
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
          release(entry);
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
    releaseTarget,
    caption,
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
    node.setAttribute("aria-hidden", "true");
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

  /** Whether this is the frame the user is looking at. */
  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;   // cross-origin parent: a subframe by definition
    }
  }

  function show(text, { once = true, kind = "info" } = {}) {
    // Page-level chrome belongs to the top frame.
    //
    // Auto translate runs in every frame, so a reader that hosts the manga in
    // an iframe produced a notice inside that iframe as well — clipped to it
    // and parked wherever the iframe sits — on top of the top frame's own.
    // Seen live: two "已检测到漫画，正在自动翻译" banners a few pixels apart.
    // The top frame starts scanning whenever the feature is on, so gating here
    // still announces the run exactly once, in the one place the corner is real.
    if (!isTopFrame()) return;
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
