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

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type!=="RECOGNIZE_REGION") return;
  (async()=>{
    try{
      const cfg=await chrome.storage.local.get(["debugMode"]);

      const tab=await chrome.tabs.get(sender.tab.id);
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
      ctx.drawImage(
        bmp,sx,sy,cropWidth,cropHeight,0,0,cropWidth,cropHeight
      );
      const cropped=await canvas.convertToBlob({type:"image/png"});
      await chrome.tabs.sendMessage(tab.id,{type:"RECOGNITION_CAPTURED",rect:r});
      const fd=new FormData();
      fd.append("image",cropped,"manga.png");

      const resp=await fetchBackend("/api/recognize-image",{
        method:"POST",body:fd
      });
      const json=await resp.json();
      if(!resp.ok) throw new Error(json.detail||"后端错误");
      json.debug_mode=cfg.debugMode!==false;
      sendResponse(json);
    }catch(e){
      sendResponse({ok:false,error:e.message});
    }
  })();
  return true;
});