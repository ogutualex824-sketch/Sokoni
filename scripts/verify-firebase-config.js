#!/usr/bin/env node
/**
 * DRIFT GUARD — the Firebase config exists in two places by necessity:
 *   firebase.js            (SDK 10.12.2, loaded by the main app)
 *   sokoni-config.js       (window.SOKONI_FIREBASE_CONFIG, loaded by 11 POS/admin pages
 *                           which import SDK 11.0.1 and cannot share firebase.js's app object)
 *
 * They must never disagree. This fails the build if they do, and also catches any page that
 * reintroduces the `_sokoniConfig` / `__sokoniConfig` globals that never existed.
 *
 *   node scripts/verify-firebase-config.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let fail = 0;
const bad = (m) => { console.error('  FAIL  ' + m); fail++; };
const ok = (m) => console.log('  PASS  ' + m);

const KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

function extract(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let d = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) break; }
  }
  const body = src.slice(open, j + 1);
  const out = {};
  for (const k of KEYS) {
    const m = body.match(new RegExp(k + '\\s*:\\s*["\']([^"\']*)["\']'));
    if (m) out[k] = m[1];
  }
  return out;
}

const fbJs = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const cfgJs = fs.readFileSync(path.join(ROOT, 'sokoni-config.js'), 'utf8');

const modJs = fs.readFileSync(path.join(ROOT, 'sokoni-firebase-config.js'), 'utf8');

const a = extract(fbJs, 'const firebaseConfig');
const b = extract(cfgJs, 'window.SOKONI_FIREBASE_CONFIG');
const c = extract(modJs, 'export const firebaseConfig');

if (!c) bad('sokoni-firebase-config.js: could not locate exported firebaseConfig');
if (a && c) {
  for (const k of KEYS) {
    if (a[k] && c[k] && a[k] !== c[k]) {
      bad(`DRIFT on ${k}: firebase.js="${a[k]}" vs sokoni-firebase-config.js="${c[k]}"`);
    }
  }
}

if (!a) bad('firebase.js: could not locate firebaseConfig');
if (!b) bad('sokoni-config.js: could not locate SOKONI_FIREBASE_CONFIG');

if (a && b) {
  for (const k of KEYS) {
    if (!a[k]) { bad('firebase.js missing ' + k); continue; }
    if (!b[k]) { bad('sokoni-config.js missing ' + k); continue; }
    if (a[k] !== b[k]) bad(`DRIFT on ${k}: firebase.js="${a[k]}" vs sokoni-config.js="${b[k]}"`);
  }
  if (!fail) ok('firebase.js and sokoni-config.js agree on all ' + KEYS.length + ' Firebase keys');
}

/* No page may reintroduce the globals that never existed. */
const offenders = [];
for (const f of fs.readdirSync(ROOT)) {
  if (!f.endsWith('.html')) continue;
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/initializeApp\(\s*window\.__?sokoniConfig/.test(s)) offenders.push(f);
}
if (offenders.length) bad('pages still initialising from a non-existent global: ' + offenders.join(', '));
else ok('no page initialises Firebase from _sokoniConfig / __sokoniConfig');

/* Every page using the canonical config must actually load sokoni-config.js first.

   The path test used to be /src=["']sokoni-config\.js["']/ — bare filename only.
   It therefore reported enterprise-ops.html as broken for loading the script as
   src="/sokoni-config.js", which is a perfectly valid absolute reference and does
   work in the browser. That was a scanner blind spot, not a defect: the page loads
   the config at line 749 and first uses it at line 770.

   Accept the absolute and ./-relative forms, and — since the claim this check
   makes is that the config loads FIRST — actually verify the ordering against the
   first real `window.SOKONI_FIREBASE_CONFIG` dereference rather than any mention
   of the name (a comment referencing it must not trip the check). */
const CFG_TAG = /<script[^>]+src=["'](?:\.?\/)?sokoni-config\.js["']/i;

/* Comments must not count as a dereference. crm.html explains the load order in
   an HTML comment ABOVE its own <script> tag, so a naive search found
   "window.SOKONI_FIREBASE_CONFIG" at line 11, the tag at line 12, and wrongly
   called it out of order — the real use is at line 520. Blank the comment bodies
   while preserving length, so byte offsets stay comparable. */
const maskComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g,  m => ' '.repeat(m.length))
  .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));

const missing = [];
const outOfOrder = [];
for (const f of fs.readdirSync(ROOT)) {
  if (!f.endsWith('.html')) continue;
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (!s.includes('SOKONI_FIREBASE_CONFIG')) continue;
  const tag = s.match(CFG_TAG);
  if (!tag) { missing.push(f); continue; }
  const code = maskComments(s);
  const use  = code.search(/window\.SOKONI_FIREBASE_CONFIG/);
  if (use !== -1 && code.indexOf(tag[0]) > use) outOfOrder.push(f);
}
if (missing.length) bad('uses SOKONI_FIREBASE_CONFIG without loading sokoni-config.js: ' + missing.join(', '));
else ok('every page using the canonical config loads sokoni-config.js');
if (outOfOrder.length) bad('loads sokoni-config.js AFTER first use: ' + outOfOrder.join(', '));
else ok('sokoni-config.js is loaded before the config is dereferenced');

console.log(fail ? '\n  ' + fail + ' FAILURE(S)\n' : '\n  Firebase config is canonical and consistent.\n');
process.exit(fail ? 1 : 0);
