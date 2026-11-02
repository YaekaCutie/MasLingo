// Real DOM/canvas tests with deterministic Chrome API responses, no extension install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const scripts = ["overlay.js", "auto.js", "content.js"].map(name =>
  readFileSync(new URL(`../extension/content/${name}`, import.meta.url), "utf8"));
scripts.unshift(readFileSync(new URL("../extension/translation/providers.js", import.meta.url), "utf8"));
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  async function fixture(height = 700, autoStart = true) {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.setViewport({ width: 900, height: 900 });
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>MasLingo auto regression</title><body><h1>Automatic manga translation</h1></body>');
    for (const name of ["glass", "window", "status", "marker", "page"]) {
      await page.addStyleTag({content:readFileSync(new URL(`../extension/content/styles/${name}.css`, import.meta.url),"utf8")});
    }
    await page.evaluate(height => {
      globalThis.calls = { ocr: 0, translation: 0, pixels: 0, sizes: [] };
      globalThis.hold = false; globalThis.failOcr = false; globalThis.unsafeRepair = false;
      globalThis.MAS_panel = { mount: async () => {}, status() {} };
      globalThis.chrome = {
        runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
          if (message.type === "AUTO_OCR") {
            calls.ocr += 1;
            const bitmap = await createImageBitmap(await (await fetch(message.image)).blob());
            calls.sizes.push([bitmap.width,bitmap.height]); bitmap.close();
            if (hold) await new Promise(resolve => { globalThis.releaseOcr = resolve; });
            if (failOcr) return { ok: false, error: "OCR fixture failure" };
            const repair = document.createElement("canvas"); repair.width = 114; repair.height = 174;
            const ctx = repair.getContext("2d"); ctx.fillStyle = "#202020"; ctx.fillRect(37,42,12,80);
            return { ok: true, items: [{ text: "こんにちは", confidence:0.99, direction: "vertical",
              bbox: { left:120, top:140, right:210, bottom:290 }, erase: {image:unsafeRepair ? null : repair.toDataURL(),
                safe:!unsafeRepair, rect:{left:108,top:128,width:114,height:174},luminance:32} }] };
          }
          if (message.type === "AUTO_TRANSLATE") {
            calls.translation += 1;
            return {ok:true,mode:"free-translate",items:message.texts.map(() => ({translated:"你好"}))};
          }
          return {ok:false};
        } },
        storage: {local:{get:async () => ({autoTranslate:false})},onChanged:{addListener(){}}},
      };
      globalThis.sample = (variant = 0) => {
        const surface = document.createElement("canvas"); surface.width = 500; surface.height = height;
        const ctx = surface.getContext("2d"); ctx.fillStyle = variant ? "#303030" : "#202020";
        ctx.fillRect(0,0,500,height); ctx.fillStyle = "white"; ctx.fillRect(145,170,12,80);
        return surface.toDataURL();
      };
      const image = document.createElement("img"); image.id = "manga"; image.width = 500; image.height = height;
      image.src = sample(); document.body.append(image);
    }, height);
    for (const content of scripts) await page.addScriptTag({content});
    await page.evaluate(autoStart => {
      const draw = MAS_render.drawTranslatedPatch;
      MAS_render.drawTranslatedPatch = (entry,text) => { if(entry.erase) calls.pixels += 1; draw(entry,text); };
      if (autoStart) return MAS_auto.start();
    }, autoStart);
    return page;
  }

  const pendingStart = await fixture(700,false);
  await pendingStart.evaluate(() => {
    chrome.storage.local.get = async () => new Promise(resolve => {globalThis.releaseSettings=resolve;});
    globalThis.pendingStartRequest=MAS_auto.start();
  });
  await pendingStart.waitForFunction(() => typeof releaseSettings === "function");
  await pendingStart.evaluate(() => {MAS_auto.stop();releaseSettings({autoConcurrency:1});return pendingStartRequest;});
  assert.equal(await pendingStart.evaluate(() => MAS_auto.enabled),false,"Stop cancels startup while settings are loading");
  assert.equal(await pendingStart.evaluate(() => calls.ocr),0,"A cancelled startup must not send OCR");
  await pendingStart.evaluate(() => {
    globalThis.settingsReads=[];
    chrome.storage.local.get = async () => new Promise(resolve => settingsReads.push(resolve));
    globalThis.olderSync=MAS_auto.sync();globalThis.newerSync=MAS_auto.sync();
  });
  await pendingStart.evaluate(async () => {
    settingsReads[1]({autoTranslate:false});await newerSync;
    settingsReads[0]({autoTranslate:true});await olderSync;
  });
  assert.equal(await pendingStart.evaluate(() => MAS_auto.enabled),false,"A stale settings read cannot reopen auto mode");
  assert.equal(await pendingStart.evaluate(() => calls.ocr),0);
  await pendingStart.close();

  const manual = await fixture(700, false);
  await manual.evaluate(() => { hold = true; return MAS_auto.translateImage(document.getElementById("manga")); });
  await manual.waitForFunction(() => typeof releaseOcr === "function");
  const duplicate = await manual.evaluate(() => MAS_auto.translateImage(document.getElementById("manga")));
  assert.equal(duplicate.alreadyRunning, true, "Repeated clicks do not duplicate an active image request");
  await manual.evaluate(() => { MAS_auto.stop(); releaseOcr(); });
  await manual.waitForFunction(() => calls.pixels === 1);
  assert.equal(await manual.evaluate(() => MAS_auto.enabled), false, "One image never enables page-wide discovery");
  assert.equal(await manual.evaluate(() => calls.ocr), 1);
  await manual.evaluate(() => { hold = false; return MAS_auto.translateImage(document.getElementById("manga")); });
  await manual.waitForFunction(() => calls.pixels === 2);
  assert.equal(await manual.evaluate(() => document.querySelectorAll("canvas.maslingo-result").length), 1,
    "Explicit retry replaces the previous overlay");
  await manual.close();

  const painted = await fixture();
  await painted.waitForFunction(() => calls.pixels === 1);
  const opaqueRatio = await painted.evaluate(() => {
    const c = document.querySelector("canvas.maslingo-result");
    const d = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
    let n=0; for(let i=3;i<d.length;i+=4) if(d[i]) n++;
    return n/(d.length/4);
  });
  assert.ok(opaqueRatio < 0.5, `Repair must preserve artwork: ${opaqueRatio}`);
  await painted.evaluate(() => {document.getElementById("manga").src = sample(1);});
  await painted.waitForFunction(() => calls.pixels === 2 && calls.ocr === 2);
  assert.equal(await painted.evaluate(() => document.querySelectorAll("canvas.maslingo-result").length),1);
  if(process.env.MAS_REVIEW_SCREENSHOT) await painted.screenshot({path:process.env.MAS_REVIEW_SCREENSHOT});
  await painted.close();

  const stopped = await fixture();
  await stopped.waitForFunction(() => calls.pixels === 1);
  await stopped.evaluate(() => {hold=true; document.getElementById("manga").src=sample(1);});
  await stopped.waitForFunction(() => typeof releaseOcr === "function");
  await stopped.evaluate(() => {MAS_auto.stop(); releaseOcr();});
  await stopped.waitForFunction(() => MAS_auto.stats().running === 0);
  assert.equal(await stopped.evaluate(() => calls.translation),1,"Stop prevents follow-up translation");
  await stopped.close();

  const failed = await fixture();
  await failed.waitForFunction(() => calls.pixels === 1);
  await failed.evaluate(() => {failOcr=true; document.getElementById("manga").src=sample(1);});
  await failed.waitForFunction(() => MAS_auto.stats().imageFailures.ocr === 1);
  await new Promise(resolve => setTimeout(resolve,1400));
  assert.equal(await failed.evaluate(() => calls.ocr),3,"One image gets exactly two failed attempts");
  await failed.close();

  const long = await fixture(4200);
  await long.waitForFunction(() => MAS_auto.stats().running === 0 && calls.pixels >= 3);
  const sizes = await long.evaluate(() => calls.sizes);
  assert.equal(sizes.length,3);
  assert.ok(sizes.every(([w,h]) => w===500 && h<=1600), JSON.stringify(sizes));
  await long.close();

  const preserved = await fixture();
  await preserved.waitForFunction(() => calls.pixels === 1);
  await preserved.evaluate(() => {unsafeRepair=true; document.getElementById("manga").src=sample(1);});
  await preserved.waitForSelector(".maslingo-adjacent-translation");
  assert.equal(await preserved.evaluate(() => document.querySelectorAll("canvas.maslingo-result").length),0,
    "Uncertain repair must leave the source image without an erasing canvas");
  assert.equal(await preserved.evaluate(() => document.querySelector(".maslingo-adjacent-translation").shadowRoot.querySelector(".text").textContent),"你好");
  await preserved.evaluate(() => {
    const img=document.getElementById("manga"),box=MAS_overlay.documentRect(img);
    const card=MAS_overlay.documentRect(document.querySelector(".maslingo-adjacent-translation"));
    const obstacle=document.createElement("canvas");obstacle.className="maslingo-result caption-obstacle";
    globalThis.captionObstacle=MAS_overlay.anchor(obstacle,img,{left:(card.left-box.left)/box.width,
      top:(card.top-box.top)/box.height,width:card.width/box.width,height:card.height/box.height});
    MAS_overlay.reposition();
  });
  await preserved.waitForFunction(() => {
    const card=document.querySelector(".maslingo-adjacent-translation").getBoundingClientRect();
    const obstacle=document.querySelector(".caption-obstacle").getBoundingClientRect();
    return card.right<=obstacle.left || card.left>=obstacle.right || card.bottom<=obstacle.top || card.top>=obstacle.bottom;
  });
  assert.ok(await preserved.evaluate(() =>
    Number(getComputedStyle(document.querySelector(".maslingo-adjacent-translation")).zIndex) >
    Number(getComputedStyle(document.querySelector(".caption-obstacle")).zIndex)),
    "Caption controls must remain above neighbouring translation canvases");
  await preserved.evaluate(() => {MAS_overlay.release(captionObstacle);MAS_overlay.reposition();});
  await preserved.evaluate(() => new Promise(requestAnimationFrame));
  const beforeScroll = await preserved.$eval(".maslingo-adjacent-translation",node=>node.getBoundingClientRect().top+scrollY);
  await preserved.evaluate(() => {document.body.style.paddingBottom="1500px";scrollTo(0,200);MAS_overlay.reposition();});
  await preserved.waitForFunction(() => !document.querySelector(".maslingo-box"));
  const afterScroll = await preserved.$eval(".maslingo-adjacent-translation",node=>node.getBoundingClientRect().top+scrollY);
  assert.ok(Math.abs(beforeScroll-afterScroll)<1,"Caption follows its source in document coordinates");
  const captionButton = (await preserved.evaluateHandle(() =>
    document.querySelector(".maslingo-adjacent-translation").shadowRoot.querySelector(".collapse"))).asElement();
  await captionButton.click();
  assert.equal(await preserved.$eval(".maslingo-adjacent-translation",node=>node.dataset.collapsed),"true");
  await captionButton.click();
  assert.equal(await preserved.$eval(".maslingo-adjacent-translation",node=>node.dataset.collapsed),"false");
  assert.ok(await preserved.evaluate(() => {
    const card=document.querySelector(".maslingo-adjacent-translation"),pin=document.querySelector(".maslingo-caption-source");
    return card.dataset.sourceId===pin.dataset.sourceId && card.shadowRoot.querySelector(".source").title.includes("こんにちは");
  }),"Caption and source marker share an id and expose the source text");
  const dragHandle=(await preserved.evaluateHandle(()=>
    document.querySelector(".maslingo-adjacent-translation").shadowRoot.querySelector(".handle"))).asElement();
  const dragStart=await preserved.$eval(".maslingo-adjacent-translation",node=>({left:node.getBoundingClientRect().left,top:node.getBoundingClientRect().top}));
  await preserved.evaluate(()=>{globalThis.readerPointerUps=0;document.body.addEventListener("pointerup",()=>readerPointerUps++);});
  const handleBox=await dragHandle.boundingBox();
  await preserved.mouse.move(handleBox.x+5,handleBox.y+5);await preserved.mouse.down();
  await preserved.mouse.move(handleBox.x+45,handleBox.y+35,{steps:8});await preserved.mouse.up();
  const dragged=await preserved.$eval(".maslingo-adjacent-translation",node=>({left:node.getBoundingClientRect().left,top:node.getBoundingClientRect().top,moved:node.dataset.moved}));
  assert.equal(dragged.moved,"true");
  assert.ok(Math.abs(dragged.left-dragStart.left-40)<2 && Math.abs(dragged.top-dragStart.top-30)<2,
    "Pointer dragging moves the translation without snapping back to auto placement");
  assert.equal(await preserved.evaluate(()=>readerPointerUps),0,"Dragging a caption must not trigger the reader's page-turn handler");
  await preserved.evaluate(()=>MAS_overlay.reposition());await preserved.evaluate(()=>new Promise(requestAnimationFrame));
  assert.ok(await preserved.evaluate(()=>Number(document.querySelector(".maslingo-caption-source").shadowRoot.querySelector("svg").style.opacity)>0),
    "A moved caption shows a connector to its numbered source");
  const movedTop=await preserved.$eval(".maslingo-adjacent-translation",node=>node.getBoundingClientRect().top+scrollY);
  await preserved.evaluate(()=>{scrollBy(0,40);MAS_overlay.reposition();});
  await preserved.evaluate(()=>new Promise(requestAnimationFrame));
  assert.ok(Math.abs(movedTop-await preserved.$eval(".maslingo-adjacent-translation",node=>node.getBoundingClientRect().top+scrollY))<1,
    "The dragged position follows the image during scrolling");
  await dragHandle.focus();await preserved.keyboard.press("Home");
  assert.equal(await preserved.$eval(".maslingo-adjacent-translation",node=>node.dataset.moved),undefined);
  const sourceButton=(await preserved.evaluateHandle(()=>
    document.querySelector(".maslingo-adjacent-translation").shadowRoot.querySelector(".source"))).asElement();
  await sourceButton.click();
  assert.equal(await preserved.$eval(".maslingo-caption-source",node=>node.dataset.active),"true");
  await dragHandle.dispose();await sourceButton.dispose();
  await preserved.evaluate(() => {const img=document.getElementById("manga");img.style.maxWidth="100%";img.style.height="auto";scrollTo(0,0);});
  await preserved.setViewport({width:390,height:844});
  await preserved.evaluate(() => MAS_overlay.reposition());
  await preserved.waitForFunction(() => {
    const card=document.querySelector(".maslingo-adjacent-translation").getBoundingClientRect();
    return card.left>=7 && card.right<=innerWidth-7;
  });
  const overlap = await preserved.evaluate(() => {
    const card=document.querySelector(".maslingo-adjacent-translation").getBoundingClientRect();
    const img=document.getElementById("manga").getBoundingClientRect();
    const source={left:img.left+img.width*120/500,right:img.left+img.width*210/500,
      top:img.top+img.height*140/700,bottom:img.top+img.height*290/700};
    return Math.max(0,Math.min(card.right,source.right)-Math.max(card.left,source.left))*
      Math.max(0,Math.min(card.bottom,source.bottom)-Math.max(card.top,source.top));
  });
  assert.equal(overlap,0,"Narrow layout keeps the caption clear of the original text");
  await captionButton.dispose();
  await preserved.evaluate(() => {unsafeRepair=false;document.getElementById("manga").src=sample();});
  await preserved.waitForFunction(() => !document.querySelector(".maslingo-adjacent-translation") && calls.pixels===2);
  assert.equal(await preserved.evaluate(()=>document.querySelectorAll(".maslingo-caption-source").length),0,
    "Changing images removes the numbered source marker and connector");
  await preserved.close();
  assert.deepEqual(errors,[]);
  console.log("Auto lifecycle passed: cancelled startup, stale settings, repair pixels, src swap, stop, retries, long bands, preserve-artwork captions, scrolling, collapse, console.");
} finally {
  await browser.close();
}
