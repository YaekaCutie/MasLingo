importScripts("../config.js", "../translation/providers.js");

async function fetchBackend(path,options={}){
  const backends=await globalThis.OMT_backendCandidates();
  let lastError=null;
  for(const base of backends){
    try{
      const resp=await fetch(`${base}${path}`,options);
      if(resp.ok || resp.status >= 400){
        return resp;
      }
      lastError=new Error(`${base} 响应失败: ${resp.status}`);
    }catch(e){
      lastError=new Error(`${base}: ${e.message}`);
    }
  }
  throw new Error(`后端连接失败（${lastError?.message||"未配置后端且本机后端未运行"}）`);
}

// --- auto-translate channel ------------------------------------------------
//
// Auto mode works from the image bytes the content script fetches, not from a
// screenshot: a screenshot only ever contains the viewport, which is exactly
// what breaks down on a long scrolling page, and it fails outright while the tab
// is in the background. Sending the picture itself means detection is
// independent of scroll position and of which tab is focused.
async function autoRecognize(imageDataUrl) {
  const blob = await (await fetch(imageDataUrl)).blob();
  const form = new FormData();
  form.append("image", blob, "region.png");
  const response = await fetchBackend("/api/recognize-page", { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "OCR 失败");
  return payload.items || [];
}

/**
 * Fetch an image on the content script's behalf.
 *
 * A content script's fetch is subject to the page's origin rules — since MV3 it
 * cannot use the extension's host permissions to reach cross-origin bytes. That
 * is why auto translate reported "图片读取失败 403" on a manga CDN that answers
 * 200 to everyone else. The service worker can make the request properly.
 *
 * The referrer is set to the page the picture belongs to because a hotlink
 * check is usually just "did this request come from one of our own pages", and
 * an extension's request otherwise arrives with none. Where the server instead
 * refuses by origin or by fingerprint, nothing here can help and the screenshot
 * route takes over.
 */
async function fetchImageBytes(url, pageUrl) {
  const options = { credentials: "omit", cache: "force-cache" };
  if (pageUrl && /^https?:/.test(pageUrl)) {
    options.referrer = pageUrl;
    options.referrerPolicy = "no-referrer-when-downgrade";
  }
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`图片读取失败 ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += chunk) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk));
  }
  const mime = response.headers.get("content-type") || "image/png";
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Crop an element's pixels out of a screenshot of the visible tab.
 *
 * The fallback for pictures that cannot be fetched at all — a CDN that refuses
 * the extension outright. A screenshot is always readable because it never
 * touches the page's own image loading, and it is what manual mode has always
 * used. It only covers the viewport, so the caller must confirm the element is
 * fully on screen before relying on it.
 */
async function captureElementCrop(tabId, message) {
  if (!tabId) throw new Error("拿不到标签页");
  const { bmp } = await captureVisibleImage(tabId);
  // Read the nested field: the message carries `viewport` alongside `rect`, and
  // reading `viewport.width` off the message itself yields undefined, which
  // turns every derived number into NaN and OffscreenCanvas rejects it.
  const viewport = message.viewport || {};
  if (!viewport.width || !viewport.height) throw new Error("缺少视口尺寸");
  const scaleX = bmp.width / viewport.width;
  const scaleY = bmp.height / viewport.height;
  const rect = message.rect;
  const left = Math.max(0, Math.floor(rect.left * scaleX));
  const top = Math.max(0, Math.floor(rect.top * scaleY));
  const right = Math.min(bmp.width, Math.ceil((rect.left + rect.width) * scaleX));
  const bottom = Math.min(bmp.height, Math.ceil((rect.top + rect.height) * scaleY));
  const width = right - left;
  const height = bottom - top;
  if (width < 16 || height < 16) throw new Error("元素不在可视区域内");

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bmp, left, top, width, height, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CAPTURE_CROP") {
    // The tab is taken from the sender rather than the message: a content
    // script has no way to know its own tab id, and the first version of this
    // passed undefined straight into tabs.get().
    captureElementCrop(sender?.tab?.id, message).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }
  if (message?.type === "FETCH_IMAGE") {
    fetchImageBytes(message.url, message.pageUrl).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }
  if (message?.type === "AUTO_OCR") {
    autoRecognize(message.image).then(
      (items) => sendResponse({ ok: true, items }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }
  if (message?.type === "AUTO_TRANSLATE") {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get([
          "translationMode", "translationProvider", "translationEndpoint",
          "translationModel", "translationApiKey", "translationAppId", "targetLanguage",
        ]);
        if (!resolveProvider(cfg)) {
          sendResponse({ ok: true, mode: "none", items: [] });
          return;
        }
        const translated = await runTranslation(message.texts || [], cfg);
        sendResponse({
          ok: true,
          mode: cfg.translationMode || "none",
          items: (message.texts || []).map((text, index) => ({
            text, translated: translated[index],
          })),
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }
  if (message?.type !== "TEST_TRANSLATION") return undefined;
  (async () => {
    try {
      const cfg = await chrome.storage.local.get([
        "translationMode", "translationProvider", "translationEndpoint",
        "translationModel", "translationApiKey", "translationAppId", "targetLanguage",
      ]);
      const translated = await runTranslation(["おはよう"], cfg);
      sendResponse({ ok: true, translated: translated[0] });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true; // reply is asynchronous
});

chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=="manga-recognition")return;
  const tabId=port.sender?.tab?.id;
  if(!tabId){port.disconnect();return;}
  port.onMessage.addListener(msg=>{
    if(msg.type==="RECOGNIZE_REGION") recognizeRegion(msg,tabId,port);
    else if(msg.type==="RECOGNIZE_PAGE") recognizePage(msg,tabId,port);
    else if(msg.type==="TRANSLATE_TEXTS") translateTexts(msg,port);
    else if(msg.type==="KEEPALIVE") postPortMessage(port,{type:"KEEPALIVE_ACK"});
  });
});

function postPortMessage(port,message){
  try{
    port.postMessage(message);
    return true;
  }catch(error){
    console.warn("识别消息通道已关闭：",error.message);
    return false;
  }
}

function postResult(port,tabId,message){
  if(postPortMessage(port,message))return;
  chrome.tabs.sendMessage(tabId,message).catch(error=>{
    console.warn("无法将识别结果发送回页面：",error.message);
  });
}

async function recognizeRegion(msg,tabId,port){
  try{
    const cfg=await chrome.storage.local.get(["debugMode"]);
    const {tab,bmp}=await captureVisibleImage(tabId);
    postPortMessage(port,{type:"CAPTURE_READY",requestId:msg.requestId});
    const r=msg.rect;
    const viewport=msg.viewport||{width:tab.width,height:tab.height};
    if(!viewport.width||!viewport.height) throw new Error("无法获取页面视口尺寸");
    const scaleX=bmp.width/viewport.width;
    const scaleY=bmp.height/viewport.height;
    const sx=Math.max(0,Math.min(bmp.width-1,Math.floor(r.left*scaleX)));
    const sy=Math.max(0,Math.min(bmp.height-1,Math.floor(r.top*scaleY)));
    const ex=Math.max(sx+1,Math.min(bmp.width,Math.ceil((r.left+r.width)*scaleX)));
    const ey=Math.max(sy+1,Math.min(bmp.height,Math.ceil((r.top+r.height)*scaleY)));
    const cropWidth=ex-sx;
    const cropHeight=ey-sy;
    const canvas=new OffscreenCanvas(cropWidth,cropHeight);
    const ctx=canvas.getContext("2d");
    ctx.drawImage(bmp,sx,sy,cropWidth,cropHeight,0,0,cropWidth,cropHeight);
    const cropped=await canvas.convertToBlob({type:"image/png"});
    const fd=new FormData();
    fd.append("image",cropped,"manga.png");

    const resp=await fetchBackend("/api/recognize-image",{
      method:"POST",body:fd
    });
    const json=await resp.json();
    if(!resp.ok) throw new Error(json.detail||"后端错误");
    json.debug_mode=cfg.debugMode!==false;
    const patch = describeRegion(bmp,r,viewport);
    const recognizedText = (json.items||[])
      .map(item=>item.text?.trim())
      .filter(Boolean)
      .join("\n");
    json.items = recognizedText ? [{text:recognizedText,patch,direction:json.direction}] : [];
    postResult(port,tabId,{
      type:"RECOGNITION_RESULT",
      rect:r,
      requestId:msg.requestId,
      result:json
    });
  }catch(error){
    postResult(port,tabId,{
      type:"RECOGNITION_RESULT",
      rect:msg.rect,
      requestId:msg.requestId,
      result:{ok:false,error:error.message}
    });
  }
}

async function captureVisibleImage(tabId){
  const tab=await chrome.tabs.get(tabId);
  const data=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"});
  const bytes=Uint8Array.from(atob(data.slice(data.indexOf(",")+1)),char=>char.charCodeAt(0));
  const bmp=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
  return {tab,bmp};
}

async function blobToDataUrl(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let binary="";
  const chunkSize=0x8000;
  for(let offset=0;offset<bytes.length;offset+=chunkSize){
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/**
 * Describe where a detected box sits inside the screenshot, in CSS pixels.
 *
 * It used to return the cropped pixels as a data URL so the content script could
 * rebuild the paper around the lettering. The cover is flat white now, so the
 * pixels are not needed for painting at all — only the geometry, and the region
 * is already covered by the screenshot's normal flow.
 */
function describeRegion(bmp,rect,viewport){
  const scaleX=bmp.width/viewport.width;
  const scaleY=bmp.height/viewport.height;
  const padX=Math.min(32,Math.max(8,rect.width*0.14));
  const padY=Math.min(32,Math.max(8,rect.height*0.14));
  const left=Math.max(0,Math.floor((rect.left-padX)*scaleX));
  const top=Math.max(0,Math.floor((rect.top-padY)*scaleY));
  const right=Math.min(bmp.width,Math.ceil((rect.left+rect.width+padX)*scaleX));
  const bottom=Math.min(bmp.height,Math.ceil((rect.top+rect.height+padY)*scaleY));
  const width=Math.max(1,right-left);
  const height=Math.max(1,bottom-top);
  return {
    rect:{
      left:left/scaleX,
      top:top/scaleY,
      width:width/scaleX,
      height:height/scaleY
    },
    core:{
      left:(rect.left*scaleX-left)/width,
      top:(rect.top*scaleY-top)/height,
      width:rect.width*scaleX/width,
      height:rect.height*scaleY/height
    }
  };
}

async function recognizePage(msg,tabId,port){
  try{
    const {tab,bmp}=await captureVisibleImage(tabId);
    const viewport=msg.viewport||{width:tab.width,height:tab.height};
    const scaleX=bmp.width/viewport.width;
    const scaleY=bmp.height/viewport.height;
    const media=msg.mediaRect;
    // Only a lower bound: an image filling the viewport is the normal case for
    // a manga reader, and the old 80% cap rejected it outright.
    const useMedia=media &&
      media.width*media.height >= viewport.width*viewport.height*0.08 &&
      media.width>=180 && media.height>=180;
    if(!useMedia)throw new Error("未能定位主漫画图片。请改用“选择漫画区域并识别”，或在图片更大的页面上重试。");
    postPortMessage(port,{type:"CAPTURE_READY",requestId:msg.requestId});
    const crop={
      left:Math.max(0,Math.floor(media.left*scaleX)),
      top:Math.max(0,Math.floor(media.top*scaleY)),
      right:Math.min(bmp.width,Math.ceil((media.left+media.width)*scaleX)),
      bottom:Math.min(bmp.height,Math.ceil((media.top+media.height)*scaleY))
    };
    const cropWidth=Math.max(1,crop.right-crop.left);
    const cropHeight=Math.max(1,crop.bottom-crop.top);
    // Upscale only when the crop is genuinely small.
    //
    // Blowing every crop up to 1600px was measured to *lose* text: a 1.45x
    // bilinear stretch dilutes a one-pixel white-on-black stroke below the
    // detector's fixed ">235 means light ink" mask, so lettering painted
    // straight onto the artwork disappears. Sweeping display widths 400-900 on
    // a real page (tools/probe_pipeline.py), always-upscaling recovered 25 of
    // 35 known text areas, never-upscaling 23, and "only below 1100px" 28 —
    // with the white-on-black case found at every width instead of vanishing
    // on the large ones.
    const UPSCALE_BELOW=1100;
    const cropLongest=Math.max(cropWidth,cropHeight);
    const upscale=cropLongest>=UPSCALE_BELOW?1:Math.max(1,Math.min(3,1600/cropLongest));
    const outputWidth=Math.max(1,Math.round(cropWidth*upscale));
    const outputHeight=Math.max(1,Math.round(cropHeight*upscale));
    const canvas=new OffscreenCanvas(outputWidth,outputHeight);
    canvas.getContext("2d").drawImage(
      bmp,crop.left,crop.top,cropWidth,cropHeight,0,0,outputWidth,outputHeight
    );
    const image=await canvas.convertToBlob({type:"image/png"});
    const fd=new FormData();
    fd.append("image",image,"manga-image.png");
    const resp=await fetchBackend("/api/recognize-page",{method:"POST",body:fd});
    const result=await resp.json();
    if(!resp.ok)throw new Error(result.detail||"后端错误");
    result.items=(result.items||[]).map(item=>({
      ...item,
      rect:{
        left:(item.bbox.left/upscale+crop.left)*viewport.width/bmp.width,
        top:(item.bbox.top/upscale+crop.top)*viewport.height/bmp.height,
        width:(item.bbox.right-item.bbox.left)/upscale*viewport.width/bmp.width,
        height:(item.bbox.bottom-item.bbox.top)/upscale*viewport.height/bmp.height
      }
    }));
    result.items=await Promise.all(result.items.map(async item=>({
      ...item,
      patch:describeRegion(bmp,item.rect,viewport)
    })));
    postResult(port,tabId,{
      type:"RECOGNITION_RESULT",rect:{left:0,top:0,width:viewport.width,height:viewport.height},
      requestId:msg.requestId,result
    });
  }catch(error){
    postResult(port,tabId,{
      type:"RECOGNITION_RESULT",rect:{left:0,top:0,width:msg.viewport?.width||1,height:msg.viewport?.height||1},
      requestId:msg.requestId,result:{ok:false,error:error.message}
    });
  }
}

// Map the pre-provider settings onto the registry so an existing install keeps
// working: `translationMode` used to be the only choice the user had.
function resolveProvider(cfg) {
  const registry = globalThis.OMT_providers;
  const explicit = cfg.translationProvider;
  // "none" is a real entry so the settings dropdown can offer it, but it has no
  // adapter and must resolve to "translation is off".
  const usable = (provider) => (provider && provider.adapter ? provider : null);
  if (explicit) return usable(registry.byId(explicit));
  const mode = cfg.translationMode || "none";
  if (mode === "none") return null;
  if (mode === "free-translate") return usable(registry.byId("google-free"));
  return cfg.translationEndpoint ? usable(registry.byId("custom")) : usable(registry.byId("openai"));
}

/** Fetch a provider endpoint, turning HTTP errors into readable messages. */
async function providerFetch(url, init, provider) {
  let response;
  if (provider?.id === "backend") {
    const backends = await globalThis.OMT_backendCandidates();
    let lastError = null;
    response = null;
    for (const base of backends) {
      try {
        const candidate = await fetch(`${base}${new URL(url).pathname}`, init);
        if (candidate.ok || candidate.status >= 400) { response = candidate; break; }
        lastError = new Error(`${base} 响应失败: ${candidate.status}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (!response) throw new Error(`后端连接失败（${lastError?.message || "未配置后端"}）`);
  } else {
    try {
      response = await fetch(url, init);
    } catch (error) {
      // A bare "Failed to fetch" tells the user nothing about which service died.
      throw new Error(`无法连接翻译服务（${error.message}）。请检查网络、接口地址，以及该域名是否已授权。`);
    }
  }

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Some gateways answer with HTML on failure; keep a snippet for the message.
  }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || json?.detail ||
      text.slice(0, 160).replace(/\s+/g, " ").trim();
    // 429 and the anti-bot interstitial are the two failures users will hit
    // most with the keyless endpoint, and "429" alone tells them nothing.
    if (response.status === 429) {
      throw new Error("翻译服务限流了（429）。稍后再试，或在设置里换用其它翻译来源。");
    }
    if (response.status === 403 || /sorry\/index/.test(text)) {
      throw new Error("翻译服务拒绝了这次请求（疑似反爬限制）。请换用其它翻译来源。");
    }
    throw new Error(`翻译服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
  }
  if (json === null) throw new Error("翻译服务返回了非 JSON 内容，请检查接口地址是否正确");
  return json;
}

async function runTranslation(texts, cfg) {
  const provider = resolveProvider(cfg);
  if (!provider) throw new Error("未启用翻译");
  const registry = globalThis.OMT_providers;

  const common = {
    endpoint: (cfg.translationEndpoint || provider.endpoint || "").replace(/\/+$/, ""),
    apiKey: cfg.translationApiKey || "",
    appId: cfg.translationAppId || "",
    model: cfg.translationModel || provider.model || "",
    mode: cfg.translationMode || "openai-compatible",
    source: provider.source || "ja",
    target: cfg.targetLanguage || provider.target || "zh-CN",
    salt: Math.floor(Math.random() * 1e9),
  };
  if (!common.endpoint && provider.endpointEditable) {
    throw new Error(`${provider.label} 需要填写接口地址`);
  }

  // Google's public endpoint takes one query per request, so it is called once
  // per text rather than in a batch.
  if (provider.perRequest) {
    const out = [];
    for (const text of texts) {
      const request = provider.adapter({ ...common, text, texts: [text] });
      const json = await providerFetch(request.url, request.init, provider);
      out.push(...provider.parse(json, 1));
    }
    return out;
  }

  const request = await provider.adapter({ ...common, texts });
  const json = await providerFetch(request.url, request.init, provider);
  return provider.parse(json, texts.length);
}

async function translateTexts(msg, port) {
  const cfg = await chrome.storage.local.get([
    "translationMode", "translationProvider", "translationEndpoint",
    "translationModel", "translationApiKey", "translationAppId", "targetLanguage",
  ]);
  const configuredMode = cfg.translationMode || "none";
  try {
    // "Switched off" is a normal state, not a failure. It used to reach
    // runTranslation, throw, and be reported as an error — which made every
    // recognition look like something had gone wrong, and meant the content
    // script's translation-off branch never ran at all.
    if (!resolveProvider(cfg)) {
      postPortMessage(port, {
        type: "TRANSLATION_RESULT",
        requestId: msg.requestId,
        mode: "none",
        result: { ok: true, items: [] },
      });
      return;
    }
    const translated = await runTranslation(msg.texts || [], cfg);
    postPortMessage(port, {
      type: "TRANSLATION_RESULT",
      requestId: msg.requestId,
      mode: configuredMode,
      result: {
        ok: true,
        items: (msg.texts || []).map((text, index) => ({ text, translated: translated[index] })),
      },
    });
  } catch (error) {
    postPortMessage(port, {
      type: "TRANSLATION_RESULT",
      requestId: msg.requestId,
      mode: "error",
      result: { ok: false, error: error.message },
    });
  }
}