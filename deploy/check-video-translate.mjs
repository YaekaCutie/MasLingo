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
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
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
    track.addCue(new VTTCue(0,0.62,'Hello everyone.'));track.addCue(new VTTCue(0.7,30,'Please enjoy the video.'));
    track.addCue(new VTTCue(60,65,'A cue automatically prepared before it is played.'));
    globalThis.videoRoot=()=>document.querySelector('[data-maslingo-video]').shadowRoot;
  },speech);
  await page.waitForSelector('[data-maslingo-video]');await wait(250);
  assert.ok(await page.evaluate(() => {
    const shell = document.querySelector('#player-shell');
    const panel = videoRoot().host;
    return panel.previousElementSibling === shell &&
      Math.abs(document.querySelector('video').getBoundingClientRect().height - shell.getBoundingClientRect().height) < 1;
  }), 'controls are outside the entire player shell and do not shrink the native video');
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.surface').getBoundingClientRect().top>=document.querySelector('video').getBoundingClientRect().bottom),'the floating window defaults to below the video');
  assert.equal(await worker.evaluate(()=>videoCalls.length),0,'no request before explicit start');
  const click=async selector=>(await page.evaluateHandle(s=>videoRoot().querySelector(s),selector)).asElement().click();
  const select=async value=>page.evaluate(value=>{const e=videoRoot().querySelector('.mode');e.value=value;e.dispatchEvent(new Event('change'));},value);
  const visibleButtons=()=>page.evaluate(()=>[...videoRoot().querySelectorAll('button')].filter(button=>button.offsetWidth).map(button=>button.className));
  const openSettings=async()=>{
    if(await page.evaluate(()=>videoRoot().querySelector('.settings').hidden)) await click('.gear');
  };
  assert.deepEqual(await visibleButtons(),['gear','close'],'the bar only shows the settings and close buttons');
  assert.ok(await page.evaluate(()=>{
    const surface=videoRoot().querySelector('.surface').getBoundingClientRect();
    const idle=videoRoot().querySelector('.idle').getBoundingClientRect();
    return surface.width===document.querySelector('video').getBoundingClientRect().width &&
      Math.abs((surface.left+surface.right)/2-(idle.left+idle.right)/2)<1;
  }),'the subtitle bar matches the player width and centers the text');
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,url);
  assert.deepEqual(await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'READER_VIDEO'},{frameId:0}),tabId),{ok:true});
  assert.ok(await page.evaluate(()=>{
    const menu=videoRoot().querySelector('.settings').getBoundingClientRect();
    return menu.top>document.querySelector('video').getBoundingClientRect().bottom;
  }),'opening settings from the reader keeps the docked menu below the player');
  assert.ok((await visibleButtons()).includes('prepare'),'settings immediately exposes subtitle actions');
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.auto-prepare').checked),'automatic preparation is on by default');
  await click('.start');
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('\n'),{timeout:90000});
  await page.waitForFunction(()=>videoRoot().querySelector('.prepare-status').textContent.includes('已预翻译 3 条'),{timeout:90000});
  if(!live) assert.ok(await worker.evaluate(()=>videoCalls.flat().includes('A cue automatically prepared before it is played.')));
  assert.equal(await page.evaluate(()=>track.mode),'hidden');
  await page.mouse.move(10,10);
  await page.screenshot({path:join(out,'video-settings-default.png')});
  await click('.gear');
  await page.mouse.move(10,10);
  await page.screenshot({path:join(out,'video-bilingual.png')});
  await click('.gear');
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.mode').offsetWidth>0),'display modes are directly available in settings');
  const count=await worker.evaluate(()=>videoCalls.length);
  await select('source');await wait(250);assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'Hello everyone.');
  await select('translated');await wait(250);assert.ok(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent.length>0));
  assert.equal(await worker.evaluate(()=>videoCalls.length),count,'mode switches reuse cache');
  await page.$eval('video',v=>v.currentTime=1.2);
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.length>0&&!videoRoot().querySelector('.caption').textContent.includes('Hello'),{timeout:90000});
  assert.equal(await worker.evaluate(()=>videoCalls.length),count,'seeking reuses translations already prefetched');
  await page.$eval('video',v=>v.requestFullscreen());
  await page.waitForFunction(()=>document.fullscreenElement&&getComputedStyle(videoRoot().host).display==='none');
  assert.ok(await page.$eval('video',v=>[...v.textTracks].some(t=>t.label==='MasLingo'&&t.mode==='showing')),'native subtitles render in video fullscreen');
  await page.evaluate(()=>document.exitFullscreen());await wait(200);
  assert.ok(await page.evaluate(()=>getComputedStyle(videoRoot().host).display!=='none'));
  await click('.close');
  await wait(200);
  assert.equal(await page.evaluate(()=>getComputedStyle(videoRoot().host).display),'none');
  assert.equal(await page.evaluate(()=>track.mode),'showing');
  assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'');
  assert.deepEqual(await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'READER_VIDEO'},{frameId:0}),tabId),{ok:true});
  await openSettings();
  if(!live){
    await click('.auto-prepare');
    await page.evaluate(()=>{
      track.addCue(new VTTCue(0.83,1.12,'An overlapping subtitle.'));
      track.addCue(new VTTCue(70,75,'A cue beyond the normal prefetch window.'));
    });
    await worker.evaluate(()=>globalThis.videoDelay=550);
    await select('bilingual');
    await click('.start');
    await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('Please enjoy'));
    assert.ok(await page.evaluate(()=>videoRoot().querySelector('.prepare-status').textContent.includes('手动预翻译')));
    assert.equal(await worker.evaluate(()=>videoCalls.flat().includes('A cue beyond the normal prefetch window.')),false);
    await click('.prepare');
    await page.waitForFunction(()=>videoRoot().querySelector('.prepare-status').textContent.includes('已预翻译 5 条'));
    assert.ok(await worker.evaluate(()=>['Please enjoy the video. An overlapping subtitle.','A cue beyond the normal prefetch window.'].every(text=>videoCalls.flat().includes(text))));
    await page.screenshot({path:join(out,'video-settings.png')});
    const preparedCount=await worker.evaluate(()=>videoCalls.length);
    await click('.gear');
    for(const [time,text] of [[0.67,''],[0.74,'Please enjoy the video.'],[0.95,'Please enjoy the video. An overlapping subtitle.'],[1.18,'Please enjoy the video.']]){
      await page.$eval('video',(video,time)=>video.currentTime=time,time);
      await page.waitForFunction(text=>videoRoot().querySelector('.caption').textContent===(text?text+'\n译文：'+text:''),{timeout:1500},text);
    }
    await page.$eval('video',video=>{video.currentTime=0.72;return video.play();});
    await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('An overlapping subtitle.'),{timeout:3000});
    await page.$eval('video',video=>video.pause());
    assert.equal(await worker.evaluate(()=>videoCalls.length),preparedCount,'prepared overlapping cues and gaps follow the timeline without new translation requests');
    await worker.evaluate(()=>globalThis.videoDelay=0);
    await page.evaluate(()=>{
      track.addCue(new VTTCue(0.62,0.7,'A newly loaded subtitle.'));
      document.querySelector('video').currentTime=0.67;
    });
    await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent==='A newly loaded subtitle.\n译文：A newly loaded subtitle.');
    await openSettings();
    assert.ok(await page.evaluate(()=>videoRoot().querySelector('.prepare-status').textContent.includes('新内容')&&!videoRoot().querySelector('.prepare').disabled));
    await click('.start');
    console.log('PASS floating window, compact settings, and pretranslated timed cues');
  }
  await page.mouse.click(10,10);
  assert.deepEqual(await visibleButtons(),['gear','close'],'clicking outside dismisses the menu');
  const gear=await page.evaluate(()=>{const r=videoRoot().querySelector('.gear').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await page.mouse.move(gear.x,gear.y);await page.mouse.down();
  await page.mouse.move(gear.x+190,gear.y+115,{steps:12});await page.mouse.up();
  assert.deepEqual(await visibleButtons(),['gear','close'],'dragging the gear does not open settings');
  assert.ok(await page.evaluate(()=>getComputedStyle(videoRoot().host).position==='fixed'&&videoRoot().host.getBoundingClientRect().left>150));
  await click('.gear');
  assert.ok(await page.evaluate(()=>{
    const menu=videoRoot().querySelector('.settings').getBoundingClientRect();
    const bar=videoRoot().querySelector('.surface').getBoundingClientRect();
    return menu.bottom<bar.top&&Math.abs(menu.right-bar.right)<1&&menu.top>=0;
  }),'floating settings open above and right-aligned near the bottom of the screen');
  await page.screenshot({path:join(out,'video-menu.png')});
  // Web-player captions without native tracks, and exact style restoration.
  await page.evaluate(()=>{track.mode='disabled';document.querySelector('.ytp-caption-window-container').textContent='Hello everyone.';});
  // Native track remains preferred when available; test removal with a new video.
  await page.evaluate(()=>{const old=document.querySelector('video');const next=old.cloneNode(true);old.replaceWith(next);globalThis.videoRoot=()=>[...document.querySelectorAll('[data-maslingo-video]')].at(-1).shadowRoot;});
  await wait(2300);await select('bilingual');await openSettings();
  if(!live) assert.ok(await page.evaluate(()=>!videoRoot().querySelector('.auto-prepare').checked),'new players honor the stored pretranslation setting');
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.prepare').disabled),'live DOM captions cannot be prepared');
  await click('.start');
  await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('Hello everyone.'),{timeout:90000});
  assert.equal(await page.$eval('.ytp-caption-window-container',e=>e.style.visibility),'hidden');
  await click('.start');assert.equal(await page.$eval('.ytp-caption-window-container',e=>e.style.visibility),'');
  await page.setViewport({width:390,height:844});await wait(250);
  assert.ok(await page.evaluate(()=>{const r=document.querySelector('[data-maslingo-video]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  assert.ok(await page.evaluate(()=>videoRoot().querySelector('.surface').getBoundingClientRect().top>=document.querySelector('video').getBoundingClientRect().bottom),'mobile controls must not cover the video');
  await page.screenshot({path:join(out,'video-mobile.png')});await page.setViewport({width:1100,height:850});
  console.log('PASS native cues, modes/cache, seeking, source restoration, DOM captions, dynamic videos, mobile controls');
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
    globalThis.originalDisplayMedia=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException('cancelled','NotAllowedError');};
  }}),tabId);
  await click('.speech');await page.waitForFunction(()=>videoRoot().querySelector('.status').textContent.includes('未获得'));
  assert.equal(await page.evaluate(()=>videoRoot().querySelector('.speech').getAttribute('aria-pressed')),'false');
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{navigator.mediaDevices.getDisplayMedia=globalThis.originalDisplayMedia;}}),tabId);
  if(!live){
    const first = 'A slow subtitle must still be shown in full.';
    const second = 'The next subtitle finishes translating first.';
    await worker.evaluate(()=>globalThis.videoDelay=1700);
    await page.$eval('.ytp-caption-window-container',e=>e.textContent='A slow subtitle');
    await click('.start');
    await page.$eval('.ytp-caption-window-container',(e,text)=>e.textContent=text,first);
    for(let i=0;i<20&&!await worker.evaluate(text=>videoCalls.some(batch=>batch.includes(text)),first);i++)await wait(100);
    assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'','bilingual does not show a partial untranslated line');
    assert.equal(await worker.evaluate(()=>videoCalls.some(batch=>batch.includes('A slow subtitle'))),false,'rolling cue prefixes are merged');
    await worker.evaluate(()=>globalThis.videoDelay=0);
    await page.$eval('.ytp-caption-window-container',(e,text)=>e.textContent=text,second);
    for(let i=0;i<20&&!await worker.evaluate(text=>videoCalls.some(batch=>batch.includes(text)),second);i++)await wait(100);
    await page.$eval('.ytp-caption-window-container',e=>e.textContent='');
    await page.waitForFunction(text=>videoRoot().querySelector('.caption').textContent===text+'\n译文：'+text,{},first);
    await page.waitForFunction(text=>videoRoot().querySelector('.caption').textContent===text+'\n译文：'+text,{},second);
    await click('.start');
    console.log('PASS late and out-of-order replies display complete bilingual cues in playback order');

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
    const startedAt = Date.now();
    await click('.speech');
    await page.waitForFunction(()=>videoRoot().querySelector('.speech').getAttribute('aria-pressed')==='true',{timeout:30000});
    await page.waitForFunction(()=>/hello|video|everyone|today/i.test(videoRoot().querySelector('.caption').textContent),{timeout:120000});
    await page.waitForFunction(()=>videoRoot().querySelector('.caption').textContent.includes('\n'),{timeout:90000});
    console.log('PASS real shared-tab audio -> local speech model -> translation -> overlay');
    console.log(JSON.stringify({firstBilingualMs:Date.now()-startedAt,caption:await page.evaluate(()=>videoRoot().querySelector('.caption').textContent)}));
    await page.waitForFunction(() => /testing video subtitles\b/i.test(videoRoot().querySelector('.caption').textContent),
      {timeout:20000});
    console.log('PASS pause-aware capture preserves the following sentence through the word subtitles');
    await page.screenshot({path:join(out,'video-speech.png')});
    await click('.close');const audioCount=await worker.evaluate(()=>videoAudioRequests);await wait(6000);
    assert.equal(await worker.evaluate(()=>videoAudioRequests),audioCount,'closing the bar prevents further audio uploads');
    assert.equal(await page.evaluate(()=>videoRoot().querySelector('.caption').textContent),'','closing suppresses late results');
    assert.equal(await page.evaluate(()=>getComputedStyle(videoRoot().host).display),'none');
  }
  assert.deepEqual(errors,[]);console.log('PASS no script errors; screenshots: '+out);
}catch(error){
  if(page&&!page.isClosed())console.log(await page.evaluate(()=>({videoTime:document.querySelector('video')?.currentTime,paused:document.querySelector('video')?.paused,status:videoRoot().querySelector('.status').textContent,caption:videoRoot().querySelector('.caption').textContent})));
  throw error;
}finally{key='';await browser?.close();await new Promise(done=>server.close(done));}
