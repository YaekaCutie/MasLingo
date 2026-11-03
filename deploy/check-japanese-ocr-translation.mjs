// Exercise actual service-worker message handlers without a browser or API key.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = {translationProvider:"custom", translationMode:"openai-compatible",
  translationEndpoint:"https://translator.example/v1/chat/completions", translationModel:"fixture",
  targetLanguage:"简体中文"};
const requests = [];
const requestDetails=[];
let handler, onConnect;
const scope = {URL, URLSearchParams, TextEncoder, crypto, AbortController, setTimeout, clearTimeout, console,
  chrome:{tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}},runtime:{onMessage:{addListener(fn){handler=fn;}},onConnect:{addListener(fn){onConnect=fn;}}},
    storage:{local:{get:async()=>({...cfg})}}},
  fetch:async (_url, init) => {
    const body=JSON.parse(init.body);const content=body.messages[0].content;
    const texts=JSON.parse(content.slice(content.lastIndexOf("输入：")+3).trim());
    requests.push(texts);requestDetails.push({url:_url,prompt:content});
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify(texts.map(t=>`译:${t}`))}}]})};
  }};
vm.createContext(scope);
scope.importScripts=(...names)=>{for(const name of names)vm.runInContext(fs.readFileSync(path.resolve(root,"extension/background",name),"utf8"),scope);};
vm.runInContext(fs.readFileSync(path.join(root,"extension/background/service-worker.js"),"utf8"),scope);
const send = message => new Promise(resolve=>handler(message,{tab:{id:1},frameId:0},resolve));

const manga=await send({type:"AUTO_TRANSLATE",texts:["用事","若様","おはよう"]});
assert.equal(manga.ok,true);
assert.deepEqual(Array.from(manga.items,item=>item.skipped),[false,false,false]);
assert.equal(manga.items[0].translated,"译:用事");
assert.deepEqual(Array.from(requests[0]),["用事","若様","おはよう"]);
const before=requests.length;
const chinese=await send({type:"TRANSLATE_TEXT_BLOCKS",texts:["这是中文内容，无需再翻译。"],source:"自动识别",target:"简体中文"});
assert.equal(chinese.skipped[0],true);
assert.equal(requests.length,before);
const explicit=await send({type:"TRANSLATE_TEXT_BLOCKS",texts:["用事"],source:"日本語",target:"简体中文"});
assert.equal(explicit.skipped[0],false);
assert.equal(explicit.translations[0],"译:用事");
const same=await send({type:"TRANSLATE_TEXT_BLOCKS",texts:["用事"],source:"日本語",target:"日本語"});
assert.equal(same.skipped[0],true);

let portListener;let resolvePort;
const manualResult=new Promise(resolve=>{resolvePort=resolve;});
onConnect({name:"manga-recognition",sender:{tab:{id:1}},onMessage:{addListener(fn){portListener=fn;}},
  postMessage:resolvePort,disconnect(){}});
portListener({type:"TRANSLATE_TEXTS",texts:["用事"],requestId:"manual"});
const manual=await manualResult;
assert.equal(manual.result.items[0].skipped,false);
assert.equal(manual.result.items[0].translated,"译:用事");
const quick=await send({type:'TRANSLATE_TEXT_BLOCKS',texts:['用事'],source:'日本語',target:'English',provider:'openai'});
assert.equal(quick.ok,true);
assert.ok(requestDetails.at(-1).url.startsWith('https://api.openai.com/'),'provider override uses the registered endpoint');
assert.ok(requestDetails.at(-1).prompt.includes('English'),'target override reaches the real adapter prompt');
assert.equal(cfg.translationProvider,'custom','context change leaves saved defaults intact');
console.log("Japanese OCR translation passed: kanji-only manga/manual text, explicit source, same-language web text.");
