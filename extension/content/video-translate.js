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
  const MAX_MEDIA_BYTES = 160 * 1024 * 1024;
  const MAX_MEDIA_SECONDS = 60 * 60;
  const AUDIO_RATE = 16000;
  const MIN_AUDIO_MS = 1400;
  const MAX_AUDIO_MS = 5000;
  const AUDIO_PAUSE_MS = 220;
  const MIN_SPEECH_RMS = 0.006;
  const registry = globalThis.MAS_providers;
  const AUTO_SOURCE = registry.autoSource;
  const languageNames = registry.languages.map(language => language.name);
  const preferenceKeys = ["videoDisplayMode", "videoAutoPrepare", "videoSourceLanguage", "videoTargetLanguage",
    "targetLanguage", "translationProvider", "translationMode"];
  const plainCue = cue => clean(cue.getCueAsHTML ? cue.getCueAsHTML().textContent : cue.text);
  const domSelectors = ".ytp-caption-window-container, .bpx-player-subtitle-panel, .bilibili-player-video-subtitle";
  const playerSelector = "media-controller, #movie_player, .html5-video-player, .bpx-player-container, .bilibili-player, .video-js, .jwplayer, .plyr, .shaka-video-container, .mejs__container";

  function encodeAudio(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function monoSample(channels, index) {
    if (channels.length === 1) return channels[0][index];
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    return sum / channels.length;
  }

  function wavClip(channels, from, to) {
    const bytes = (to - from) * 2;
    const wav = new ArrayBuffer(44 + bytes);
    const data = new DataView(wav);
    data.setUint32(0, 0x52494646); // RIFF
    data.setUint32(4, bytes + 36, true);
    data.setUint32(8, 0x57415645); // WAVE
    data.setUint32(12, 0x666d7420); // fmt
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true); // PCM
    data.setUint16(22, 1, true); // Mono
    data.setUint32(24, AUDIO_RATE, true);
    data.setUint32(28, AUDIO_RATE * 2, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    data.setUint32(36, 0x64617461); // data
    data.setUint32(40, bytes, true);
    let peak = 0;
    for (let i = from; i < to; i++) {
      const sample = Math.max(-1, Math.min(1, monoSample(channels, i)));
      peak = Math.max(peak, Math.abs(sample));
      data.setInt16(44 + (i - from) * 2, sample * 32767, true);
    }
    return peak >= 0.002 ? new Blob([wav], { type: "audio/wav" }) : null;
  }

  function clipEnd(channels, from, length) {
    const end = Math.min(length, from + 11 * AUDIO_RATE);
    if (end === length) return end;
    const window = AUDIO_RATE / 10;
    // Prefer a pause near the end to keep sentences together.
    for (let cut = end; cut >= end - 2 * AUDIO_RATE; cut -= window) {
      let energy = 0;
      for (let i = cut - window; i < cut; i++) energy += monoSample(channels, i) ** 2;
      if (energy / window < MIN_SPEECH_RMS ** 2) return cut;
    }
    return end;
  }

  async function downloadVideo(url, signal) {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), credentials: "same-origin" });
    if (!response.ok || response.status === 206 || !response.body) throw new Error("无法读取完整的视频文件");
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES) throw new Error("视频文件超过 160 MB");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) throw new Error("视频文件超过 160 MB");
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return new Blob(parts).arrayBuffer();
  }

  async function readVideoAudio(url, signal) {
    const data = await downloadVideo(url, signal);
    signal.throwIfAborted();
    const context = new OfflineAudioContext(1, 1, AUDIO_RATE);
    let audio;
    try { audio = await context.decodeAudioData(data); }
    catch { throw new Error("浏览器无法从该视频文件解码音频"); }
    if (audio.duration > MAX_MEDIA_SECONDS) throw new Error("音轨超过 1 小时");
    return audio;
  }

  function* timedCaptions(cues) {
    // Reproduce the text shown at each boundary, including overlapping cues.
    const boundaries = [];
    for (const [index, cue] of Array.from(cues).entries()) {
      if (!(cue.endTime > cue.startTime)) continue;
      const text = plainCue(cue);
      if (!text) continue;
      boundaries.push({ time: cue.startTime, index, text }, { time: cue.endTime, index });
    }
    boundaries.sort((a, b) => a.time - b.time);
    const active = new Map();
    for (let i = 0; i < boundaries.length;) {
      const time = boundaries[i].time;
      do {
        const { index, text } = boundaries[i++];
        if (text) active.set(index, text);
        else active.delete(index);
      } while (boundaries[i]?.time === time);
      const text = clean([...active].sort(([a], [b]) => a - b).map(([, line]) => line).join(" "));
      if (text && i < boundaries.length) yield { start: time, end: boundaries[i].time, text };
    }
  }

  function trackTexts(cues) {
    const texts = new Set();
    for (const { text } of timedCaptions(cues)) {
      texts.add(text);
      if (texts.size > MAX_PREPARED_TEXTS) break;
    }
    return texts;
  }

  function captionText(source, translated, mode) {
    if (mode === "source") return source;
    if (mode === "translated") return translated || "";
    return [source, translated === source ? "" : translated].filter(Boolean).join("\n");
  }

  function subtitleTimestamp(ms, separator) {
    const clock = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
    return clock.map(part => String(part).padStart(2, "0")).join(":") + separator + String(ms % 1000).padStart(3, "0");
  }

  function escapeVtt(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function attach(video) {
    const host = document.createElement("div");
    host.dataset.maslingoVideo = "1";
    host.style.cssText = "position:relative;display:none;box-sizing:border-box;clear:both;margin:8px 0;max-width:100%;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{font:13px/1.5 system-ui;color:#202124}*{box-sizing:border-box}
      .float{position:relative;container-type:inline-size}
      .surface,.settings{background:#f8f8f8;pointer-events:auto}
      .surface{position:relative;display:grid;place-items:center;min-height:80px;padding:13px 76px;border:1px solid #858585;border-radius:9px;box-shadow:0 8px 24px #0002;cursor:grab;touch-action:none;user-select:none}
      .surface:active,.gear:active{cursor:grabbing}
      .actions{position:absolute;top:7px;right:8px;display:flex;gap:5px}
      .actions button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;background:transparent;color:#383838}
      .actions button:hover,.gear[aria-expanded=true]{background:#e8e8e8}
      .gear{cursor:grab}
      .settings{display:flex;align-items:center;flex-wrap:wrap;gap:7px;width:min(350px,100%);max-height:min(330px,var(--menu-space,50vh));overflow:auto;margin:6px 0 0 auto;padding:10px;border:1px solid #ddd;border-radius:6px;box-shadow:0 5px 18px #0002}
      .floating .settings{position:absolute;z-index:1;right:0;top:100%}
      .floating[data-menu-above] .settings{top:auto;bottom:calc(100% + 4px);margin-top:0}
      .auto-option{display:flex;align-items:center;gap:5px;min-height:27px;cursor:pointer}
      .auto-option input{margin:0;accent-color:#285de5}
      .languages{display:flex;flex-basis:100%;gap:7px}
      .languages label{display:grid;gap:3px;flex:1;min-width:0;font-size:12px}
      .languages select{width:100%;min-width:0}
      button,select{font:inherit;color:inherit;background:#f7f7f8;border:1px solid #ddd;border-radius:6px;padding:3px 6px;min-height:27px;cursor:pointer;max-width:100%}
      button[aria-pressed=true]{background:#285de5;color:#fff}button:disabled{opacity:.5;cursor:default}
      .status,.prepare-status{flex-basis:100%;color:#62656b;overflow-wrap:anywhere;font-size:12px}
      .status:empty,.prepare-status:empty{display:none}
      .subtitle-exports{display:flex;flex-basis:100%;flex-wrap:wrap;gap:7px}
      [hidden]{display:none!important}
      button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #285de5;outline-offset:1px}
      button{transition:background .16s}button:hover{background:#f3f6fc}button[aria-pressed=true]:hover{background:#194bc8}
      .caption,.idle,.prepare-indicator{max-width:100%;text-align:center;white-space:pre-line;overflow-wrap:anywhere;font:14px/1.6 system-ui}
      .prepare-indicator{color:#62656b;font-size:12px}
      @container (max-width:440px){.surface{padding:34px 12px 12px}.actions{top:4px;right:5px}}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
      .caption:empty{display:none}
    </style><div class="float"><div class="surface">
      <div class="caption" aria-live="off"></div>
      <span class="idle">字幕已就绪，可在设置中开启</span>
      <span class="prepare-indicator" hidden></span>
      <div class="actions">
      <button class="gear" type="button" aria-label="字幕设置" aria-expanded="false" aria-controls="settings" title="字幕设置，可拖动浮窗">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="m10 3-.5 2.3-1.7 1L5.5 5.6l-2 3.4 1.7 1.6v2.1L3.5 14l2 3.4 2.3-.7 1.7 1L10 20h4l.5-2.3 1.7-1 2.3.7 2-3.4-1.7-1.3v-2.1L20.5 9l-2-3.4-2.3.7-1.7-1L14 3z"/>
          <circle cx="12" cy="11.5" r="3"/>
        </svg>
      </button>
      <button class="close" type="button" aria-label="关闭字幕浮窗" title="关闭字幕浮窗">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
      </div>
    </div><div class="settings" id="settings" aria-label="字幕设置" hidden>
      <button class="start" aria-pressed="false">翻译字幕</button>
      <button class="speech" aria-pressed="false" title="共享当前标签页声音，音频发送给设置中的后端；仅文字发给翻译来源">无字幕识别</button>
      <select class="mode" aria-label="字幕显示模式"><option value="bilingual">双语对照</option><option value="translated">纯译文</option><option value="source">纯原文</option></select>
      <select class="track" aria-label="字幕轨"><option value="auto">自动选择字幕</option></select>
      <div class="languages">
        <label>源语言<select class="source-language"></select></label>
        <label>目标语言<select class="target-language"></select></label>
      </div>
      <button class="prepare" aria-describedby="prepare-status">预翻译字幕轨</button>
      <label class="auto-option"><input class="auto-prepare" type="checkbox" checked>自动预翻译</label>
      <span class="prepare-status" id="prepare-status" role="status"></span>
      <div class="subtitle-exports" hidden>
        <button class="export-srt" type="button" title="按当前字幕显示模式导出">导出 SRT</button>
        <button class="export-vtt" type="button" title="按当前字幕显示模式导出">导出 WebVTT</button>
      </div>
      <span class="status" role="status"></span>
    </div></div>`;
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
    const float = $(".float");
    const surface = $(".surface");
    const gear = $(".gear");
    const menu = $(".settings");
    let position = null;
    let drag = null;
    let suppressClick = false;
    let dismissed = false;

    function placeFloating() {
      const { width, height } = surface.getBoundingClientRect();
      const viewportHeight = document.documentElement.clientHeight;
      const left = Math.max(8, Math.min(position.x, document.documentElement.clientWidth - width - 8));
      const top = Math.max(8, Math.min(position.y, viewportHeight - height - 8));
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      if (!menu.hidden) {
        const above = top - 8;
        const below = viewportHeight - top - height - 10;
        const openAbove = above >= 190 || above > below;
        float.toggleAttribute("data-menu-above", openAbove);
        menu.style.setProperty("--menu-space", `${Math.max(0, openAbove ? above : below)}px`);
      }
    }
    function dismissMenuOutside(event) {
      if (!event.composedPath().includes(host)) showSettings(false);
    }
    function showSettings(open) {
      menu.hidden = !open;
      gear.setAttribute("aria-expanded", String(open));
      if (open) window.addEventListener("pointerdown", dismissMenuOutside, true);
      else window.removeEventListener("pointerdown", dismissMenuOutside, true);
      updatePreparationUi();
      if (position) placeFloating();
    }
    surface.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0 || event.composedPath().includes($(".close"))) return;
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
        float.classList.add("floating");
      }
      placeFloating();
    });
    for (const type of ["pointerup", "pointercancel"]) {
      surface.addEventListener(type, event => { if (drag?.id === event.pointerId) drag = null; });
    }
    gear.onclick = event => {
      if (suppressClick && event.detail) return;
      showSettings(menu.hidden);
    };
    $(".close").onclick = () => {
      dismissed = true;
      stop();
      showSettings(false);
      tick();
    };
    root.addEventListener("keydown", event => {
      if (event.key !== "Escape" || menu.hidden) return;
      event.stopPropagation();
      showSettings(false);
      gear.focus({ preventScroll: true });
    });
    const state = { video, host, root, enabled: false, generation: 0, translationRevision: 0, cache: new Map(), inflight: 0, prefetching: false,
      modes: new Map(), hiddenDom: new Map(), sourceTrack: null, output: null, lastOutput: "",
      hasTracks: false, preparation: null, generatedCues: null, allowAudioPreparation: false,
      currentCue: null, waitingCues: [], showing: null, lagged: false,
      stream: null, recorder: null, audioContext: null, audioMeter: null,
      speech: false, speechBusy: false, speechText: "", speechUntil: 0, audioQueue: [], audioRequest: null, timer: null };
    players.set(video, state);
    const status = text => { $(".status").textContent = text; };
    const mode = () => $(".mode").value;
    $(".mode").value = globalThis.MAS_webDisplayMode(preferences.videoDisplayMode);
    const sourceSelect = $(".source-language");
    const targetSelect = $(".target-language");
    sourceSelect.append(new Option(AUTO_SOURCE), ...languageNames.map(name => new Option(name)));
    targetSelect.append(new Option("", ""), ...languageNames.map(name => new Option(name)));
    let sourceLanguage, targetLanguage;

    function syncLanguages() {
      const oldSource = sourceLanguage;
      const oldTarget = targetLanguage;
      sourceSelect.value = preferences.videoSourceLanguage || AUTO_SOURCE;
      targetSelect.value = preferences.videoTargetLanguage || "";
      const globalTarget = preferences.targetLanguage || "简体中文";
      targetSelect.options[0].textContent = `跟随全局（${globalTarget}）`;
      sourceLanguage = sourceSelect.value || AUTO_SOURCE;
      targetLanguage = targetSelect.value || globalTarget;
      if (!oldSource || (oldSource === sourceLanguage && oldTarget === targetLanguage)) return;
      if (oldSource !== sourceLanguage) {
        state.generatedCues = null;
        reset();
        flushRecording();
      } else if (state.preparation?.controller) resetTranslation();
      else reset();
      tick();
    }
    syncLanguages();
    state.syncLanguages = syncLanguages;
    function saveLanguage(key, value) {
      preferences[key] = value;
      for (const player of players.values()) player.syncLanguages();
      chrome.storage.local.set({ [key]: value });
    }
    sourceSelect.onchange = () => saveLanguage("videoSourceLanguage", sourceSelect.value);
    targetSelect.onchange = () => saveLanguage("videoTargetLanguage", targetSelect.value);

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
    function resetTranslation() {
      state.translationRevision++;
      state.cache.clear();
      resetTimeline();
    }
    function reset() {
      state.preparation?.controller?.abort();
      state.preparation = null;
      $(".prepare-status").textContent = "";
      resetTranslation();
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
      state.generatedCues = null;
      state.allowAudioPreparation = false;
      stopSpeech(); reset(); restoreSources();
      if (state.output) state.output.mode = "disabled";
      $(".idle").hidden = false;
      $(".start").setAttribute("aria-pressed", "false");
      $(".start").textContent = "翻译字幕";
      status("");
    }
    state.stop = stop;
    state.reset = reset;
    function start() {
      state.enabled = true;
      $(".idle").hidden = true;
      $(".start").setAttribute("aria-pressed", "true");
      $(".start").textContent = "停止字幕";
    }
    $(".start").onclick = event => {
      if (state.enabled) stop();
      else {
        state.allowAudioPreparation = event.isTrusted;
        start();
        tick();
      }
    };
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
      const chosen = ($(".track").value === "auto"
        ? tracks.find(t => t.mode === "showing") || (tracks.includes(state.sourceTrack) ? state.sourceTrack : tracks[0])
        : tracks[Number($(".track").value)]) || null;
      if (chosen !== state.sourceTrack) {
        restoreSources();
        reset();
        state.generatedCues = null;
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
    const indicator = $(".prepare-indicator");
    const exportControls = $(".subtitle-exports");
    const autoPrepare = $(".auto-prepare");
    autoPrepare.checked = preferences.videoAutoPrepare !== false;
    function setAutoPrepare(enabled) {
      autoPrepare.checked = enabled;
      const job = state.preparation;
      if (enabled && job?.automatic && !job.running && !job.ready) state.preparation = null;
      tick();
    }
    autoPrepare.onchange = () => {
      const enabled = autoPrepare.checked;
      setAutoPrepare(enabled);
      chrome.storage.local.set({ videoAutoPrepare: enabled });
    };
    state.syncAutoPrepare = () => {
      const enabled = preferences.videoAutoPrepare !== false;
      if (autoPrepare.checked !== enabled) setAutoPrepare(enabled);
    };
    function setPrepareStatus(message) {
      if (prepareStatus.textContent !== message) prepareStatus.textContent = message;
    }

    function updatePreparationUi() {
      const job = state.preparation;
      exportControls.hidden = !job?.ready;
      indicator.hidden = !menu.hidden || !(job?.running || (job?.ready && video.paused));
      if (!indicator.hidden && indicator.textContent !== prepareStatus.textContent) {
        indicator.textContent = prepareStatus.textContent;
      }
    }

    function markNewCaptions() {
      state.preparation.ready = false;
      prepareButton.disabled = false;
      setPrepareStatus("字幕轨出现了新内容，可以再次预翻译。");
    }

    function exportSubtitles(format) {
      const job = state.preparation;
      const cues = job?.audio ? state.generatedCues : state.sourceTrack?.cues;
      if (!job?.ready || !cues?.length) return;
      const displayMode = mode();
      const isVtt = format === "vtt";
      const separator = isVtt ? "." : ",";
      const newline = isVtt ? "\n" : "\r\n";
      const entries = [];
      for (const { start, end, text } of timedCaptions(cues)) {
        const translated = state.cache.get(text)?.text;
        if (displayMode !== "source" && (!job.texts.has(text) || !translated)) {
          markNewCaptions();
          updatePreparationUi();
          prepareButton.focus({ preventScroll: true });
          return;
        }
        if (!Number.isFinite(end) || entries.length >= 10000) {
          setPrepareStatus("当前字幕轨含无效时间或超过 10,000 段，无法完整导出。");
          return;
        }
        const from = Math.max(0, Math.round(start * 1000));
        const to = Math.max(from + 1, Math.round(end * 1000));
        const timing = `${subtitleTimestamp(from, separator)} --> ${subtitleTimestamp(to, separator)}`;
        const output = captionText(text, translated, displayMode);
        entries.push(isVtt ? `${timing}\n${escapeVtt(output)}` :
          [entries.length + 1, timing, output.replace(/\n/g, newline)].join(newline));
      }
      if (!entries.length) {
        setPrepareStatus("字幕轨中没有可导出的字幕。");
        return;
      }
      const contents = (isVtt ? "WEBVTT\n\n" : "\ufeff") + entries.join(newline.repeat(2)) + newline;
      const url = URL.createObjectURL(new Blob([contents], { type: isVtt ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8" }));
      const title = document.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").trim().slice(0, 80) || "视频";
      const link = document.createElement("a");
      link.href = url;
      link.download = `MasLingo-${title}-${displayMode}.${format}`;
      root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    for (const format of ["srt", "vtt"]) {
      $(`.export-${format}`).onclick = event => { if (event.isTrusted) exportSubtitles(format); };
    }

    function finishPreparation(message) {
      state.preparation.running = false;
      state.preparation.controller?.abort();
      prepareButton.textContent = state.preparation.audio ? "预处理视频音频" : "预翻译字幕轨";
      if (state.preparation.ready) prepareButton.disabled = true;
      setPrepareStatus(message);
    }
    function mediaUrl() {
      if (!/^https?:\/\//i.test(video.currentSrc) || !Number.isFinite(video.duration) ||
          video.duration <= 0 || video.duration > MAX_MEDIA_SECONDS || video.mediaKeys ||
          /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(video.currentSrc)) return "";
      return video.currentSrc;
    }

    async function recognizeVideo(job, url) {
      const signal = job.controller.signal;
      try {
        setPrepareStatus("正在读取视频音轨…");
        const audio = await readVideoAudio(url, signal);
        const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
        const cues = [];
        for (let from = 0; from < audio.length;) {
          signal.throwIfAborted();
          const to = clipEnd(channels, from, audio.length);
          const clip = wavClip(channels, from, to);
          if (!clip) { from = to; continue; }
          setPrepareStatus(`正在识别视频语音… ${Math.floor(from / audio.length * 100)}%`);
          const response = await requestTranscription(clip, "wav", () => !signal.aborted);
          signal.throwIfAborted();
          if (!response?.ok) throw new Error(response?.reason || "语音识别失败");
          const clipLength = (to - from) / AUDIO_RATE;
          for (const segment of response.segments || []) {
            const text = clean(segment.text);
            const startTime = from / AUDIO_RATE + Math.max(0, segment.start);
            const endTime = from / AUDIO_RATE + Math.min(clipLength, segment.end);
            if (text && Number.isFinite(startTime) && endTime > startTime) cues.push({ text, startTime, endTime });
          }
          from = to;
        }
        if (!cues.length) throw new Error("未识别到视频中的语音");
        if (!video.isConnected || url !== video.currentSrc) { stop(); return; }
        state.generatedCues = cues;
        job.controller = null;
        resetTimeline();
        tick();
      } catch (error) {
        if (signal.aborted) return;
        const message = error.name === "TimeoutError" ? "读取视频超时" :
          error instanceof TypeError ? "无法读取该视频直链，网站可能限制了媒体访问" : error.message;
        finishPreparation(`视频预处理失败：${message}`);
      }
    }

    function beginPreparation(now, automatic, audio = false) {
      const job = { automatic, audio, running: true, ready: false, texts: null, deadline: now + 8000 };
      state.preparation = job;
      if (audio && !state.generatedCues) {
        job.controller = new AbortController();
        recognizeVideo(job, mediaUrl());
      }
    }
    prepareButton.onclick = event => {
      if (state.preparation?.running) {
        finishPreparation("已停止预翻译，已译字幕仍可使用。");
      } else {
        const audio = !state.hasTracks;
        if (audio && (!event.isTrusted || (!state.generatedCues && !mediaUrl()))) return;
        if (audio) state.allowAudioPreparation = true;
        start();
        updateTracks();
        if (!audio && !state.sourceTrack) return;
        beginPreparation(performance.now(), false, audio);
      }
      tick();
    };

    function prepareCaptions(now) {
      const audioAvailable = !state.hasTracks && Boolean(state.generatedCues || mediaUrl());
      const available = (state.hasTracks || audioAvailable) && !state.speech && mode() !== "source";
      if (!state.preparation && available && state.enabled && autoPrepare.checked) {
        if (state.sourceTrack) beginPreparation(now, true);
        else if (state.allowAudioPreparation && (state.generatedCues || !webCaptions().some(element => clean(element.textContent)))) {
          beginPreparation(now, true, true);
        }
      }
      const job = state.preparation;
      if (job?.running && (!available || (job.automatic && !autoPrepare.checked))) finishPreparation("预翻译已停止，已译字幕仍可使用。");
      prepareButton.disabled = !available || Boolean(job?.ready);
      const label = job?.running ? "停止预翻译" : state.hasTracks ? "预翻译字幕轨" : "预处理视频音频";
      if (prepareButton.textContent !== label) prepareButton.textContent = label;
      if (!job) {
        setPrepareStatus(state.speech ? "正在实时识别，可停止后再预处理。" :
          !state.hasTracks && !audioAvailable ? (Number.isFinite(video.duration) && video.duration > MAX_MEDIA_SECONDS ?
            "视频超过 1 小时，可使用实时识别。" : "当前视频无法提前读取完整音轨，可使用实时识别。") :
          mode() === "source" ? "选择双语或纯译文后可预翻译。" :
          autoPrepare.checked ? "开启字幕翻译后自动预翻译。" :
          audioAvailable ? "可暂停播放并手动预处理音频。" : "可手动预翻译字幕轨。");
      }
      if (!job?.running || job.controller) return;
      if (!job.texts) {
        const cues = job.audio ? state.generatedCues : state.sourceTrack?.cues;
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
        // Keep a translation slot free for the current cue during playback.
        translate(remaining, !video.paused);
      }
    }

    function translate(texts, prefetch = false) {
      if (mode() === "source" || state.inflight >= 2 || (prefetch && state.prefetching)) return;
      const provider = registry.byId(registry.resolveProviderId(preferences));
      // Single-text providers are serialized by the worker. A large batch
      // would keep even its first translation waiting for later requests.
      const batchSize = provider?.perRequest ? 1 : 4;
      const fresh = [...new Set(texts)].filter(text => text && !state.cache.has(text)).slice(0, batchSize);
      if (!fresh.length) return;
      const revision = state.translationRevision;
      for (const text of fresh) state.cache.set(text, { pending: true });
      state.inflight++;
      if (prefetch) state.prefetching = true;
      send({ type: "TRANSLATE_TEXT_BLOCKS", texts: fresh, source: sourceLanguage, target: targetLanguage }).then(result => {
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
      if (track || state.generatedCues) {
        const cues = state.generatedCues || [...(track.cues || [])];
        const active = cues.filter(c => c.startTime <= video.currentTime && c.endTime > video.currentTime);
        return {
          text: clean(active.map(plainCue).join(" ")),
          upcoming: cues.filter(c => c.startTime > video.currentTime && c.startTime < video.currentTime + 30).slice(0, 10).map(plainCue),
        };
      }
      const elements = webCaptions();
      for (const element of elements) {
        if (!state.hiddenDom.has(element)) state.hiddenDom.set(element, { value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") });
        element.style.setProperty("visibility", "hidden", "important");
      }
      return { text: clean(elements.map(e => e.textContent).join(" ")), upcoming: [], rolling: true };
    }
    function webCaptions() {
      const scope = video.closest("#movie_player, .bpx-player-container, .bilibili-player") || video.parentElement;
      return [...(scope?.querySelectorAll(domSelectors) || [])];
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
        markNewCaptions();
      }
      if (prepared?.ready) {
        // Prepared tracks follow the media clock, including brief cues and gaps.
        state.currentCue = null;
        state.waitingCues.length = 0;
        state.showing = null;
        const translated = state.cache.get(text)?.text;
        render(captionText(text, translated, mode()));
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
      const output = ready ? captionText(ready.cue.text, ready.translation, mode()) : "";
      render(output);
      if (ready?.error) status(`字幕翻译失败：${ready.error}`);
      else if (state.lagged) status("处理速度跟不上播放，已跳过过期片段");
      else if (ready && ready.cue !== state.currentCue) status("正在补显示晚到的字幕");
      else if (state.waitingCues.length) status("正在翻译字幕…");
      else status(ready ? (state.speech ? "已显示语音字幕" : "字幕已同步") : idleStatus());
    }

    function idleStatus() {
      if (state.speech) return state.stream ? "正在识别标签页声音…" : "语音采集已结束";
      return state.sourceTrack || state.generatedCues ? "等待当前字幕…" : "未发现字幕，可预处理视频音频或开启实时识别";
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
          if (text) state.output.addCue(new VTTCue(video.currentTime, video.currentTime + 0.6, escapeVtt(text)));
        }
      } else {
        if (state.output) state.output.mode = "disabled";
        if ($(".caption").textContent !== text) $(".caption").textContent = text;
      }
      state.lastOutput = text;
    }

    function tick() {
      if (!video.isConnected) { showSettings(false); stop(); host.remove(); players.delete(video); return; }
      const rect = video.getBoundingClientRect();
      const full = document.fullscreenElement;
      const showPanel = !dismissed && rect.width >= 200 && rect.height >= 100 && !full && document.pictureInPictureElement !== video;
      host.style.display = showPanel ? "block" : "none";
      if (showPanel) {
        host.style.width = `${rect.width}px`;
        if (position) placeFloating();
        else placeHost(rect);
      }
      updateTracks();
      const now = performance.now();
      prepareCaptions(now);
      if (state.enabled) presentCaptions(readCaptions(now), now);
      updatePreparationUi();
    }
    state.tick = tick;
    state.openSettings = () => {
      dismissed = false;
      tick();
      showSettings(true);
      gear.focus({ preventScroll: true });
    };

    async function requestTranscription(blob, format, isCurrent) {
      const audio = await encodeAudio(blob);
      while (state.audioRequest) await state.audioRequest.catch(() => {});
      if (!isCurrent()) return;
      const request = send({ type: "TRANSCRIBE_VIDEO_AUDIO", audio, format, language: registry.languageBase(sourceLanguage) });
      state.audioRequest = request;
      try { return await request; }
      finally { state.audioRequest = null; }
    }

    async function transcribeNext() {
      if (!state.speech || state.speechBusy) return;
      const clip = state.audioQueue.shift();
      if (!clip) return;
      state.speechBusy = true;
      try {
        const response = await requestTranscription(clip.blob, "webm", () => clip.generation === state.generation && state.speech);
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
    if (changes.videoAutoPrepare) for (const state of players.values()) state.syncAutoPrepare();
    if (changes.videoSourceLanguage || changes.videoTargetLanguage || changes.targetLanguage) for (const state of players.values()) state.syncLanguages();
    if (Object.keys(changes).some(key => key.startsWith("translation"))) for (const state of players.values()) state.reset();
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
    state.openSettings();
    globalThis.MAS_reader?.focus(state.host);
    return true;
  } };
})();
