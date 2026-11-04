// Audio only goes to the explicitly configured OCR backend (or loopback).
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "TRANSCRIBE_VIDEO_AUDIO") return;
  (async () => {
    try {
      if (!sender.tab || typeof message.audio !== "string" || message.audio.length > 2800000) throw new Error("音频片段无效或过大");
      const bytes = Uint8Array.from(atob(message.audio), char => char.charCodeAt(0));
      const cfg = await chrome.storage.local.get("backendUrl");
      const base = String(cfg.backendUrl || "http://127.0.0.1:8001").replace(/\/+$/, "");
      const url = new URL(base);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("后端地址必须为 HTTP 或 HTTPS");
      const body = new FormData();
      const format = message.format === "wav" ? "wav" : "webm";
      body.append("audio", new Blob([bytes], { type: `audio/${format}` }), `video-audio.${format}`);
      if (typeof message.language === "string" && /^[a-z]{2,3}$/.test(message.language)) body.append("language", message.language);
      const response = await fetch(`${base}/api/transcribe-audio`, { method: "POST", body, signal: AbortSignal.timeout(60000) });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `语音识别失败 (${response.status})`);
      reply({ ok: true, text: String(data.text || "").slice(0, 5000), language: data.language, segments: data.segments });
    } catch (error) { reply({ ok: false, reason: String(error.message || error).slice(0, 250) }); }
  })();
  return true;
});
