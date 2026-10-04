// This worker is an ES module (manifest background.type), so shared code is
// imported rather than importScripts()'d. config.js only assigns globals, so
// the extension pages can keep loading it as a classic script.
import "../config.js";
import {
  getOcrStatus,
  recognizeImageData,
  recognizePageImageData,
  warmUp,
} from "../ocr/client.js";

// Diagnostic entry point: the worker is an ES module, so imported bindings are
// not reachable from the outside. This exposes them for the browser test in
// deploy/check-ondevice-ocr.mjs and for manual debugging from devtools.
globalThis.OMT_ocr = { getOcrStatus, recognizeImageData, warmUp };

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

async function readOcrMode(){
  const cfg=await chrome.storage.local.get(["ocrMode"]);
  return cfg.ocrMode==="backend"?"backend":"on-device";
}

// The popup asks for on-device engine state so it can report it without
// implying that a missing backend is a problem.
chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message?.type==="OCR_STATUS"){
    sendResponse({status:getOcrStatus()});
    return true;
  }
  return undefined;
});

chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=="manga-recognition")return;
  const tabId=port.sender?.tab?.id;
  if(!tabId){port.disconnect();return;}
  // Starting the model load now means the user's first selection does not pay
  // for it. Failure is fine: recognizeRegion falls back to the backend.
  warmUp().catch(error=>console.warn("端上 OCR 预热失败，将回退到后端：",error.message));
  port.onMessage.addListener(msg=>{
    if(msg.type==="RECOGNIZE_REGION") recognizeRegion(msg,tabId,port);
    else if(msg.type==="RECOGNIZE_PAGE") recognizePage(msg,tabId,port);
    else if(msg.type==="TRANSLATE_TEXTS") translateTexts(msg,port);
    else if(msg.type==="OCR_STATUS") postPortMessage(port,{type:"OCR_STATUS",requestId:msg.requestId,status:getOcrStatus()});
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

/**
 * Recognise one cropped region, preferring on-device inference.
 *
 * On-device is the default because it needs no server, no cloud account and no
 * locally installed Python — and the crop never leaves the machine. The
 * backend is kept as a fallback (and as an explicit choice in the options
 * page) for devices where the model cannot run.
 */
async function recognizeCrop(imageData,canvas,mode){
  if(mode!=="backend"){
    try{
      const result=await recognizeImageData(imageData);
      return {source:"on-device",text:(result.text||"").trim(),milliseconds:result.milliseconds};
    }catch(error){
      console.warn("端上识别不可用，改用后端：",error.message);
    }
  }
  const cropped=await canvas.convertToBlob({type:"image/png"});
  const fd=new FormData();
  fd.append("image",cropped,"manga.png");
  const resp=await fetchBackend("/api/recognize-image",{method:"POST",body:fd});
  const json=await resp.json();
  if(!resp.ok) throw new Error(json.detail||"后端错误");
  return {
    source:"backend",
    text:(json.items||[]).map(item=>item.text?.trim()).filter(Boolean).join("\n")
  };
}

async function recognizeRegion(msg,tabId,port){
  try{
    const cfg=await chrome.storage.local.get(["debugMode"]);
    const mode=await readOcrMode();
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
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(bmp,sx,sy,cropWidth,cropHeight,0,0,cropWidth,cropHeight);

    const ocr=await recognizeCrop(ctx.getImageData(0,0,cropWidth,cropHeight),canvas,mode);
    const patch=await createImagePatch(bmp,r,viewport);
    postResult(port,tabId,{
      type:"RECOGNITION_RESULT",
      rect:r,
      requestId:msg.requestId,
      result:{
        ok:true,
        debug_mode:cfg.debugMode!==false,
        source:ocr.source,
        milliseconds:ocr.milliseconds,
        items:ocr.text?[{text:ocr.text,patch}]:[]
      }
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

async function createImagePatch(bmp,rect,viewport){
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
  const imageScale=Math.min(1,1200/width,1200/height);
  const outputWidth=Math.max(1,Math.round(width*imageScale));
  const outputHeight=Math.max(1,Math.round(height*imageScale));
  const canvas=new OffscreenCanvas(outputWidth,outputHeight);
  canvas.getContext("2d").drawImage(bmp,left,top,width,height,0,0,outputWidth,outputHeight);
  const blob=await canvas.convertToBlob({type:"image/jpeg",quality:0.9});
  return {
    dataUrl:await blobToDataUrl(blob),
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
    const useMedia=media &&
      media.width*media.height >= viewport.width*viewport.height*0.08 &&
      media.width*media.height < viewport.width*viewport.height*0.8 &&
      media.width>=180 && media.height>=180;
    if(!useMedia)throw new Error("未能定位主漫画图片，已取消整页识别以避免识别网页文字。请改用“选择漫画区域并识别”。");
    postPortMessage(port,{type:"CAPTURE_READY",requestId:msg.requestId});
    const crop={
      left:Math.max(0,Math.floor(media.left*scaleX)),
      top:Math.max(0,Math.floor(media.top*scaleY)),
      right:Math.min(bmp.width,Math.ceil((media.left+media.width)*scaleX)),
      bottom:Math.min(bmp.height,Math.ceil((media.top+media.height)*scaleY))
    };
    const cropWidth=Math.max(1,crop.right-crop.left);
    const cropHeight=Math.max(1,crop.bottom-crop.top);
    // Sent as soon as the screenshot is taken: the content script uses it to
    // show the busy indicator, which must appear after the capture (so it is
    // not itself photographed) but before the slow part, so the user gets
    // feedback while detection and OCR run.
    postPortMessage(port,{type:"CAPTURE_READY",requestId:msg.requestId});
    const upscale=Math.max(1,Math.min(3,1600/Math.max(cropWidth,cropHeight)));
    const outputWidth=Math.max(1,Math.round(cropWidth*upscale));
    const outputHeight=Math.max(1,Math.round(cropHeight*upscale));
    const canvas=new OffscreenCanvas(outputWidth,outputHeight);
    const context=canvas.getContext("2d",{willReadFrequently:true});
    context.drawImage(
      bmp,crop.left,crop.top,cropWidth,cropHeight,0,0,outputWidth,outputHeight
    );

    // Region detection and OCR both run on-device by default, so auto-detect
    // no longer needs a backend either.
    let rawItems;
    let source="on-device";
    const mode=await readOcrMode();
    if(mode!=="backend"){
      try{
        const onDevice=await recognizePageImageData(
          context.getImageData(0,0,outputWidth,outputHeight)
        );
        rawItems=(onDevice.items||[]).map(item=>({
          text:item.text,
          bbox:{
            left:item.bbox.left,top:item.bbox.top,
            right:item.bbox.right,bottom:item.bbox.bottom
          }
        }));
      }catch(error){
        console.warn("端上整页识别不可用，改用后端：",error.message);
        source=null;
      }
    }
    if(!source){
      const image=await canvas.convertToBlob({type:"image/png"});
      const fd=new FormData();
      fd.append("image",image,"manga-image.png");
      const resp=await fetchBackend("/api/recognize-page",{method:"POST",body:fd});
      const result=await resp.json();
      if(!resp.ok)throw new Error(result.detail||"后端错误");
      rawItems=result.items||[];
      source="backend";
    }
    const result={ok:true,source};
    result.items=rawItems.map(item=>({
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
      patch:await createImagePatch(bmp,item.rect,viewport)
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

async function translateTexts(msg,port){
  try{
    const cfg=await chrome.storage.local.get([
      "translationMode","translationEndpoint","translationModel","translationApiKey"
    ]);
    const resp=await fetchBackend("/api/translate-text",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        texts:msg.texts||[],
        mode:cfg.translationMode||"none",
        endpoint:cfg.translationEndpoint||"",
        model:cfg.translationModel||"",
        api_key:cfg.translationMode==="openai-compatible"?(cfg.translationApiKey||""):""
      })
    });
    const result=await resp.json();
    if(!resp.ok) throw new Error(result.detail||"翻译服务错误");
    postPortMessage(port,{
      type:"TRANSLATION_RESULT",
      requestId:msg.requestId,
      mode:cfg.translationMode||"none",
      result
    });
  }catch(error){
    postPortMessage(port,{
      type:"TRANSLATION_RESULT",
      requestId:msg.requestId,
      mode:"error",
      result:{ok:false,error:error.message}
    });
  }
}