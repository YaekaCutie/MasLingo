#!/usr/bin/env node
// Static checks on the extension package.
//
// The extension cannot be exercised on a machine without Chrome, and a broken
// path is the failure mode that takes the whole product down rather than
// degrading it: config.js is loaded by importScripts() in the service worker
// and by <script src> in the popup and options pages, so one wrong relative
// path leaves every backend lookup undefined.
//
// This resolves those references the way Chrome would, parses every script,
// and flags the things the Chrome Web Store treats as policy problems.
//
// Usage:
//   node deploy/check-extension.mjs
//   node deploy/check-extension.mjs --key extension.pem   # also print the ID

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");

const failures = [];
const warnings = [];
const notes = [];

const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);
const note = (message) => notes.push(message);

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function relative(full) {
  return full.slice(root.length + 1).split("\\").join("/");
}

// --- manifest -------------------------------------------------------------

const manifestPath = join(extensionDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("no extension/manifest.json");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, got ${manifest.manifest_version}`);

// Store limits: name <= 75 chars, description <= 132 chars.
if (!manifest.name) fail("manifest.name is missing");
else if (manifest.name.length > 75) fail(`manifest.name is ${manifest.name.length} chars (limit 75)`);
if (!manifest.description) fail("manifest.description is missing");
else if (manifest.description.length > 132) fail(`manifest.description is ${manifest.description.length} chars (limit 132)`);

const version = String(manifest.version ?? "");
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  fail(`manifest.version "${version}" must be 1-4 dot-separated integers`);
} else if (version.split(".").some((part) => Number(part) > 65535)) {
  fail(`manifest.version "${version}" has a component above 65535`);
}
if (version.split(".").every((part) => Number(part) === 0)) fail("manifest.version may not be all zero");

// --- every file the manifest points at must exist -------------------------

const referenced = [];
const requireFile = (path, label) => {
  if (!path || typeof path !== "string") return;
  referenced.push(path);
  if (!existsSync(join(extensionDir, path))) fail(`${label} points at a missing file: ${path}`);
};

requireFile(manifest.background?.service_worker, "background.service_worker");
requireFile(manifest.action?.default_popup, "action.default_popup");
requireFile(manifest.options_page, "options_page");
for (const [size, path] of Object.entries(manifest.icons ?? {})) requireFile(path, `icons.${size}`);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) requireFile(file, "content_scripts.js");
  for (const file of script.css ?? []) requireFile(file, "content_scripts.css");
}
for (const path of manifest.web_accessible_resources?.flatMap((entry) => entry.resources ?? []) ?? []) {
  if (!path.includes("*")) requireFile(path, "web_accessible_resources");
}

// --- html <script src> / <link href> must resolve --------------------------

const htmlFiles = walk(extensionDir).filter((file) => file.endsWith(".html"));
for (const file of htmlFiles) {
  const source = readFileSync(file, "utf8");
  const pattern = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const [, target] of source.matchAll(pattern)) {
    if (/^(https?:|data:|#|\/\/)/i.test(target)) continue;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      fail(`${relative(file)} references a missing file: ${target}`);
    } else {
      referenced.push(relative(resolved).replace(/^extension\//, ""));
    }
  }
}

// --- js files must parse, and importScripts() must resolve -----------------

const jsFiles = walk(extensionDir).filter((file) => file.endsWith(".js"));
for (const file of jsFiles) {
  const source = readFileSync(file, "utf8");
  try {
    new vm.Script(source, { filename: file });
  } catch (error) {
    fail(`${relative(file)} does not parse: ${error.message}`);
    continue;
  }
  const pattern = /importScripts\(\s*["']([^"']+)["']\s*\)/g;
  for (const [, target] of source.matchAll(pattern)) {
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      fail(`${relative(file)} importScripts() a missing file: ${target}`);
    } else {
      referenced.push(relative(resolved).replace(/^extension\//, ""));
      note(`${relative(file)} imports ${relative(resolved)}`);
    }
  }
}

// --- programmatic injection lists must resolve -----------------------------
//
// manifest content_scripts are resolved above, but chrome.scripting.injections
// are strings inside the code and nothing checked them. That is exactly how
// popup.js came to inject a list missing panel.js: the repair path for a page
// that was already open silently produced a page with auto translate and no
// panel, and no test noticed because every browser check loads its page *after*
// the extension, so the repair path never runs.

const injectedByFile = new Map();
// Bounded non-greedy rather than `[^}]*`: the options object nests
// `target: { tabId }`, so a character class that excludes `}` stops before it
// ever reaches `files:` — the first version of this check matched nothing at all
// and passed everything.
const injectionPattern =
  /(?:executeScript|insertCSS)\(\s*\{[\s\S]{0,400}?files:\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/g;
for (const file of jsFiles) {
  const source = readFileSync(file, "utf8");
  // `files:` is often a named constant rather than an inline array — popup.js
  // keeps its list in CONTENT_SCRIPTS. Resolving that is the whole point: a
  // checker that only reads inline arrays silently skips the real call.
  const constants = new Map();
  for (const [, name, list] of source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[^\]]*\])\s*;/g,
  )) {
    constants.set(name, [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
  }

  const names = [];
  for (const [, token] of source.matchAll(injectionPattern)) {
    const list = token.startsWith("[")
      ? [...token.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
      : (constants.get(token) || []);
    if (!list.length) {
      fail(`${relative(file)} injects files from "${token}" which could not be resolved `
        + "to a list of paths");
      continue;
    }
    for (const name of list) {
      const target = join(extensionDir, name);
      if (!existsSync(target)) {
        fail(`${relative(file)} injects a missing file: ${name}`);
      } else {
        referenced.push(name);
      }
    }
    names.push(...list);
  }
  if (names.length) injectedByFile.set(relative(file), names);
}

// The repair injection has to match what the manifest declares, or a repaired
// page behaves differently from a freshly loaded one.
const declaredScripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
for (const [file, names] of injectedByFile) {
  const scripts = names.filter((name) => name.endsWith(".js"));
  if (!scripts.length) continue;
  const missing = declaredScripts.filter((name) => !scripts.includes(name));
  if (missing.length) {
    fail(`${file} injects ${scripts.length} scripts but the manifest declares `
      + `${declaredScripts.length}; missing: ${missing.join(", ")}`);
  } else {
    note(`${file} injects the full content-script set`);
  }
}

// --- store-policy flags ----------------------------------------------------

const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
if (matches.includes("<all_urls>")) {
  warn(
    "content_scripts matches <all_urls>: the extension already holds a broad host permission, " +
      "which it needs because captureVisibleTab requires <all_urls> or activeTab and relying on " +
      "the activeTab gesture alone left the user unable to capture anything. With the host " +
      "permission granting screenshots, this static content script is now redundant and could be " +
      "dropped in favour of injecting on demand (see docs/CHROME_WEB_STORE_TODO.md P0-2)",
  );
}
const hostedHosts = (manifest.host_permissions ?? []).filter(
  (host) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(host),
);
// Only a wildcard in the HOST is a problem: "https://ocr.example.com/*" ends in
// "/*" like every other entry and must not be reported as a wildcard host.
const wildcardHosts = hostedHosts.filter((host) =>
  host.replace(/^https?:\/\//, "").split("/")[0].includes("*"),
);
if (wildcardHosts.length) {
  warn(
    `wildcard host permission still present: ${wildcardHosts.join(", ")} — ` +
      "replace it with the real hosted domain before submitting (P0-7)",
  );
}
if (!referenced.some((path) => (manifest.icons && Object.values(manifest.icons).includes(path)))) {
  warn(
    "no icons are declared in the manifest — the Chrome Web Store requires a " +
      "128x128 icon (see docs/CHROME_WEB_STORE_TODO.md P0-1)",
  );
}

// --- optional: derive the extension id from a signing key ------------------

const keyIndex = process.argv.indexOf("--key");
let extensionId = null;
if (keyIndex !== -1) {
  const keyPath = process.argv[keyIndex + 1];
  if (!keyPath || !existsSync(keyPath)) {
    fail(`--key was given but ${keyPath} does not exist`);
  } else {
    const der = createPublicKey(readFileSync(keyPath, "utf8")).export({ type: "spki", format: "der" });
    extensionId = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
      .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
      .join("");
    note(`extension id (${keyPath}): ${extensionId}`);
  }
}

// --- calls to functions that do not exist ---------------------------------
//
// These files load as classic scripts, so a call to a function that was renamed
// or deleted fails only at run time, and only on the branch that reaches it.
// That is exactly how a stale showTranslationNotice() call survived a rename and
// broke the port-disconnect path with nothing noticing: parsing a file says
// nothing about whether the names inside it resolve.
const BROWSER_GLOBALS = new Set([
  "chrome", "window", "document", "console", "fetch", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "alert", "confirm", "prompt", "Image", "Blob", "FileReader", "FormData", "URL",
  "URLSearchParams", "TextEncoder", "TextDecoder", "atob", "btoa", "crypto",
  "structuredClone", "OffscreenCanvas", "createImageBitmap", "queueMicrotask",
  "getComputedStyle", "matchMedia", "performance", "navigator", "location",
  "history", "self", "globalThis", "Object", "Array", "String", "Number",
  "Boolean", "BigInt", "Math", "JSON", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Uint8Array",
  "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
  "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "importScripts", "Worker",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "AbortController",
]);
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "new",
  "await", "else", "do", "delete", "void", "in", "of", "case", "yield", "throw",
  "instanceof", "super", "this", "async", "get", "set",
]);

/** Strip comments and string bodies so prose is not read as code. */
function stripLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''");
}

const addNames = (set, list) => {
  for (const part of list.split(",")) {
    const name = part.trim().replace(/^[.\s]*/, "").replace(/[{}[\].\s]/g, "").split(/[=:]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
  }
};

for (const file of jsFiles) {
  const stripped = stripLiterals(readFileSync(file, "utf8"));
  const declared = new Set();
  for (const match of stripped.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of stripped.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of stripped.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of stripped.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) addNames(declared, match[1]);
  for (const match of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) addNames(declared, match[1]);
  for (const match of stripped.matchAll(/(?:^|[\s(,[])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1]);
  // Object-literal method shorthand (`hosts() { … }`) looks like a call to a
  // regex, so those names are treated as definitions.
  for (const match of stripped.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) {
    declared.add(match[2]);
  }

  const unknown = new Set();
  for (const match of stripped.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[2];
    if (declared.has(name) || BROWSER_GLOBALS.has(name) || KEYWORDS.has(name)) continue;
    unknown.add(name);
  }
  if (unknown.size > 0) {
    fail(`${relative(file)} calls ${[...unknown].sort().join(", ")} — not defined in the file`);
  }
}

// --- report ---------------------------------------------------------------

console.log(`checked ${jsFiles.length} scripts, ${htmlFiles.length} pages, ${referenced.length} references`);
for (const message of notes) console.log(`  note    ${message}`);
for (const message of warnings) console.log(`  warning ${message}`);
for (const message of failures) console.log(`  FAIL    ${message}`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s) found`);
  process.exit(1);
}
console.log(`\nextension package OK (${warnings.length} warning(s))`);
