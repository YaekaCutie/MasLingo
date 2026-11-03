// Production text content script in a real DOM. This runner also works where
// managed Chromium forbids unpacked extensions; it does not test extension APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({headless:true, executablePath:process.env.CHROME_BIN || undefined, args:['--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const script=readFileSync(new URL('../extension/content/text-translate.js',import.meta.url),'utf8');
async function loadScripts() {
 for(const file of ['config.js','translation/providers.js','content/reader-bridge.js','content/quick-toolbar.js']) {
  await page.addScriptTag({content:readFileSync(new URL('../extension/'+file,import.meta.url),'utf8')});
 }
 await page.addScriptTag({content:script});
}
try {
 await page.setViewport({width:1000,height:800});
 await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{font:17px/1.6 sans-serif;margin:30px}article{max-width:650px}td,th{border:1px solid #ccc;padding:8px}p{margin:20px 0}#far{margin-top:1600px}</style>
 <nav>Navigation should stay untouched automatically</nav><article>
 <h1>Research title and results</h1><h2 id="short">AI</h2>
 <p id="prose">A protein <a id="cite" href="#ref">reference</a> and <em>nested emphasis</em> remain available.</p>
 <div id="mixed">Wrapper introduction<div id="nested">Nested paragraph text</div>Wrapper conclusion</div>
 <figure><figcaption>Figure <b>caption with emphasis</b></figcaption></figure>
 <table><tr><th id="head">Method</th><td id="cell">High accuracy</td></tr></table>
 <ul><li>Leading list text<p>Nested list paragraph</p></li></ul>
 <a id="link" href="#ref">Standalone article link</a><button id="button">Download data</button>
 <p id="dynamic">Original dynamic paragraph</p><p id="hidden" hidden>Hidden paragraph</p><div contenteditable>Editable paragraph</div>
 <p id="reference">AlphaFold 2<sup><a href="#ref-CR1">1</a></sup> predicts protein structures.</p>
 <p id="contents"><span style="display:contents">Text through a display contents span</span></p>
 <div style="height:0;overflow:hidden"><p>Clipped hidden article content</p></div>
 <pre>Code should remain unchanged</pre><p id="math">An equation <math><mi>x</mi></math> is retained.</p>
 <div id="shadow"></div><p id="far">Far below the viewport</p></article>`);
 async function mockTranslation() {
 await page.evaluate(()=>{
  globalThis.cfg={translationProvider:'fixture',hoverTranslate:true,webAutoTranslate:false,targetLanguage:'简体中文'};
  globalThis.calls=[];globalThis.listeners=[];globalThis.hold=false;globalThis.pending=[];globalThis.fail=false;
  globalThis.readerMessages=[];globalThis.messageListeners=[];
  globalThis.chrome={storage:{local:{get:async()=>({...cfg})},onChanged:{addListener(fn){listeners.push(fn)}}},runtime:{onMessage:{addListener(fn){messageListeners.push(fn);}},sendMessage:async message=>{
   if(message.type?.startsWith('READER_')){readerMessages.push(message);return {ok:true};}
   calls.push(message);
   if(hold) return new Promise(resolve=>pending.push({message,resolve}));
   return fail?{ok:false,reason:'network failure'}:{ok:true,translations:message.texts.map(t=>'译：'+t),skipped:message.texts.map(()=>false)};
  }}};
  globalThis.setCfg=async changes=>{Object.assign(cfg,changes);for(const fn of listeners)fn(Object.fromEntries(Object.entries(changes).map(([k,v])=>[k,{newValue:v}])),'local');await new Promise(r=>setTimeout(r,250));};
  globalThis.boxes=()=>[...document.querySelectorAll('[data-maslingo-textbox]')];
  globalThis.visible=()=>boxes().filter(h=>h.style.display!=='none');
  globalThis.card=()=>document.querySelector('[data-reader-id="'+readerMessages.filter(m=>m.type==='READER_RESULT').at(-1)?.id+'"]')?.shadowRoot || boxes().at(-1)?.shadowRoot;
 });
 }
 await mockTranslation();
 await page.$eval('#shadow', element => {
  element.attachShadow({mode:'open'}).innerHTML='<p id="shadow-p">Open shadow root paragraph</p>';
 });
 // setContent has an opaque origin; deterministic UUID only for this fixture.
 await page.evaluate(()=>{if(!crypto.randomUUID)crypto.randomUUID=()=> 'fixture-document';});
 await loadScripts();await wait(300);
 assert.equal(await page.evaluate(()=>calls.length),0,'hover mode makes no eager requests');
 const hover=async selector=>{await page.hover(selector);await wait(600);await page.waitForFunction(()=>card()?.querySelector('.text').textContent.startsWith('译：'));};
 const close=async()=>{await page.evaluate(()=>{const host=card()?.host;for(const fn of messageListeners)fn({type:'READER_ACTION',document:readerMessages.find(m=>m.type==='READER_REGISTER').document,id:host?.dataset.readerId,action:'dismiss'},{},()=>{});});await page.mouse.move(1,1);await wait(350);};
 const originals=await page.evaluate(()=>document.querySelector('#prose').innerHTML);
 for(const selector of ['#short','#cell','#head','#button','#link','#contents']){
  await hover(selector);const text=await page.evaluate(()=>card().querySelector('.text').textContent);
  assert.ok(text.length>3,`hover translates ${selector}`);await close();
 }
 await page.$eval('#mixed',e=>e.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));await page.waitForFunction(()=>calls.some(c=>c.texts.includes('Wrapper introduction Wrapper conclusion')));await close();
 assert.ok(await page.evaluate(()=>calls.some(c=>c.texts.includes('Wrapper introduction Wrapper conclusion'))),'mixed wrapper own text is translated');
 const before=await page.$eval('#prose',e=>e.getBoundingClientRect().top);
 await hover('#prose');
 assert.equal(await page.$eval('#prose',e=>e.getBoundingClientRect().top),before,'floating card does not move source');
 await page.mouse.move(1,1);await wait(500);
 assert.equal(await page.evaluate(()=>visible().length),0,'hover result does not occupy page space');
 assert.ok(await page.evaluate(()=>readerMessages.some(m=>m.type==='READER_RESULT' && m.source.includes('A protein'))),'hover publishes its source to the reader');
 assert.equal(await page.$eval('#prose',e=>e.innerHTML),originals,'hover keeps exact inline markup');
 await close();
 await hover('#reference');
 assert.ok(await page.evaluate(()=>calls.some(c=>c.texts.includes('AlphaFold 2[1] predicts protein structures.'))),'superscript citation is separated from model number');await close();
 await page.evaluate(()=>{fail=true;document.querySelector('#dynamic').textContent='Failure and retry paragraph';});await wait(300);await page.hover('#dynamic');
 await page.waitForFunction(()=>card()?.querySelector('.text').dataset.state==='error');
 await page.evaluate(()=>{fail=false;card().querySelector('.retry').click();});
 await page.waitForFunction(()=>card()?.querySelector('.text').textContent==='译：Failure and retry paragraph');await close();
 await page.evaluate(()=>setCfg({webAutoTranslate:true,hoverTranslate:false}));
 await page.waitForFunction(()=>document.querySelector('#prose').nextElementSibling?.dataset.mode==='auto');await wait(450);
 const proseRequests=await page.evaluate(()=>calls.filter(c=>c.texts.includes(document.querySelector('#prose').textContent)).length);
 await page.evaluate(()=>setCfg({hoverTranslate:true}));await page.hover('#prose');await wait(350);
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.texts.includes(document.querySelector('#prose').textContent)).length),proseRequests,'hover and auto share an existing paragraph result');
 assert.equal(await page.evaluate(()=>boxes().filter(h=>h.dataset.mode==='hover').length),0,'combined modes do not create duplicate hover cards');
 await page.evaluate(()=>setCfg({hoverTranslate:false}));
 assert.ok(await page.evaluate(()=>calls.every(c=>!c.texts.some(t=>t.includes('Hidden paragraph')||t.includes('Editable paragraph')||t.includes('Code should')||t.includes('Navigation should')||t.includes('Clipped hidden')))),'hidden/clipped/editor/code/navigation are excluded');
 assert.ok(await page.evaluate(()=>!calls.some(c=>c.texts.includes('Far below the viewport'))),'auto reading stays lazy');
 await page.$eval('#cell',e=>e.scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('#cell [data-maslingo-textbox] .never')===null&&calls.some(c=>c.texts.includes('High accuracy')));
 assert.equal(await page.$eval('#cell',e=>e.closest('table').querySelectorAll('tr').length),1,'table structure is preserved');
 await page.$eval('#dynamic',e=>{e.textContent='Updated dynamic paragraph';e.scrollIntoView({block:'center'});});
 await page.waitForFunction(()=>calls.some(c=>c.texts.includes('Updated dynamic paragraph')));
 await page.waitForFunction(()=>document.querySelector('#dynamic').nextElementSibling?.shadowRoot?.querySelector('.text').textContent==='译：Updated dynamic paragraph');
 await page.$eval('#shadow',e=>e.scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>calls.some(c=>c.texts.includes('Open shadow root paragraph')));
 assert.equal(await page.$eval('#math',e=>!!e.querySelector('math')),true,'formula DOM remains intact');
 await page.$eval('#prose',e=>e.scrollIntoView({block:'center'}));await wait(250);
 const proseSource=await page.$eval('#prose',e=>e.textContent);
 const proseCount=()=>page.evaluate(text=>calls.filter(c=>c.texts.includes(text)).length,proseSource);
 const beforeModes=await proseCount();
 await page.evaluate(()=>{globalThis.savedLink=document.getElementById('cite');globalThis.linkClicks=0;savedLink.addEventListener('click',e=>{e.preventDefault();linkClicks++;});return setCfg({webDisplayMode:'translated'});});
 await page.waitForFunction(()=>document.querySelector('#prose [data-maslingo-cover]'));
 assert.ok((await page.$eval('#prose',e=>e.textContent)).startsWith('译：'),'translation-only replaces eligible prose');
 assert.equal(await page.evaluate(()=>document.querySelector('#prose').nextElementSibling.style.display),'none','translation-only hides the duplicate card');
 assert.equal(await page.$eval('#math',e=>!!e.querySelector('math')),true,'translation-only preserves complex formulas');
 await page.evaluate(()=>setCfg({webDisplayMode:'source'}));
 assert.equal(await page.$eval('#prose',e=>e.innerHTML),originals,'source-only restores exact inline markup');
 assert.ok(await page.evaluate(()=>boxes().filter(h=>h.dataset.mode==='auto').every(h=>h.style.display==='none')),'source-only hides automatic cards');
 assert.equal(await proseCount(),beforeModes,'mode changes reuse cached translation');
 await page.evaluate(()=>setCfg({webDisplayMode:'bilingual'}));
 await page.waitForFunction(()=>document.querySelector('#prose').nextElementSibling.style.display!=='none');
 assert.equal(await proseCount(),beforeModes,'returning to bilingual does not translate cached prose again');
 assert.equal(await page.evaluate(()=>document.getElementById('cite')===savedLink),true,'restore retains original link identity');
 await page.evaluate(()=>savedLink.click());assert.equal(await page.evaluate(()=>linkClicks),1,'restore retains link listeners');
 await page.evaluate(()=>setCfg({webDisplayMode:'source'}));
 const beforeSource=await page.evaluate(()=>calls.length);
 await page.$eval('#dynamic',e=>{e.textContent='New source while reading originals';e.scrollIntoView({block:'center'});});await wait(400);
 assert.equal(await page.evaluate(()=>calls.length),beforeSource,'source-only does not request translation for new content');
 await page.evaluate(()=>setCfg({webDisplayMode:'bilingual'}));
 await page.waitForFunction(()=>calls.some(c=>c.texts.includes('New source while reading originals')));
 await page.evaluate(()=>{hold=true;const e=document.querySelector('#dynamic');e.textContent='Pending old source';e.scrollIntoView({block:'center'});});
 await page.waitForFunction(()=>pending.some(p=>p.message.texts.includes('Pending old source')));
 await page.evaluate(()=>setCfg({webDisplayMode:'source'}));
 await page.evaluate(()=>{hold=false;for(const p of pending)p.resolve({ok:true,translations:p.message.texts.map(()=> 'CACHED LATE')});pending=[];});await wait(350);
 assert.equal(await page.evaluate(()=>boxes().filter(h=>h.dataset.mode==='auto'&&h.style.display!=='none').length),0,'late responses stay hidden in source-only mode');
 const afterLate=await page.evaluate(()=>calls.length);
 await page.evaluate(()=>setCfg({webDisplayMode:'bilingual'}));await wait(300);
 assert.equal(await page.evaluate(()=>calls.length),afterLate,'late completed translation is cached for the next display mode');
 await page.evaluate(()=>{hold=true;const e=document.querySelector('#dynamic');e.textContent='Pending before disable';e.scrollIntoView({block:'center'});});
 await page.waitForFunction(()=>pending.some(p=>p.message.texts.includes('Pending before disable')));
 await page.evaluate(()=>setCfg({webAutoTranslate:false,hoverTranslate:false}));
 assert.equal(await page.evaluate(()=>boxes().length),0,'disabling removes translations');
 await page.evaluate(()=>{hold=false;for(const p of pending)p.resolve({ok:true,translations:p.message.texts.map(()=> 'STALE')});pending=[];});await wait(350);
 assert.equal(await page.evaluate(()=>boxes().length),0,'late responses cannot resurrect cards');
 await page.evaluate(()=>setCfg({hoverTranslate:true}));await hover('#prose');
 await page.$eval('#prose',e=>{e.textContent='Site replaced this paragraph';});
 await page.waitForFunction(()=>calls.some(c=>c.texts.includes('Site replaced this paragraph')));
 assert.equal(await page.$eval('#prose',e=>e.textContent),'Site replaced this paragraph','a site update wins over the parked original');
 const oldCalls=await page.evaluate(()=>calls.length);
 await page.evaluate(()=>setCfg({translationProvider:'new-provider'}));
 await page.waitForFunction(n=>calls.length>n,{},oldCalls);
 await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#prose'));window.getSelection().addRange(r);});await wait(350);
 assert.equal(await page.evaluate(()=>visible().filter(h=>h.dataset.mode==='hover').length),0,'text selection dismisses transient hover cards');
 await page.evaluate(()=>window.getSelection().removeAllRanges());
 await page.setViewport({width:390,height:844});await page.mouse.move(1,1);await hover('#short');
 assert.equal(await page.evaluate(()=>visible().filter(h=>h.dataset.mode==='hover').length),0,'narrow pages remain free of hover overlays');

 const bingUrl='https://www.bing.com/search?q=Nature';
 await page.setViewport({width:1000,height:800});
 await page.setRequestInterception(true);
 page.on('request', request => {
  if(request.url()==='https://www.bing.com/favicon.ico') return request.respond({status:204});
  if(request.url()!==bingUrl) return request.abort();
  return request.respond({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">
   <header>Search site</header><main><ol id="b_results"><li class="b_algo">
   <div class="b_tpcn"><span id="brand">Nature</span><cite>https://www.nature.com</cite></div>
   <h2 id="result-title"><a href="https://www.nature.com">Nature Research Journal</a></h2>
   <div class="b_caption"><p id="snippet">Peer-reviewed research and discovery.</p></div>
   <ul class="b_vlist2col"><li><h3><a id="subtitle" href="https://www.nature.com/nature/research-articles"><strong>Research</strong> Articles</a></h3></li></ul>
   </li></ol></main><aside>Related search suggestions</aside>`});
 });
 await page.goto(bingUrl);
 await mockTranslation();
 await page.evaluate(()=>{
  Object.assign(cfg,{webAutoTranslate:true,webDisplayMode:'bilingual'});
  fail=true;
  globalThis.originalSubtitle=document.querySelector('#subtitle');
  globalThis.subtitleClicks=0;
  originalSubtitle.addEventListener('click', event=>{event.preventDefault();subtitleClicks++;});
 });
 await loadScripts();
 await page.waitForFunction(()=>boxes().some(box=>box.shadowRoot.querySelector('.text').dataset.state==='error'));
 assert.equal(await page.$eval('#subtitle',element=>element.textContent),'Research Articles');
 assert.equal(await page.evaluate(()=>visible().length),0,'failed requests never insert visible search cards');
 await page.evaluate(()=>{fail=false;return setCfg({translationApiKey:'fixture'});});
 await page.waitForFunction(()=>document.querySelector('#subtitle').textContent==='译：Research Articles');
 assert.deepEqual(await page.evaluate(()=>[...new Set(calls.flatMap(call=>call.texts))].sort()),
  ['Research Articles'],'only sitelinks are sent for translation');
 assert.equal(await page.$eval('#snippet',element=>element.textContent),'Peer-reviewed research and discovery.');
 await page.hover('#result-title');
 await wait(300);
 await page.hover('#subtitle');
 await wait(300);
 assert.equal(await page.evaluate(()=>visible().length),0,'successful search results show no cards');
 assert.equal(await page.$('[data-maslingo-quick]'),null,'search titles and subtitles show no controls on hover');
 assert.equal(await page.$eval('#result-title',element=>element.textContent),'Nature Research Journal');
 assert.equal(await page.evaluate(()=>document.querySelector('#subtitle')===originalSubtitle),true);
 await page.click('#subtitle');
 assert.equal(await page.evaluate(()=>subtitleClicks),1,'translated sitelinks keep their original click handlers');
 await page.evaluate(()=>setCfg({webDisplayMode:'source'}));
 assert.equal(await page.$eval('#subtitle',element=>element.innerHTML),'<strong>Research</strong> Articles');
 assert.deepEqual(errors,[],'no production script errors');
 console.log('PASS: webpage text regression and Bing subtitles, title exclusion, link preservation, result-only rendering and failure handling');
}finally{await browser.close();}
