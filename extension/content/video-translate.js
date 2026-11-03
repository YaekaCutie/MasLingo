// Per-video captions. Nothing is read or sent until the user starts a mode.
(() => {
  if (globalThis.MAS_video) return;
  const players = new Map();
  let preferences = { videoDisplayMode: "bilingual" };
  let audioOwner = null;
  const send = message => chrome.runtime.sendMessage(message);
  const clean = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  const PAIR_WAIT_MS = 20000;
  const MAX_WAITING_CUES = 16;
  const MAX_PREPARED_TEXTS = 2500;
  const MIN_AUDIO_MS = 1400;
  const MAX_AUDIO_MS = 5000;
  const AUDIO_PAUSE_MS = 220;
  const MIN_SPEECH_RMS = 0.006;
  const preferenceKeys = ["videoDisplayMode", "translationProvider", "translationMode"];
  const plainCue = cue => clean(cue.getCueAsHTML ? cue.getCueAsHTML().textContent : cue.text);
  const domSelectors = ".ytp-caption-window-container, .bpx-player-subtitle-panel, .bilibili-player-video-subtitle";
  const playerSelector = "media-controller, #movie_player, .html5-video-player, .bpx-player-container, .bilibili-player, .video-js, .jwplayer, .plyr, .shaka-video-container, .mejs__container";

  function trackTexts(cues) {
    // Reproduce the text shown at each boundary, including overlapping cues.
    const boundaries = [];
    for (const [index, cue] of Array.from(cues).entries()) {
      if (cue.endTime <= cue.startTime) continue;
      const text = plainCue(cue);
      if (!text) continue;
      boundaries.push({ time: cue.startTime, index, text }, { time: cue.endTime, index });
    }
    boundaries.sort((a, b) => a.time - b.time);
    const active = new Map();
    const texts = new Set();
    for (let i = 0; i < boundaries.length;) {
      const time = boundaries[i].time;
      do {
        const { index, text } = boundaries[i++];
        if (text) active.set(index, text);
        else active.delete(index);
      } while (boundaries[i]?.time === time);
      const text = clean([...active].sort(([a], [b]) => a - b).map(([, line]) => line).join(" "));
      if (text) texts.add(text);
      if (texts.size > MAX_PREPARED_TEXTS) break;
    }
    return texts;
  }

  function attach(video) {
    const host = document.createElement("div");
    host.dataset.maslingoVideo = "1";
    host.style.cssText = "position:relative;display:none;box-sizing:border-box;clear:both;margin:8px 0;max-width:100%;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{font:12px/1.5 system-ui;color:#202124}*{box-sizing:border-box}
      .float{width:max-content;max-width:100%}
      .surface,.settings{background:#fff;border:1px solid #dce3ee;border-radius:10px;box-shadow:0 2px 8px #1d35541c;pointer-events:auto}
      .surface{display:flex;align-items:flex-start;gap:6px;width:max-content;max-width:100%;padding:4px;cursor:grab;touch-action:none;user-select:none}
      .surface:active,.gear:active{cursor:grabbing}
      .gear{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;cursor:grab}
      .gear[aria-expanded=true]{color:#285de5;background:#edf3ff;border-color:#c6d6fa}
      .settings{display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:360px;max-width:100%;max-height:50vh;overflow:auto;margin-top:5px;padding:8px}
      button,select{font:inherit;color:inherit;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;padding:3px 6px;min-height:27px;cursor:pointer;max-width:100%}
      button[aria-pressed=true]{background:#285de5;color:#fff}button:disabled{opacity:.5;cursor:default}
      .status,.prepare-status{flex-basis:100%;color:#62656b;overflow-wrap:anywhere;font-size:11px}
      .status:empty,.prepare-status:empty{display:none}
      [hidden]{display:none!important}
      button:focus-visible,select:focus-visible{outline:2px solid #285de5;outline-offset:2px}
      button{transition:background .16s}button:hover{background:#f3f6fc}button[aria-pressed=true]:hover{background:#194bc8}
      .caption{min-width:0;text-align:left;white-space:pre-line;overflow-wrap:anywhere;font:14px/1.65 system-ui;color:#18212f;padding:4px 6px}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
      .caption:empty{display:none}
    </style><div class="float"><div class="surface">
      <div class="caption" aria-live="off"></div>
      <button class="gear" type="button" aria-label="字幕设置" aria-expanded="false" aria-controls="settings" title="字幕设置，可拖动浮窗">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="m10 3-.5 2.3-1.7 1L5.5 5.6l-2 3.4 1.7 1.6v2.1L3.5 14l2 3.4 2.3-.7 1.7 1L10 20h4l.5-2.3 1.7-1 2.3.7 2-3.4-1.7-1.3v-2.1L20.5 9l-2-3.4-2.3.7-1.7-1L14 3z"/>
          <circle cx="12" cy="11.5" r="3"/>
        </svg>
      </button>
    </div><div class="settings" id="settings" aria-label="字幕设置" hidden><button class="start" aria-pressed="false">翻译字幕</button>
      <button class="speech" aria-pressed="false" title="共享当前标签页声音，音频发送给设置中的后端；仅文字发给翻译来源">无字幕识别</button>
      <select class="mode" aria-label="字幕显示模式"><option value="bilingual">双语对照</option><option value="translated">纯译文</option><option value="source">纯原文</option></select>
      <select class="track" aria-label="字幕轨"><option value="auto">自动选择字幕</option></select>
      <button class="prepare" aria-describedby="prepare-status">预翻译字幕轨</button>
      <button class="dock" hidden>移回视频下方</button>
      <span class="prepare-status" id="prepare-status" role="status"></span>
      <span class="status" role="status"></span></div></div>`;
    function placeHost(rect) {
      let anchor = video.closest(playerSelector) || video;
      // The player may be inside a fixed-size flex stack that also holds its
      // poster. Adding a sibling inside that stack can shrink the player.
      for (let parent = anchor.parentElement; parent && parent !== document.body; parent = anchor.parentElement) {
        const positioned = /^(absolute|fixed)$/.test(getComputedStyle(anchor).position);
        const parentRect = parent.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const sameFrame = ["top", "right", "bottom", "left"].every(
          edge => Math.abs(parentRect[edge] - anchorRect[edge]) <= 2,
        );
        const clipped = /^(hidden|clip)$/.test(getComputedStyle(parent).overflowY) &&
          parentRect.bottom <= Math.max(rect.bottom, anchorRect.bottom) + 2;
        if (!positioned && !sameFrame && !clipped && !parent.matches(playerSelector)) break;
        anchor = parent;
      }
      let previous = host.previousElementSibling;
      while (previous?.matches("[data-maslingo-video]")) previous = previous.previousElementSibling;
      if (previous !== anchor) anchor.after(host);
      const panelRect = host.getBoundingClientRect();
      if (panelRect.left < rect.right && panelRect.right > rect.left) {
        // Also cover player layouts whose video extends past the height they
        // reserve in normal flow. Account for the gap already applied.
        const margin = parseFloat(host.style.marginTop) || 0;
        const needed = Math.max(8, Math.ceil(margin + rect.bottom + 8 - panelRect.top));
        if (margin !== needed) host.style.marginTop = `${needed}px`;
      }
    }
    const $ = selector => root.querySelector(selector);
    const surface = $(".surface");
    const gear = $(".gear");
    let position = null;
    let drag = null;
    let suppressClick = false;

    function placeFloating() {
      const { width, height } = $(".float").getBoundingClientRect();
      const left = Math.max(8, Math.min(position.x, document.documentElement.clientWidth - width - 8));
      const top = Math.max(8, Math.min(position.y, document.documentElement.clientHeight - height - 8));
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    }
    function showSettings(open) {
      $(".settings").hidden = !open;
      gear.setAttribute("aria-expanded", String(open));
      if (position) placeFloating();
    }
    surface.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      const rect = surface.getBoundingClientRect();
      const capture = event.composedPath().includes(gear) ? gear : surface;
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, capture };
      capture.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!suppressClick && Math.hypot(dx, dy) < 5) return;
      suppressClick = true;
      position = { x: drag.left + dx, y: drag.top + dy };
      if (host.parentNode !== document.documentElement) {
        document.documentElement.append(host);
        drag.capture.setPointerCapture(event.pointerId);
        host.style.position = "fixed";
        host.style.zIndex = "2147483646";
        host.style.margin = "0";
        host.style.maxWidth = "calc(100vw - 16px)";
        $(".dock").hidden = false;
      }
      placeFloating();
    });
    for (const type of ["pointerup", "pointercancel"]) {
      surface.addEventListener(type, event => { if (drag?.id === event.pointerId) drag = null; });
    }
    gear.onclick = event => {
      if (suppressClick && event.detail) return;
      showSettings($(".settings").hidden);
    };
    root.addEventListener("keydown", event => {
      if (event.key !== "Escape" || $(".settings").hidden) return;
      event.stopPropagation();
      showSettings(false);
      gear.focus({ preventScroll: true });
    });
    $(".dock").onclick = () => {
      position = null;
      host.style.position = "relative";
      host.style.zIndex = "";
      host.style.margin = "8px 0";
      host.style.maxWidth = "100%";
      host.style.left = host.style.top = "";
      $(".dock").hidden = true;
      tick();
      gear.focus({ preventScroll: true });
    };
    const state = { video, host, root, enabled: false, generation: 0, translationRevision: 0, cache: new Map(), inflight: 0, prefetching: false,
      modes: new Map(), hiddenDom: new Map(), sourceTrack: null, output: null, lastOutput: "",
      hasTracks: false, preparation: null,
      currentCue: null, waitingCues: [], showing: null, lagged: false,
      stream: null, recorder: null, audioContext: null, audioMeter: null,
      speech: false, speechBusy: false, speechText: "", speechUntil: 0, audioQueue: [], timer: null };
    players.set(video, state);
    const status = text => { $(".status").textContent = text; };
    const mode = () => $(".mode").value;
    $(".mode").value = globalThis.MAS_webDisplayMode(preferences.videoDisplayMode);

    function clearOutput() {
      $(".caption").textContent = "";
      if (state.output) for (const cue of [...(state.output.cues || [])]) state.output.removeCue(cue);
      state.lastOutput = "";
    }
    function resetTimeline() {
      state.generation++;
      state.currentCue = null;
      state.waitingCues.length = 0;
      state.showing = null;
      state.lagged = false;
      state.audioQueue.length = 0;
      state.speechText = "";
      clearOutput();
    }
    function reset() {
      state.translationRevision++;
      state.cache.clear();
      state.preparation = null;
      $(".prepare-status").textContent = "";
      resetTimeline();
    }
    function restoreSources() {
      state.sourceTrack?.removeEventListener("cuechange", tick);
      for (const [track, saved] of state.modes) track.mode = saved;
      state.modes.clear(); state.sourceTrack = null;
      for (const [element, saved] of state.hiddenDom) {
        if (saved.value) element.style.setProperty("visibility", saved.value, saved.priority);
        else element.style.removeProperty("visibility");
      }
      state.hiddenDom.clear();
    }
    function stopCapture() {
      clearTimeout(state.timer);
      const stream = state.stream;
      state.stream = null;
      if (state.recorder?.state === "recording") state.recorder.stop();
      state.recorder = null;
      state.audioContext?.close().catch(() => {});
      state.audioContext = null;
      state.audioMeter = null;
      stream?.getTracks().forEach(track => track.stop());
      if (audioOwner === state) audioOwner = null;
    }
    function stopSpeech() {
      state.speech = false;
      stopCapture();
      $(".speech").setAttribute("aria-pressed", "false");
      $(".speech").textContent = "无字幕识别";
    }
    function stop() {
      state.enabled = false;
      stopSpeech(); reset(); restoreSources();
      if (state.output) state.output.mode = "disabled";
      $(".start").setAttribute("aria-pressed", "false");
      $(".start").textContent = "翻译字幕";
      status("");
    }
    state.stop = stop;
    state.reset = reset;
    function start() {
      state.enabled = true;
      $(".start").setAttribute("aria-pressed", "true");
      $(".start").textContent = "停止字幕";
    }
    $(".start").onclick = () => { if (state.enabled) stop(); else { start(); tick(); } };
    $(".mode").onchange = () => { chrome.storage.local.set({ videoDisplayMode: mode() }); clearOutput(); tick(); };
    $(".track").onchange = () => { restoreSources(); reset(); tick(); };

    function updateTracks() {
      const tracks = [...video.textTracks].filter(t => t !== state.output && ["subtitles", "captions"].includes(t.kind));
      state.hasTracks = tracks.length > 0;
      const signature = tracks.map(t => `${t.label}:${t.language}`).join("|");
      if ($(".track").dataset.signature !== signature) {
        $(".track").dataset.signature = signature;
        const selected = $(".track").value;
        $(".track").replaceChildren(new Option("自动选择字幕", "auto"), ...tracks.map((t, i) => new Option(t.label || t.language || `字幕 ${i + 1}`, String(i))));
        if ([...$(".track").options].some(o => o.value === selected)) $(".track").value = selected;
      }
      $(".track").hidden = tracks.length < 2;
      if (!state.enabled) return;
      if (state.speech) {
        for (const track of tracks) if (track.mode === "showing") {
          if (!state.modes.has(track)) state.modes.set(track, track.mode);
          track.mode = "hidden";
        }
        return;
      }
      const chosen = $(".track").value === "auto"
        ? tracks.find(t => t.mode === "showing") || (tracks.includes(state.sourceTrack) ? state.sourceTrack : tracks[0])
        : tracks[Number($(".track").value)];
      if (chosen !== state.sourceTrack) {
        restoreSources();
        reset();
        state.sourceTrack = chosen;
        chosen?.addEventListener("cuechange", tick);
      }
      for (const track of tracks) {
        if (!state.modes.has(track)) state.modes.set(track, track.mode);
        if (track === chosen || track.mode === "showing") track.mode = "hidden";
      }
    }

    const prepareButton = $(".prepare");
    const prepareStatus = $(".prepare-status");
    function setPrepareStatus(message) {
      if (prepareStatus.textContent !== message) prepareStatus.textContent = message;
    }
    function finishPreparation(message) {
      state.preparation.running = false;
      prepareButton.textContent = "预翻译字幕轨";
      if (state.preparation.ready) prepareButton.disabled = true;
      setPrepareStatus(message);
    }
    prepareButton.onclick = () => {
      if (state.preparation?.running) {
        finishPreparation("已停止预翻译，已译字幕仍可使用。");
      } else {
        start();
        updateTracks();
        if (!state.sourceTrack) return;
        state.preparation = { running: true, ready: false, texts: null, deadline: performance.now() + 8000 };
      }
      tick();
    };

    function prepareCaptions(now) {
      const job = state.preparation;
      const available = state.hasTracks && !state.speech && mode() !== "source";
      if (!available && job?.running) finishPreparation("预翻译已停止。");
      prepareButton.disabled = !available || Boolean(job?.ready);
      const label = job?.running ? "停止预翻译" : "预翻译字幕轨";
      if (prepareButton.textContent !== label) prepareButton.textContent = label;
      if (!job) {
        setPrepareStatus(!state.hasTracks || state.speech ? "预翻译需要可读取的完整字幕轨。" :
          mode() === "source" ? "选择双语或纯译文后可预翻译。" : "可暂停视频，等字幕预翻译完成后再播放。");
      }
      if (!job?.running) return;
      if (!job.texts) {
        const cues = state.sourceTrack?.cues;
        if (!cues?.length) {
          if (now >= job.deadline) finishPreparation("未读取到字幕，可加载播放器字幕后重试。");
          else setPrepareStatus("正在加载字幕轨…");
          return;
        }
        const texts = trackTexts(cues);
        if (!texts.size || texts.size > MAX_PREPARED_TEXTS) {
          finishPreparation(texts.size ? `字幕超过 ${MAX_PREPARED_TEXTS} 条，可随播放翻译。` : "字幕轨没有可翻译的文字。");
          return;
        }
        job.texts = texts;
        for (const text of texts) if (state.cache.get(text)?.error) state.cache.delete(text);
      }
      const remaining = [];
      let completed = 0;
      for (const text of job.texts) {
        const entry = state.cache.get(text);
        if (entry?.text) completed++;
        else if (entry?.error) {
          finishPreparation(`预翻译已停止（${completed} / ${job.texts.size}）：${entry.error}`);
          return;
        } else if (!entry) remaining.push(text);
      }
      if (completed === job.texts.size) {
        job.ready = true;
        resetTimeline();
        finishPreparation(`已预翻译 ${completed} 条字幕，可以播放。`);
      } else {
        setPrepareStatus(`正在预翻译 ${completed} / ${job.texts.size}…`);
        translate(remaining);
      }
    }

    function translate(texts, prefetch = false) {
      if (mode() === "source" || state.inflight >= 2 || (prefetch && state.prefetching)) return;
      const registry = globalThis.MAS_providers;
      const provider = registry?.byId(registry.resolveProviderId(preferences));
      // Single-text providers are serialized by the worker. A large batch
      // would keep even its first translation waiting for later requests.
      const batchSize = provider?.perRequest ? 1 : 4;
      const fresh = [...new Set(texts)].filter(text => text && !state.cache.has(text)).slice(0, batchSize);
      if (!fresh.length) return;
      const revision = state.translationRevision;
      for (const text of fresh) state.cache.set(text, { pending: true });
      state.inflight++;
      if (prefetch) state.prefetching = true;
      send({ type: "TRANSLATE_TEXT_BLOCKS", texts: fresh, source: "自动识别" }).then(result => {
        if (revision !== state.translationRevision || !state.enabled) return;
        if (!result?.ok) throw new Error(result?.reason || "字幕翻译失败");
        fresh.forEach((text, i) => {
          const translation = clean(result.translations?.[i]);
          state.cache.set(text, translation ? { text: translation } : { error: "服务未返回该句译文" });
        });
        if (state.cache.size > 800) {
          const protectedTexts = new Set(state.waitingCues.map(cue => cue.text));
          protectedTexts.add(state.currentCue?.text);
          for (const [text, entry] of state.cache) {
            if (state.cache.size <= 600) break;
            if (!entry.pending && !protectedTexts.has(text) && !state.preparation?.texts?.has(text)) state.cache.delete(text);
          }
        }
      }).catch(error => {
        if (revision !== state.translationRevision) return;
        fresh.forEach(text => state.cache.set(text, { error: error.message }));
      }).finally(() => {
        state.inflight--;
        if (prefetch) state.prefetching = false;
      });
    }

    function readCaptions(now) {
      if (state.speech) return { text: now < state.speechUntil ? state.speechText : "", upcoming: [] };
      const track = state.sourceTrack;
      if (track) {
        const cues = [...(track.cues || [])];
        const active = cues.filter(c => c.startTime <= video.currentTime && c.endTime > video.currentTime);
        return {
          text: clean(active.map(plainCue).join(" ")),
          upcoming: cues.filter(c => c.startTime > video.currentTime && c.startTime < video.currentTime + 30).slice(0, 10).map(plainCue),
        };
      }
      const scope = video.closest("#movie_player, .bpx-player-container, .bilibili-player") || video.parentElement;
      const elements = [...(scope?.querySelectorAll(domSelectors) || [])];
      for (const element of elements) {
        if (!state.hiddenDom.has(element)) state.hiddenDom.set(element, { value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") });
        element.style.setProperty("visibility", "hidden", "important");
      }
      return { text: clean(elements.map(e => e.textContent).join(" ")), upcoming: [], rolling: true };
    }

    function observeCue(text, rolling, now) {
      const previous = state.currentCue;
      if (text === (previous?.text || "")) return;
      // Some players build a cue word by word. Give a growing prefix a short
      // window to settle before asking for its translation.
      if (text && rolling && previous && now < previous.readyAt &&
          !state.cache.has(previous.text) && text.startsWith(previous.text)) {
        previous.text = text;
        previous.readyAt = Math.min(previous.at + 450, now + 180);
        return;
      }
      if (previous) previous.readyAt = Math.min(previous.readyAt, now);
      state.currentCue = text ? { text, at: now, readyAt: now + (rolling ? 180 : 0) } : null;
      if (!state.currentCue) return;
      state.waitingCues.push(state.currentCue);
      if (state.waitingCues.length > MAX_WAITING_CUES) {
        state.waitingCues.shift();
        state.lagged = true;
      }
    }

    function presentCaptions({ text, upcoming, rolling }, now) {
      if (mode() === "source") {
        state.currentCue = null;
        state.waitingCues.length = 0;
        state.showing = null;
        render(text);
        status(text ? "显示原文" : idleStatus());
        return;
      }
      const prepared = state.preparation;
      if (prepared?.ready && text && !prepared.texts.has(text)) {
        prepared.ready = false;
        prepareButton.disabled = false;
        setPrepareStatus("字幕轨出现了新内容，可以再次预翻译。");
      }
      if (prepared?.ready) {
        // Prepared tracks follow the media clock, including brief cues and gaps.
        state.currentCue = null;
        state.waitingCues.length = 0;
        state.showing = null;
        const translated = state.cache.get(text)?.text;
        render(mode() === "translated" ? (translated || "") :
          [text, translated === text ? "" : translated].filter(Boolean).join("\n"));
        status(text ? "字幕已同步" : idleStatus());
        return;
      }
      observeCue(text, rolling, now);
      const nextRequest = state.waitingCues.find(cue => cue.readyAt <= now && !state.cache.has(cue.text));
      if (nextRequest) translate([nextRequest.text]);
      else if (!state.preparation?.running && !state.preparation?.ready) translate(upcoming, true);

      const showing = state.showing;
      if (!showing || (showing.cue !== state.currentCue && now >= showing.until &&
          !(video.ended && !state.waitingCues.length))) {
        const next = state.waitingCues[0];
        const entry = next && state.cache.get(next.text);
        if (next && (entry?.text || entry?.error || now - next.at >= PAIR_WAIT_MS)) {
          state.waitingCues.shift();
          state.showing = {
            cue: next, translation: entry?.text,
            error: entry?.error || (!entry?.text ? "译文等待超时" : ""),
            until: now + (next === state.currentCue ? 650 : 1400),
          };
        } else {
          state.showing = null;
        }
      }

      const ready = state.showing;
      const output = !ready ? "" : mode() === "translated" ? (ready.translation || "")
        : [ready.cue.text, ready.translation === ready.cue.text ? "" : ready.translation].filter(Boolean).join("\n");
      render(output);
      if (ready?.error) status(`字幕翻译失败：${ready.error}`);
      else if (state.lagged) status("处理速度跟不上播放，已跳过过期片段");
      else if (ready && ready.cue !== state.currentCue) status("正在补显示晚到的字幕");
      else if (state.waitingCues.length) status("正在翻译字幕…");
      else status(ready ? (state.speech ? "已显示语音字幕" : "字幕已同步") : idleStatus());
    }

    function idleStatus() {
      if (state.speech) return state.stream ? "正在识别标签页声音…" : "语音采集已结束";
      return state.sourceTrack ? "等待当前字幕…" : "未发现字幕，请在播放器开启字幕，或点击无字幕识别";
    }

    function render(text) {
      const fullscreen = document.fullscreenElement?.contains(video) || document.pictureInPictureElement === video;
      if (fullscreen) {
        $(".caption").textContent = "";
        if (!state.output) state.output = video.addTextTrack("subtitles", "MasLingo", "");
        state.output.mode = "showing";
        // Short rolling native cues also work in a video-only fullscreen player.
        if (state.lastOutput !== text || !state.output.activeCues?.length) {
          for (const cue of [...(state.output.cues || [])]) state.output.removeCue(cue);
          if (text) state.output.addCue(new VTTCue(video.currentTime, video.currentTime + 0.6, text.replace(/&/g, "&amp;").replace(/</g, "&lt;")));
        }
      } else {
        if (state.output) state.output.mode = "disabled";
        if ($(".caption").textContent !== text) $(".caption").textContent = text;
      }
      state.lastOutput = text;
    }

    function tick() {
      if (!video.isConnected) { stop(); host.remove(); players.delete(video); return; }
      const rect = video.getBoundingClientRect();
      const full = document.fullscreenElement;
      const showPanel = rect.width >= 200 && rect.height >= 100 && !full && document.pictureInPictureElement !== video;
      host.style.display = showPanel ? "block" : "none";
      if (showPanel) {
        host.style.width = `${Math.min(640, rect.width)}px`;
        if (position) placeFloating();
        else placeHost(rect);
      }
      updateTracks();
      prepareCaptions(performance.now());
      if (!state.enabled) return;
      const now = performance.now();
      presentCaptions(readCaptions(now), now);
    }
    state.tick = tick;
    state.openSettings = () => { showSettings(true); gear.focus({ preventScroll: true }); };

    async function transcribeNext() {
      if (!state.speech || state.speechBusy) return;
      const clip = state.audioQueue.shift();
      if (!clip) return;
      state.speechBusy = true;
      try {
        const audio = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(clip.blob);
        });
        if (clip.generation !== state.generation || !state.speech) return;
        const response = await send({ type: "TRANSCRIBE_VIDEO_AUDIO", audio });
        if (clip.generation !== state.generation || !state.speech) return;
        if (!response?.ok) throw new Error(response?.reason || "语音识别失败");
        if (performance.now() - clip.capturedAt > PAIR_WAIT_MS) {
          state.lagged = true;
          return;
        }
        const text = clean(response.text);
        if (text) {
          state.speechText = text;
          state.speechUntil = performance.now() + 6000;
          tick();
        }
      } catch (error) {
        if (clip.generation === state.generation) { stop(); status(error.message); }
      } finally {
        state.speechBusy = false;
        transcribeNext();
      }
    }

    function watchForSpeechPause(recorder, startedAt) {
      const meter = state.audioMeter;
      const samples = meter && new Float32Array(meter.fftSize);
      let lastSpeech = 0;
      function check() {
        if (recorder.state !== "recording") return;
        const now = performance.now();
        if (meter && state.audioContext?.state === "running") {
          meter.getFloatTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) energy += sample * sample;
          if (energy / samples.length > MIN_SPEECH_RMS ** 2) lastSpeech = now;
        }
        const elapsed = now - startedAt;
        const pause = lastSpeech && elapsed >= MIN_AUDIO_MS && now - lastSpeech >= AUDIO_PAUSE_MS;
        if (pause || elapsed >= MAX_AUDIO_MS) recorder.stop();
        else state.timer = setTimeout(check, 75);
      }
      state.timer = setTimeout(check, 75);
    }

    function recordChunk() {
      if (!state.speech || !state.stream?.active) return;
      if (video.paused || video.seeking || video.ended) { state.timer = setTimeout(recordChunk, 300); return; }
      const generation = state.generation;
      const startedAt = performance.now();
      const chunks = [];
      const recorder = new MediaRecorder(new MediaStream(state.stream.getAudioTracks()), { mimeType: "audio/webm;codecs=opus" });
      state.recorder = recorder;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { stop(); status("音频录制失败，请重新开启识别"); };
      recorder.onstop = () => {
        if (!state.speech) return;
        recordChunk();
        const capturedAt = performance.now();
        if (generation !== state.generation || capturedAt - startedAt < 500) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size || blob.size > 2 * 1024 * 1024) return;
        state.audioQueue.push({ blob, generation, capturedAt });
        if (state.audioQueue.length > 2) {
          state.audioQueue.shift();
          state.lagged = true;
        }
        transcribeNext();
      };
      recorder.start();
      watchForSpeechPause(recorder, startedAt);
    }
    $(".speech").onclick = async () => {
      if (state.speech && state.stream) { stop(); return; }
      if (!navigator.mediaDevices?.getDisplayMedia) { status("此页面无法共享声音，请使用 HTTPS 页面和支持标签页音频的浏览器"); return; }
      stop();
      const generation = state.generation;
      $(".speech").disabled = true;
      status("请选择当前标签页并勾选共享标签页音频；音频将发往设置中的后端");
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: true,
          preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "exclude", surfaceSwitching: "exclude" });
        if (generation !== state.generation || !video.isConnected) { stream.getTracks().forEach(t => t.stop()); return; }
        if (!stream.getAudioTracks().length || stream.getVideoTracks()[0]?.getSettings().displaySurface !== "browser") {
          stream.getTracks().forEach(t => t.stop()); throw new Error("请选择浏览器标签页并启用共享音频");
        }
        audioOwner?.stop(); audioOwner = state;
        state.stream = stream; state.speech = true; start();
        // Measure pauses without mixing the captured sound back into playback.
        // If Web Audio is unavailable the recorder still flushes at its cap.
        try {
          state.audioContext = new AudioContext();
          state.audioMeter = state.audioContext.createAnalyser();
          state.audioContext.createMediaStreamSource(stream).connect(state.audioMeter);
          state.audioContext.resume().catch(() => {});
        } catch {
          state.audioMeter = null;
        }
        $(".speech").setAttribute("aria-pressed", "true"); $(".speech").textContent = "停止识别";
        for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (state.speech) { stop(); status("声音共享已停止"); } }, { once: true });
        status("正在识别标签页声音 · 请播放视频");
        recordChunk();
      } catch (error) { stop(); status(error.name === "NotAllowedError" ? "未获得声音共享权限，可再次点击开启" : error.message); }
      finally { $(".speech").disabled = false; }
    };
    function flushRecording() {
      if (state.recorder?.state !== "recording") return;
      clearTimeout(state.timer);
      state.recorder.stop();
    }
    function resetPlayback() {
      resetTimeline();
      flushRecording();
    }
    video.addEventListener("seeking", resetPlayback);
    video.addEventListener("pause", flushRecording);
    video.addEventListener("ratechange", resetPlayback);
    video.addEventListener("emptied", stop);
    video.addEventListener("ended", () => {
      if (!state.speech) return;
      stopCapture();
      $(".speech").setAttribute("aria-pressed", "false");
      $(".speech").textContent = "重新识别";
    });
  }

  function scan(root = document) {
    for (const video of root.querySelectorAll("video")) if (!players.has(video)) attach(video);
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot && !element.matches("[data-maslingo-video], #maslingo-panel")) scan(element.shadowRoot);
  }
  chrome.storage.local.get(preferenceKeys).then(cfg => { preferences = cfg; scan(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of preferenceKeys) if (changes[key]) preferences[key] = changes[key].newValue;
    if (changes.videoDisplayMode) {
      for (const state of players.values()) state.root.querySelector(".mode").value = globalThis.MAS_webDisplayMode(preferences.videoDisplayMode);
    }
    if (Object.keys(changes).some(key => key.startsWith("translation") || key === "targetLanguage")) for (const state of players.values()) state.reset();
  });
  const scanTimer = setInterval(scan, 2000);
  const tickTimer = setInterval(() => { for (const state of players.values()) state.tick(); }, 150);
  window.addEventListener("pagehide", () => { for (const state of players.values()) state.stop(); });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.type === 'READER_VIDEO') reply({ok: globalThis.MAS_video.open()});
  });
  globalThis.MAS_video = { installed: true, open() {
    scan();
    const video = [...players.keys()]
      .filter(video => video.isConnected && video.clientWidth >= 200 && video.clientHeight >= 100)
      .sort((a, b) => Number(a.paused) - Number(b.paused) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video) return false;
    const state = players.get(video);
    state.tick();
    state.openSettings();
    globalThis.MAS_reader?.focus(state.host);
    return true;
  } };
})();
