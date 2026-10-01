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

async function recognizeRegion(msg,tabId,port){
  try{
    const cfg=await chrome.storage.local.get(["debugMode"]);
    const tab=await chrome.tabs.get(tabId);
    const data=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"});
    const imageBytes=Uint8Array.from(atob(data.slice(data.indexOf(",")+1)),char=>char.charCodeAt(0));
    const blob=new Blob([imageBytes],{type:"image/png"});
    const bmp=await createImageBitmap(blob);
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
    postPortMessage(port,{
      type:"RECOGNITION_RESULT",
      rect:r,
      requestId:msg.requestId,
      result:json
    });
  }catch(error){
    postPortMessage(port,{
      type:"RECOGNITION_RESULT",
      rect:msg.rect,
      requestId:msg.requestId,
      result:{ok:false,error:error.message}
    });
  }
}

async function translateTexts(msg,port){
  try{
    const resp=await fetchBackend("/api/translate-text",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({texts:msg.texts||[]})
    });
    const result=await resp.json();
    if(!resp.ok) throw new Error(result.detail||"翻译服务错误");
    postPortMessage(port,{
      type:"TRANSLATION_RESULT",
      requestId:msg.requestId,
      result
    });
  }catch(error){
    postPortMessage(port,{
      type:"TRANSLATION_RESULT",
      requestId:msg.requestId,
      result:{ok:false,error:error.message}
    });
  }
}