// Per-video captions. Nothing is read or sent until the user starts a mode.
(() => {
  if (globalThis.MAS_video) return;
  const players = new Map();
  let preferences = { videoDisplayMode: "bilingual" };
  let audioOwner = null;
  const send = message => chrome.runtime.sendMessage(message);
  const clean = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  const plainCue = cue => clean(cue.getCueAsHTML ? cue.getCueAsHTML().textContent : cue.text);
  const domSelectors = ".ytp-caption-window-container, .bpx-player-subtitle-panel, .bilibili-player-video-subtitle";
  const playerSelector = "#movie_player, .html5-video-player, .bpx-player-container, .bilibili-player, .video-js, .jwplayer, .plyr, .shaka-video-container, .mejs__container";

  function attach(video) {
    const host = document.createElement("div");
    host.dataset.maslingoVideo = "1";
    host.style.cssText = "position:relative;display:none;box-sizing:border-box;clear:both;margin:8px 0;max-width:100%";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{font:12px/1.5 system-ui;color:#202124}*{box-sizing:border-box}
      .bar{display:flex;gap:5px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:#fff;border:1px solid #e5e9ef;border-radius:6px;pointer-events:auto}
      button,select{font:inherit;color:inherit;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;padding:3px 6px;min-height:27px;cursor:pointer;max-width:100%}
      button[aria-pressed=true]{background:#285de5;color:#fff}button:disabled{opacity:.5;cursor:wait}
      .status{flex-basis:100%;color:#62656b;overflow-wrap:anywhere;font-size:11px}.status:empty{display:none}
      [hidden]{display:none!important}
      button:focus-visible,select:focus-visible{outline:2px solid #285de5;outline-offset:2px}
      button{transition:background .16s}button:hover{background:#f3f6fc}button[aria-pressed=true]:hover{background:#194bc8}
      .caption{position:static;text-align:left;white-space:pre-line;font:14px/1.7 system-ui;color:#18212f;background:#fff;border-left:2px solid #285de5;padding:10px 14px;pointer-events:auto}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
      .caption:empty{display:none}
    </style><div class="bar"><strong>字幕</strong><button class="start" aria-pressed="false">翻译字幕</button>
      <button class="speech" aria-pressed="false" title="共享当前标签页声音，音频发送给设置中的后端；仅文字发给翻译来源">无字幕识别</button>
      <select class="mode" aria-label="字幕显示模式"><option value="bilingual">双语对照</option><option value="translated">纯译文</option><option value="source">纯原文</option></select>
      <select class="track" aria-label="字幕轨"><option value="auto">自动选择字幕</option></select>
      <span class="status" role="status"></span></div><div class="caption" aria-live="off"></div>`;
    function placeHost(rect) {
      let anchor = video.closest(playerSelector) || video;
      // Custom players can nest several out-of-flow layers. Leave those
      // layers and any clipping wrapper that ends at the video edge.
      for (let parent = anchor.parentElement; parent && parent !== document.body; parent = anchor.parentElement) {
        const positioned = /^(absolute|fixed)$/.test(getComputedStyle(anchor).position);
        const clipped = /^(hidden|clip)$/.test(getComputedStyle(parent).overflowY) &&
          parent.getBoundingClientRect().bottom <= rect.bottom + 2;
        if (!positioned && !clipped && !parent.matches(playerSelector)) break;
        anchor = parent;
      }
      if (anchor.nextSibling !== host) anchor.after(host);
      if (host.style.display === "none") return;
      const panelRect = host.getBoundingClientRect();
      if (panelRect.left < rect.right && panelRect.right > rect.left) {
        // Also cover player layouts whose video extends past the height they
        // reserve in normal flow. Account for the gap already applied.
        const margin = parseFloat(host.style.marginTop) || 0;
        const needed = Math.max(8, Math.ceil(margin + rect.bottom + 8 - panelRect.top));
        if (margin !== needed) host.style.marginTop = `${needed}px`;
      }
    }
    placeHost(video.getBoundingClientRect());
    const $ = selector => root.querySelector(selector);
    const state = { video, host, root, enabled: false, generation: 0, cache: new Map(), inflight: 0,
      modes: new Map(), hiddenDom: new Map(), sourceTrack: null, output: null, lastOutput: "", source: "",
      stream: null, recorder: null, speech: false, speechBusy: false, speechText: "", speechUntil: 0, timer: null };
    players.set(video, state);
    const status = text => { $(".status").textContent = text; };
    const mode = () => $(".mode").value;
    $(".mode").value = globalThis.MAS_webDisplayMode(preferences.videoDisplayMode);

    function clearOutput() {
      $(".caption").textContent = "";
      if (state.output) for (const cue of [...(state.output.cues || [])]) state.output.removeCue(cue);
      state.lastOutput = "";
    }
    function reset() {
      state.generation++;
      state.cache.clear();
      state.speechText = "";
      state.source = "";
      clearOutput();
    }
    function restoreSources() {
      for (const [track, saved] of state.modes) track.mode = saved;
      state.modes.clear(); state.sourceTrack = null;
      for (const [element, saved] of state.hiddenDom) {
        if (saved.value) element.style.setProperty("visibility", saved.value, saved.priority);
        else element.style.removeProperty("visibility");
      }
      state.hiddenDom.clear();
    }
    function stopSpeech() {
      state.speech = false;
      clearTimeout(state.timer);
      if (state.recorder?.state !== "inactive") { try { state.recorder?.stop(); } catch {} }
      state.recorder = null;
      state.stream?.getTracks().forEach(track => track.stop());
      state.stream = null;
      if (audioOwner === state) audioOwner = null;
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
      if (chosen !== state.sourceTrack) { restoreSources(); reset(); state.sourceTrack = chosen; }
      for (const track of tracks) {
        if (!state.modes.has(track)) state.modes.set(track, track.mode);
        if (track === chosen || track.mode === "showing") track.mode = "hidden";
      }
    }

    function translate(texts) {
      if (mode() === "source" || state.inflight >= 2) return;
      const fresh = [...new Set(texts)].filter(text => text && !state.cache.has(text)).slice(0, 8);
      if (!fresh.length) return;
      const generation = state.generation;
      for (const text of fresh) state.cache.set(text, { pending: true });
      state.inflight++;
      send({ type: "TRANSLATE_TEXT_BLOCKS", texts: fresh, source: "自动识别" }).then(result => {
        if (generation !== state.generation || !state.enabled) return;
        if (!result?.ok) throw new Error(result?.reason || "字幕翻译失败");
        fresh.forEach((text, i) => state.cache.set(text, { text: result.translations?.[i] || text }));
        if (state.cache.size > 800) for (const key of [...state.cache.keys()].slice(0, 200)) state.cache.delete(key);
      }).catch(error => {
        if (generation !== state.generation) return;
        fresh.forEach(text => state.cache.set(text, { error: error.message }));
        status(`翻译失败：${error.message}；停止后重开可重试`);
      }).finally(() => { state.inflight--; });
    }

    function sourceText() {
      if (state.speech) return performance.now() < state.speechUntil ? state.speechText : "";
      const track = state.sourceTrack;
      if (track) {
        const cues = [...(track.cues || [])];
        const active = cues.filter(c => c.startTime <= video.currentTime && c.endTime > video.currentTime);
        const current = clean(active.map(plainCue).join(" "));
        // Prefetch the near future; seeking simply changes the requested window.
        translate([current, ...cues.filter(c => c.startTime > video.currentTime && c.startTime < video.currentTime + 25).slice(0, 10).map(plainCue)]);
        return current;
      }
      const scope = video.closest("#movie_player, .bpx-player-container, .bilibili-player") || video.parentElement;
      const elements = [...(scope?.querySelectorAll(domSelectors) || [])];
      for (const element of elements) {
        if (!state.hiddenDom.has(element)) state.hiddenDom.set(element, { value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") });
        element.style.setProperty("visibility", "hidden", "important");
      }
      return clean(elements.map(e => e.textContent).join(" "));
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
        $(".caption").textContent = text;
      }
      state.lastOutput = text;
    }

    function tick() {
      if (!video.isConnected) { stop(); host.remove(); players.delete(video); return; }
      const rect = video.getBoundingClientRect();
      const full = document.fullscreenElement;
      host.style.display = rect.width >= 200 && rect.height >= 100 && !full && document.pictureInPictureElement !== video ? 'block' : 'none';
      host.style.width = `${Math.max(0, rect.width)}px`;
      placeHost(rect);
      updateTracks();
      if (!state.enabled) return;
      const text = sourceText();
      state.source = text;
      if (!text) { render(""); if (!state.speech) status(state.sourceTrack ? "等待当前字幕…" : "未发现字幕，请在播放器开启字幕，或点击无字幕识别"); return; }
      translate([text]);
      const entry = state.cache.get(text);
      const output = mode() === "source" ? text : mode() === "translated" ? (entry?.text || "") : [text, entry?.text === text ? "" : entry?.text].filter(Boolean).join("\n");
      render(output);
      if (!entry?.error) status(state.speech ? "正在识别标签页声音 · 字幕有数秒延迟" : mode() !== "source" && !entry?.text ? "正在翻译字幕…" : "字幕已同步");
    }
    state.tick = tick;

    async function recordChunk() {
      if (!state.speech || !state.stream?.active) return;
      if (video.paused || video.seeking || video.ended) { state.timer = setTimeout(recordChunk, 300); return; }
      const generation = state.generation;
      const chunks = [];
      const recorder = new MediaRecorder(new MediaStream(state.stream.getAudioTracks()), { mimeType: "audio/webm;codecs=opus" });
      state.recorder = recorder;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { stop(); status("音频录制失败，请重新开启识别"); };
      recorder.onstop = async () => {
        if (!state.speech) return;
        recordChunk();
        if (generation !== state.generation || state.speechBusy || video.paused) return;
        const capturedAt = performance.now();
        state.speechBusy = true;
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (!blob.size || blob.size > 2 * 1024 * 1024) return;
          const audio = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
          const response = await send({ type: "TRANSCRIBE_VIDEO_AUDIO", audio });
          if (generation !== state.generation || !state.speech || video.paused) return;
          if (!response?.ok) throw new Error(response?.reason || "语音识别失败");
          if (performance.now() - capturedAt > 15000) { status("识别速度较慢，已跳过过期语音；可换用更小的模型"); return; }
          state.speechText = clean(response.text);
          state.speechUntil = performance.now() + 8000;
          if (!state.speechText) status("未识别到语音，请检查共享声音和视频音量");
          tick();
        } catch (error) { if (generation === state.generation) { stop(); status(error.message); } }
        finally { state.speechBusy = false; }
      };
      recorder.start();
      state.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 5000);
    }
    $(".speech").onclick = async () => {
      if (state.speech) { stop(); return; }
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
        $(".speech").setAttribute("aria-pressed", "true"); $(".speech").textContent = "停止识别";
        for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (state.speech) { stop(); status("声音共享已停止"); } }, { once: true });
        status("正在识别标签页声音 · 请播放视频");
        recordChunk();
      } catch (error) { stop(); status(error.name === "NotAllowedError" ? "未获得声音共享权限，可再次点击开启" : error.message); }
      finally { $(".speech").disabled = false; }
    };
    video.addEventListener("seeking", reset);
    video.addEventListener("pause", () => { if (state.speech) reset(); });
    video.addEventListener("ratechange", reset);
    video.addEventListener("emptied", stop);
    video.addEventListener("ended", stop);
  }

  function scan(root = document) {
    for (const video of root.querySelectorAll("video")) if (!players.has(video)) attach(video);
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot && !element.matches("[data-maslingo-video], #maslingo-panel")) scan(element.shadowRoot);
  }
  chrome.storage.local.get(["videoDisplayMode"]).then(cfg => { preferences = cfg; scan(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.videoDisplayMode) {
      preferences.videoDisplayMode = changes.videoDisplayMode.newValue;
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
    const video = [...players.keys()].sort((a, b) => Number(a.paused) - Number(b.paused) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video) return false;
    players.get(video).tick();
    globalThis.MAS_reader?.focus(players.get(video).host);
    players.get(video).root.querySelector(".start").focus({ preventScroll: true });
    return true;
  } };
})();
