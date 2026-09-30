'use strict';
/* Home "nearby" location: after the buyer accepts, the browser's location prompt must STOP re-appearing
   (owner, 2026-10-01). Runs the REAL initNearbyLocation code from script.js in a sandbox across several visits
   that share one localStorage, and counts getCurrentPosition calls (each is a potential browser prompt).
     node scripts/test-home-location-once.js              (this tree)
     BASE=<rev> node scripts/test-home-location-once.js   (baseline; live 72dca56 must FAIL L-1/L-2/L-4) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const src = process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':script.js', { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
/* the location block: from the comment/consts before initNearbyLocation to the end of that function */
const startCands = [src.indexOf('const _SK_LOC_KEY'), src.indexOf('/* Request geolocation on load */'), src.indexOf('function initNearbyLocation')].filter((i) => i >= 0);
const start = Math.min(...startCands);
const fnAt = src.indexOf('function initNearbyLocation', start);
let depth = 0, end = -1;
for (let i = src.indexOf('{', fnAt); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
const block = src.slice(start, end);

let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const flush = () => new Promise((r) => setTimeout(r, 0));

/* one "visit" = a fresh page context sharing the SAME localStorage (the browser keeps it across visits) */
async function visits(n, perm, userAccepts) {
  const store = {}; let prompts = 0;
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  for (let v = 0; v < n; v++) {
    const geolocation = { getCurrentPosition: (ok, err) => { prompts++; userAccepts ? ok({ coords: { latitude: -1.286, longitude: 36.817 } }) : err({ code: 1 }); } };
    const navigator = { geolocation };
    if (perm !== 'none') navigator.permissions = { query: () => Promise.resolve({ state: perm }) };
    const ctx = { navigator, localStorage, console: { log() {}, warn() {} }, JSON, Date, isFinite, Promise, setTimeout,
      products: [{ location: 'nairobi' }], buyerLocation: null, buyerCity: null,
      detectBuyerCity: () => ({ city: 'nairobi', distKm: 1 }), displayNearbySection() {}, displayProducts() {} };
    vm.createContext(ctx);
    vm.runInContext(block.replace(/^\s*const /gm, 'var ') + '\n;initNearbyLocation();', ctx);
    await flush(); await flush();
  }
  return { prompts, store };
}

(async () => {
  console.log('\nHome location asked once   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  let r = await visits(5, 'prompt', true);
  ck('L-1', r.prompts === 1, 'per-visit browsers (permission "prompt"): accepted once → asked ONCE across 5 visits', r.prompts);
  r = await visits(5, 'none', true);
  ck('L-2', r.prompts === 1, 'older Safari (no Permissions API): accepted once → asked ONCE across 5 visits', r.prompts);
  r = await visits(3, 'granted', true);
  ck('L-3', r.prompts === 3, 'permission "granted": silent refresh each visit (no prompt is shown in this state)', r.prompts);
  r = await visits(5, 'prompt', false);
  ck('L-4', r.prompts <= 1, 'refused once → never asked again automatically', r.prompts);
  r = await visits(3, 'denied', false);
  ck('L-5', r.prompts === 0, 'permission "denied" → never asked', r.prompts);
  r = await visits(1, 'prompt', true);
  ck('L-6', !!r.store.sokoniBuyerCity, 'the accepted location still sets the buyer city (nearby sellers keep working)', r.store);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
