// Check screenshot identity without capturing any real user page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let captures = 0;
let active = false;
let activeId = 7;
let listener;
const scope = {
  importScripts() {}, console, setTimeout, clearTimeout,
  chrome: {
    runtime: {
      onMessage: { addListener(value) { listener = value; } },
      onConnect: { addListener() {} },
    },
    tabs: {
      get: async () => ({ id: 7, active, windowId: 3, url: "https://manga.example/" }),
      query: async () => [{ id: activeId, url: "https://manga.example/" }],
      captureVisibleTab: async () => { captures += 1; return "data:image/png;base64,AA=="; },
    },
  },
};
vm.createContext(scope);
vm.runInContext(readFileSync(new URL("../extension/background/service-worker.js", import.meta.url), "utf8"), scope);
await assert.rejects(vm.runInContext("captureVisibleImage(7)", scope), /标签页/);
assert.equal(captures, 0, "An inactive sender must never capture the active page");
active = true;
activeId = 8;
await assert.rejects(vm.runInContext("captureVisibleImage(7)", scope), /切换/);
let result;
listener({ type: "CAPTURE_CROP" }, { tab: { id: 7 }, frameId: 2 }, value => { result = value; });
assert.equal(result.ok, false);
assert.match(result.error, /iframe/);
console.log("Screenshot privacy checks passed: inactive tab, tab switch, iframe.");
