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

// --- store-policy flags ----------------------------------------------------

const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
if (matches.includes("<all_urls>")) {
  warn(
    "content_scripts matches <all_urls>: captureVisibleTab() only needs activeTab, " +
      "and broad host access is the main reason Chrome Web Store reviews drag " +
      "(see docs/CHROME_WEB_STORE_TODO.md P0-2)",
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
