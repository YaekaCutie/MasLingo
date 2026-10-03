const BACKEND_URLS=["http://127.0.0.1:8001","http://localhost:8001"];

async function fetchBackend(path,options={}){
  let lastError=null;
  for(const base of BACKEND_URLS){
    try{
      const resp=await fetch(`${base}${path}`,options);
      if(resp.ok || resp.status >= 400){
        return resp;
      }
      lastError=new Error(`后端响应失败: ${resp.status}`);
    }catch(e){
      lastError=new Error(`${base}: ${e.message}`);
    }
  }
  throw new Error(`本地后端连接失败（${lastError?.message||"后端未运行或无法访问"}）`);
}

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
    const patch = await createImagePatch(bmp,r,viewport);
    const recognizedText = (json.items||[])
      .map(item=>item.text?.trim())
      .filter(Boolean)
      .join("\n");
    json.items = recognizedText ? [{text:recognizedText,patch}] : [];
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
    const upscale=Math.max(1,Math.min(3,1600/Math.max(cropWidth,cropHeight)));
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