// Browser plugin not available: use the repository's Puppeteer extension runner.
// Optional --speech: actual tab audio -> running backend -> subtitle overlay.
// MAS_VIDEO_WAV supplies a synthetic speech fixture. --live reads a hidden key.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import http from 'node:http';
import puppeteer from 'puppeteer';

const live = process.argv.includes('--live');
const speech = process.argv.includes('--speech');
let key = '';
if (live) {
  assert.ok(process.stdin.isTTY); process.stdin.setRawMode(true);
  const input = createInterface({input:process.stdin,terminal:false});
  console.log('Paste test API key (hidden), then Enter:');
  try { key = String(await new Promise(done=>input.once('line',done))).trim(); }
  finally { input.close(); process.stdin.setRawMode(false); process.stdin.pause(); }
}
const out = process.env.MAS_SCREENSHOT_DIR || join(tmpdir(),'maslingo-video-qa');
mkdirSync(out,{recursive:true});
const audio = speech ? readFileSync(process.env.MAS_VIDEO_WAV) : null;
const server = http.createServer((req,res)=>{
  if(req.url==='/voice.wav'){res.writeHead(200,{'Content-Type':'audio/wav'});res.end(audio);return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html><head><title>MasLingo Video QA</title><style>
  body{margin:24px;background:#eee;font:18px system-ui}h1{font-size:24px}
  #player-shell{position:relative;width:720px;max-width:100%;aspect-ratio:16/9;overflow:hidden;background:#393e50}
  #player-stack{position:relative;display:flex;flex-direction:column;height:100%}
  #movie_player{position:relative;display:block;height:100%;min-height:0;overflow:hidden}
  video{display:block;width:100%;height:100%;background:#152d40}
  .ytp-caption-window-container{position:absolute;bottom:0;color:white}
  </style></head><body><h1>Video subtitle test</h1><div id="player-shell"><div id="player-stack"><media-controller id="movie_player"><video controls></video><div class="ytp-caption-window-container"></div></media-controller></div></div></body></html>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let browser, page;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
try{
  const extension=resolve('extension');
  browser=await puppeteer.launch({headless:true,ignoreDefaultArgs:['--mute-audio'],args:['--no-sandbox','--disable-features=DisableLoadExtensionCommandLineSwitch',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,
    '--autoplay-policy=no-user-gesture-required','--auto-select-tab-capture-source-by-title=MasLingo Video QA','--allow-http-screen-capture',
    ...(process.env.MAS_TEST_PROXY?[`--proxy-server=${process.env.MAS_TEST_PROXY}`]:[])]});
  const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker')).worker();
  await worker.evaluate(async ({key,live})=>{
    globalThis.videoCalls=[]; globalThis.videoAudioRequests=0;
    const oldFetch=fetch;
    globalThis.fetch=async(...args)=>{
      // Isolate video requests from the panel's unrelated startup OCR probe.
      if(String(args[0]).endsWith('/health')) return new Response('{}',{status:503});
      if(String(args[0]).endsWith('/api/transcribe-audio')) videoAudioRequests++;
      const response=await oldFetch(...args);if(String(args[0]).includes('api.deepseek.com'))videoCalls.push({status:response.status});return response;
    };
    if(live){const get=chrome.storage.local.get.bind(chrome.storage.local);chrome.storage.local.get=async keys=>({...await get(keys),translationApiKey:key});}
    else Object.assign(MAS_providers.byId('deepseek'),{adapter:async request=>{videoCalls.push(request.texts);if(globalThis.videoDelay)await new Promise(done=>setTimeout(done,videoDelay));return {url:'data:application/json,'+encodeURIComponent(JSON.stringify(request.texts.map(t=>'译文：'+t))),init:{}};},parse:payload=>payload});
    await chrome.storage.local.set({translationProvider:'deepseek',translationMode:'openai-compatible',translationApiKey:'',translationModel:'deepseek-flash',translationModelProvider:'deepseek',targetLanguage:'简体中文',videoDisplayMode:'bilingual',webAutoTranslate:false,hoverTranslate:false,selectionTranslate:false});
  },{key,live}); key='';
  page=await browser.newPage();await page.setViewport({width:1100,height:850});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);assert.equal(await page.title(),'MasLingo Video QA');
  // Real playable video, with optional synthesized audio; no network media.
  await page.evaluate(async speech=>{
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=405;
    const ctx=canvas.getContext('2d');const stream=canvas.captureStream(10);
    const draw=setInterval(()=>{ctx.fillStyle='#152d40';ctx.fillRect(0,0,720,405);ctx.fillStyle='#fff';ctx.font='28px sans-serif';ctx.fillText('MasLingo · Video subtitles',100,210);},100);
    let audioContext,source;
    if(speech){audioContext=new AudioContext();const buffer=await audioContext.decodeAudioData(await(await fetch('/voice.wav')).arrayBuffer());source=audioContext.createBufferSource();source.buffer=buffer;const target=audioContext.createMediaStreamDestination();source.connect(target);stream.addTrack(target.stream.getAudioTracks()[0]);source.start();}
    const chunks=[];const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'+(speech?',opus':'')});recorder.ondataavailable=e=>chunks.push(e.data);
    const stopped=new Promise(done=>recorder.onstop=done);recorder.start();await new Promise(done=>setTimeout(done,speech?9000:2000));recorder.stop();await stopped;
    clearInterval(draw);stream.getTracks().forEach(t=>t.stop());await audioContext?.close();
    const video=document.querySelector('video');video.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));video.loop=true;
    await new Promise(done=>video.onloadeddata=done);
    globalThis.track=video.addTextTrack('subtitles','English','en');track.mode='showing';
    track.addCue(new VTTCue(0,0.9,'Hello everyone.'));track.addCue(new VTTCue(1,30,'Please enjoy the video.'));
    globalThis.videoRoot=()=>document.querySelector('[data-maslingo-video]').shadowRoot;
  },speech);
  await page.waitForSelector('[data-maslingo-video]');await wait(250);
  assert.ok(await page.evaluate(() => {
    const shell = document.querySelector('#player-shell');
    const panel = videoRoot().host;
    return panel.previousElementSibling === shell &&
      Math.abs(document.querySelector('video').getBoundingClientRect().height - shell.getBoundingClientRect().height) < 1;
  }), 'controls are outside the entire player shell and do not shrink the native video');
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.bar').getBoundingClientRect().top>=document.querySelector('video').getBoundingClientRect().bottom),'controls must stay outside the video');
  assert.equal(await worker.evaluate(()=>videoCalls.length),0,'no request before explicit start');
  const click=async selector=>(await page.evaluateHandle(s=>videoRoot().querySelector(s),selector)).asElement().click();
  const select=async value=>page.evaluate(value=>{const e=videoRoot().querySelector('.mode');e.value=value;e.dispatchEvent(new Event('change'));},value);
  await click('.start');
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('\n'),{timeout:90000});
  assert.equal(await page.evaluate(()=>track.mode),'hidden');
  await page.screenshot({path:join(out,'video-bilingual.png')});
  const count=await worker.evaluate(()=>videoCalls.length);
  await select('source');await wait(250);assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'Hello everyone.');
  await select('translated');await wait(250);assert.ok(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent.length>0));
  assert.equal(await worker.evaluate(()=>videoCalls.length),count,'mode switches reuse cache');
  await page.$eval('video',v=>v.currentTime=1.2);
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.length>0&&!videoRoot().querySelector('.caption').textContent.includes('Hello'),{timeout:90000});
  await page.$eval('video',v=>v.requestFullscreen());
  await page.waitForFunction(()=>document.fullscreenElement&&getComputedStyle(videoRoot().host).display==='none');
  assert.ok(await page.$eval('video',v=>[...v.textTracks].some(t=>t.label==='MasLingo'&&t.mode==='showing')),'native subtitles render in video fullscreen');
  await page.evaluate(()=>document.exitFullscreen());await wait(200);
  assert.ok(await page.evaluate(()=>getComputedStyle(videoRoot().host).display!=='none'));
  await click('.start');assert.equal(await page.evaluate(()=>track.mode),'showing');assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'');
  // Web-player captions without native tracks, and exact style restoration.
  await page.evaluate(()=>{track.mode='disabled';document.querySelector('.ytp-caption-window-container').textContent='Hello everyone.';});
  // Native track remains preferred when available; test removal with a new video.
  await page.evaluate(()=>{const old=document.querySelector('video');const next=old.cloneNode(true);old.replaceWith(next);globalThis.videoRoot=()=>[...document.querySelectorAll('[data-maslingo-video]')].at(-1).shadowRoot;});
  await wait(2300);await select('bilingual');await click('.start');
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('Hello everyone.'),{timeout:90000});
  assert.equal(await page.$eval('.ytp-caption-window-container',e=>e.style.visibility),'hidden');
  await click('.start');assert.equal(await page.$eval('.ytp-caption-window-container',e=>e.style.visibility),'');
  await page.setViewport({width:390,height:844});await wait(250);
  assert.ok(await page.evaluate(()=>{const r=document.querySelector('[data-maslingo-video]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.bar').getBoundingClientRect().top>=document.querySelector('video').getBoundingClientRect().bottom),'mobile controls must not cover the video');
  await page.screenshot({path:join(out,'video-mobile.png')});await page.setViewport({width:1100,height:850});
  console.log('PASS native cues, modes/cache, seeking, source restoration, DOM captions, dynamic videos, mobile controls');
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,url);
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
    globalThis.originalDisplayMedia=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException('cancelled','NotAllowedError');};
  }}),tabId);
  await click('.speech');await page.waitForFunction(()=>videoRoot().querySelector('.status').textContent.includes('未获得'));
  assert.equal(await page.evaluate(()=>videoRoot().querySelector('.speech').getAttribute('aria-pressed')),'false');
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{navigator.mediaDevices.getDisplayMedia=globalThis.originalDisplayMedia;}}),tabId);
  if(!live){
    await worker.evaluate(()=>globalThis.videoDelay=1000);
    const before=await worker.evaluate(()=>videoCalls.length);
    await page.$eval('.ytp-caption-window-container',e=>e.textContent='A late subtitle must not return after stopping.');
    await click('.start');
    for(let i=0;i<20&&await worker.evaluate(()=>videoCalls.length)===before;i++)await wait(100);
    await click('.start');await wait(1300);
    assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'');
    await worker.evaluate(()=>globalThis.videoDelay=0);
  }
  console.log('PASS cancelled capture and stopped/late captions');
  if(speech){
    await page.$eval('.ytp-caption-window-container',e=>e.textContent='');
    await select('bilingual');await page.$eval('video',v=>{v.currentTime=0;return v.play();});
    await click('.speech');
    await page.waitForFunction(()=>videoRoot().querySelector('.speech').getAttribute('aria-pressed')==='true',{timeout:30000});
    await page.waitForFunction(()=>/hello|video|everyone|today/i.test(videoRoot().querySelector('.caption').textContent),{timeout:120000});
    await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('\n'),{timeout:90000});
    console.log('PASS real shared-tab audio -> local speech model -> translation -> overlay');
    console.log(JSON.stringify({caption:await page.evaluate(()=>videoRoot().querySelector('.caption').textContent)}));
    await page.screenshot({path:join(out,'video-speech.png')});
    await click('.speech');const audioCount=await worker.evaluate(()=>videoAudioRequests);await wait(6000);
    assert.equal(await worker.evaluate(()=>videoAudioRequests),audioCount,'stop prevents further audio uploads');
    assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'','stop suppresses late results');
  }
  assert.deepEqual(errors,[]);console.log('PASS no script errors; screenshots: '+out);
}catch(error){
  if(page&&!page.isClosed())console.log(await page.evaluate(()=>({videoTime:document.querySelector('video')?.currentTime,paused:document.querySelector('video')?.paused,status:videoRoot().querySelector('.status').textContent,caption:videoRoot().querySelector('.caption').textContent})));
  throw error;
}finally{key='';await browser?.close();await new Promise(done=>server.close(done));}
