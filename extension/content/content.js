let selecting=false,dragging=false,startX=0,startY=0,box=null,selectionRect=null,selectionSize=null;
let activeRequestId=null,resultContent=null,activePort=null,keepAliveTimer=null,requestTimeout=null,recognizedResultReady=false;
chrome.runtime.onMessage.addListener((m)=>{if(m.type==="START_SELECT") startSelect();});
function startSelect(){if(selecting)return;selecting=true;dragging=false;box=document.createElement("div");box.className="mt-selection";selectionRect=document.createElement("div");selectionRect.className="mt-selection-rect";selectionSize=document.createElement("span");selectionSize.className="mt-selection-size";selectionRect.appendChild(selectionSize);box.appendChild(selectionRect);box.addEventListener("pointerdown",down);box.addEventListener("pointermove",move);box.addEventListener("pointerup",up);box.addEventListener("pointercancel",cancelSelection);document.addEventListener("keydown",onSelectionKeyDown,true);document.body.appendChild(box);}
function stopEvent(e){e.preventDefault();e.stopPropagation();}
function down(e){stopEvent(e);if(e.button!==0)return;dragging=true;startX=e.clientX;startY=e.clientY;box.setPointerCapture(e.pointerId);updateSelection(e.clientX,e.clientY);}
function move(e){if(!selecting||!dragging)return;stopEvent(e);updateSelection(e.clientX,e.clientY);}
function updateSelection(x,y){const left=Math.min(startX,x),top=Math.min(startY,y),width=Math.abs(x-startX),height=Math.abs(y-startY);Object.assign(selectionRect.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});selectionSize.textContent=`${Math.round(width)} × ${Math.round(height)}`;}
function up(e){if(!selecting||!dragging)return;stopEvent(e);dragging=false;const rect={left:Math.min(startX,e.clientX),top:Math.min(startY,e.clientY),width:Math.abs(startX-e.clientX),height:Math.abs(startY-e.clientY)};finishSelection();if(rect.width<20||rect.height<20)return;startRecognition(rect);}
function onSelectionKeyDown(e){if(e.key==="Escape")cancelSelection(e);}
function cancelSelection(e){if(e)stopEvent(e);finishSelection();}
function finishSelection(){selecting=false;dragging=false;document.removeEventListener("keydown",onSelectionKeyDown,true);if(box){box.removeEventListener("pointerdown",down);box.removeEventListener("pointermove",move);box.removeEventListener("pointerup",up);box.removeEventListener("pointercancel",cancelSelection);box.remove();}box=null;selectionRect=null;selectionSize=null;}
function startRecognition(rect){
	const requestId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
	activeRequestId=requestId;
	resultContent=null;
	showBusy(rect);
	try{
		const port=chrome.runtime.connect({name:"manga-recognition"});
		activePort=port;
		port.onMessage.addListener(message=>{
			if(message.type==="RECOGNITION_RESULT")showRecognitionResult(message);
			else if(message.type==="TRANSLATION_RESULT")showTranslationResult(message);
		});
		port.onDisconnect.addListener(()=>{
			if(activePort===port&&activeRequestId===requestId){
				const reason=chrome.runtime.lastError?.message||"后台识别连接已断开";
				if(recognizedResultReady){
					console.warn("翻译连接已断开，保留 OCR 原文：",reason);
					closeRequestPort();
				}else{
					failRecognition(requestId,reason);
				}
			}
		});
		keepAliveTimer=setInterval(()=>{
			if(activePort===port)port.postMessage({type:"KEEPALIVE",requestId});
		},10000);
		requestTimeout=setTimeout(()=>failRecognition(requestId,"识别超时，请重试"),180000);
		recognizedResultReady=false;
		port.postMessage({
			type:"RECOGNIZE_REGION",
			rect,
			requestId,
			viewport:{width:window.innerWidth,height:window.innerHeight}
		});
	}catch(error){
		failRecognition(requestId,error.message);
	}
}
function showBusy(rect){box=document.createElement("div");box.className="mt-overlay";Object.assign(box.style,{left:rect.left+"px",top:rect.top+"px",width:rect.width+"px",height:rect.height+"px"});const content=document.createElement("div"),spinner=document.createElement("span"),label=document.createElement("span");content.className="mt-overlay-loading";content.setAttribute("role","status");content.setAttribute("aria-live","polite");spinner.className="mt-loading-spinner";spinner.setAttribute("aria-hidden","true");label.textContent="正在识别…";content.appendChild(spinner);content.appendChild(label);box.appendChild(content);document.body.appendChild(box);}
function removeBusy(){if(box){box.remove();box=null}}
function showRecognitionResult(message){if(message.requestId!==activeRequestId)return;removeBusy();if(!message.result?.ok){failRecognition(message.requestId,message.result?.error||"未知错误");return;}if(requestTimeout){clearTimeout(requestTimeout);requestTimeout=null;}try{renderResults(message.rect,message.result);recognizedResultReady=true;const texts=(message.result.items||[]).map(item=>item.text).filter(Boolean);if(texts.length&&activePort){requestTimeout=setTimeout(()=>{console.warn("翻译超时，保留 OCR 原文");closeRequestPort();},45000);try{activePort.postMessage({type:"TRANSLATE_TEXTS",texts,requestId:message.requestId});}catch(error){console.warn("翻译请求发送失败，保留 OCR 原文：",error.message);closeRequestPort();}}else{closeRequestPort();}}catch(error){failRecognition(message.requestId,"显示结果失败："+error.message);}}
function showTranslationResult(message){if(message.requestId!==activeRequestId)return;if(message.result?.ok&&resultContent?.isConnected){const items=message.result.items||[];resultContent.textContent=items.map(item=>(item.translated||item.text)?.trim()).filter(Boolean).join("\n\n");}else if(!message.result?.ok){console.warn("翻译失败，保留 OCR 原文：",message.result?.error);}closeRequestPort();}
function closeRequestPort(){if(keepAliveTimer){clearInterval(keepAliveTimer);keepAliveTimer=null;}if(requestTimeout){clearTimeout(requestTimeout);requestTimeout=null;}const port=activePort;activePort=null;if(port)port.disconnect();}
function failRecognition(requestId,message){if(activeRequestId!==requestId)return;closeRequestPort();removeBusy();activeRequestId=null;resultContent=null;recognizedResultReady=false;alert("识别失败："+message);}
function renderResults(rect,result){if(!result?.ok)throw new Error(result?.error||"未知错误");const items=result.items||[],text=items.map(x=>x.text?.trim()).filter(Boolean).join("\n\n");box=document.createElement("div");box.className="mt-overlay";Object.assign(box.style,{left:rect.left+"px",top:rect.top+"px",width:rect.width+"px",height:rect.height+"px"});const panel=box,close=document.createElement("button"),content=document.createElement("div");close.className="mt-overlay-close";close.type="button";close.textContent="×";close.setAttribute("aria-label","关闭识别结果");content.className="mt-overlay-content";content.textContent=text||"未识别到文字";const dismiss=()=>{panel.remove();if(box===panel)box=null;if(resultContent===content)resultContent=null;if(activeRequestId){closeRequestPort();activeRequestId=null;}document.removeEventListener("keydown",onKeyDown,true);};const onKeyDown=e=>{if(e.key==="Escape")dismiss();};close.addEventListener("click",dismiss);panel.appendChild(content);panel.appendChild(close);document.body.appendChild(panel);document.addEventListener("keydown",onKeyDown,true);resultContent=content;}