#!/usr/bin/env node
/**
 * MERCHANT AVAILABILITY — the schedule SAVES THROUGH THE SERVER, never from the browser.
 *
 *   node scripts/test-merchant-availability-server-save.js
 *   node scripts/test-merchant-availability-server-save.js --control=reinsert-setdoc   (must FAIL row 1)
 *
 * Owner rule: availability is SERVER-AUTHORITATIVE. 6775b09 (2026-08-31) built the Merchant V2
 * schedule editor with a browser setDoc on providerAvailability/{uid} (+ an updateDoc on
 * shops/{uid}). The save now goes to kasshop.setShopAvailability (sokoni-2f,
 * convergence/commercial-fn-on-ef1e992) with { schedule: { hours, overrides } } (+ shopId for an
 * employee), and there is NO client-write fallback.
 *
 * Rows
 *   1 · STATIC (token-aware, scripts/lib/js-tokens.js): no merchant file holds a browser WRITE to
 *       providerAvailability — direct call, member chain, or a ref held in a variable. Comments and
 *       strings that merely mention the collection are not code and are not counted.
 *   2 · detector controls — a re-inserted setDoc / compat .set() / ref-variable write IS caught, and
 *       the READ that remains is not flagged (positive control that the scan saw the token at all).
 *   3 · VM: the real avPreflight / avPayload / avSaveError / avSave sliced out of merchant-v2.html —
 *       exact callable name and payload shape; "Saved" only after the call RESOLVES with success;
 *       every failure (not-found, internal, offline, the pre-schedule live build, a refusal) shows an
 *       honest message, leaves the form unsaved and touches Firestore NOT AT ALL.
 *   4 · contract cross-check against the 2f callable source (git object; UNPROVEN if absent).
 *   5 · the DEPLOY PRECONDITION text is present in the CHANGELOG entry and the merchant doc, so it
 *       cannot be dropped during hosting assembly.
 *
 * Exit: 0 all pass · 1 any fail · (unproven rows are reported, never counted as pass).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { tokenize, extractInlineScripts } = require('./lib/js-tokens.js');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const CONTROL = (process.argv.find((a) => a.startsWith('--control=')) || '').slice('--control='.length);
const COLL = 'providerAvailability';
const PRECONDITION = 'requires functions: setShopAvailability live (verify with a functions list before the hosting deploy)';
const FN_BRANCH = 'origin/convergence/commercial-fn-on-ef1e992';

let pass = 0, fail = 0, unproven = 0;
const head = (t) => console.log(NL + t);
function ck(name, ok, why) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (why ? NL + '       ' + why : '')); }
}
function unp(name, why) { unproven++; console.log('  UNPROVEN ' + name + (why ? ' — ' + why : '')); }

/* ── the detector ─────────────────────────────────────────────────────────── */
const WRITE = new Set(['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'set', 'update', 'add', 'delete', 'create']);
const isP = (t, v) => t && t.type === 'punct' && t.value === v;
const isCollStr = (t) => t && (t.type === 'string' || (t.type === 'template' && t.noSub)) &&
  (t.value === COLL || t.value.startsWith(COLL + '/'));

/** JS source → [{ line, how }] for every WRITE whose target is the providerAvailability collection. Throws if unlexable. */
function findWrites(code) {
  const t = tokenize(code);
  const match = new Array(t.length).fill(-1), encl = new Array(t.length).fill(-1);
  const st = [];
  for (let i = 0; i < t.length; i++) {
    encl[i] = st.length ? st[st.length - 1] : -1;
    if (t[i].type !== 'punct') continue;
    const v = t[i].value;
    if (v === '(' || v === '[' || v === '{') st.push(i);
    else if (v === ')' || v === ']' || v === '}') { const o = st.pop(); if (o !== undefined) { match[o] = i; match[i] = o; } }
  }
  const hits = [], refVars = new Set();
  /* forward along a member chain from the token after a closing paren: .doc(x).set( … */
  function chainWrites(p) {
    while (isP(t[p], '.') && t[p + 1] && t[p + 1].type === 'name') {
      const nm = t[p + 1].value;
      if (!isP(t[p + 2], '(')) { p += 2; continue; }
      if (WRITE.has(nm)) return nm;
      p = match[p + 2] + 1;
    }
    return null;
  }
  function statementTarget(i) {
    /* walk back to the start of the expression; return a variable it is assigned to */
    let k = i - 1;
    while (k >= 0) {
      const x = t[k];
      if (x.type === 'punct' && (x.value === ')' || x.value === ']' || x.value === '}') && match[k] > -1 && match[k] < k) { k = match[k] - 1; continue; }
      if (x.type === 'punct' && (x.value === '(' || x.value === '[')) { k--; continue; }
      if (x.type === 'punct' && (x.value === '{' || x.value === ';' || x.value === ',' || x.value === '}')) break;
      if (x.type === 'punct' && x.value === '=' && t[k - 1] && t[k - 1].type === 'name') return t[k - 1].value;
      k--;
    }
    return null;
  }
  for (let i = 0; i < t.length; i++) {
    if (!isCollStr(t[i])) continue;
    let k = i, flagged = null, top = i;
    for (let depth = 0; depth < 6 && !flagged; depth++) {
      const o = encl[k];
      if (o < 0 || !isP(t[o], '(')) break;
      const callee = t[o - 1];
      if (callee && callee.type === 'name' && WRITE.has(callee.value)) flagged = callee.value + '(…)';
      else flagged = chainWrites(match[o] + 1);
      k = o; top = o;
    }
    if (flagged) { hits.push({ line: t[i].line, how: flagged }); continue; }
    /* from the OUTERMOST enclosing call, back to `name =` (a ref kept for a later write) */
    const v = statementTarget(top);
    if (v) refVars.add(v);
  }
  if (refVars.size) {
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'name' || !refVars.has(t[i].value) || isP(t[i - 1], '.')) continue;
      const o = encl[i];
      const callee = o > -1 && isP(t[o], '(') ? t[o - 1] : null;
      if (callee && callee.type === 'name' && WRITE.has(callee.value)) hits.push({ line: t[i].line, how: callee.value + '(' + t[i].value + ')' });
      else if (isP(t[i + 1], '.') && t[i + 2] && WRITE.has(t[i + 2].value) && isP(t[i + 3], '(')) hits.push({ line: t[i].line, how: t[i].value + '.' + t[i + 2].value + '(…)' });
    }
  }
  return hits;
}
/** A file → JS sources (inline scripts for HTML). */
function sourcesOf(rel, text) {
  if (/\.html$/i.test(rel)) return extractInlineScripts(text).map((s) => ({ code: s.code, line: s.line || 1 }));
  return [{ code: text, line: 1 }];
}
function scanFile(rel, text) {
  const out = [];
  for (const s of sourcesOf(rel, text)) for (const h of findWrites(s.code)) out.push(rel + ':' + (h.line + s.line - 1) + ' ' + h.how);
  return out;
}

/* ── the files ───────────────────────────────────────────────────────────── */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MERCHANT_FILES = fs.readdirSync(ROOT)
  .filter((f) => /^merchant[\w-]*\.html$/.test(f) || /^sokoni-merchant[\w-]*\.js$/.test(f) || f === 'sokoni-availability-model.js')
  .sort();
let SHELL = read('merchant-v2.html');

const SAVE_START = "  async function avSave (btn) {";
const REINSERT = "      var f0 = await firestore();" + NL +
  "      await f0.m.setDoc(f0.m.doc(f0.db, 'providerAvailability', S.uid), { hours: AV.hours, overrides: AV.overrides }, { merge: true });" + NL;
function reinsertSetDoc(src) {
  const at = src.indexOf("      var res = await _callable('setShopAvailability')(payload);");
  if (at < 0) throw new Error('control anchor not found');
  return src.slice(0, at) + REINSERT + src.slice(at);
}
if (CONTROL === 'reinsert-setdoc') { SHELL = reinsertSetDoc(SHELL); console.log('  CONTROL MODE: setDoc re-inserted into avSave — row 1 MUST fail'); }
else if (CONTROL) { console.log('unknown control ' + CONTROL); process.exit(2); }

/* ── 1 · static ──────────────────────────────────────────────────────────── */
head('1 · no browser write to providerAvailability in any merchant file (' + MERCHANT_FILES.length + ' files, token-aware)');
{
  const found = [], blind = [];
  for (const f of MERCHANT_FILES) {
    const text = f === 'merchant-v2.html' ? SHELL : read(f);
    try { found.push(...scanFile(f, text)); } catch (e) { blind.push(f + ': ' + e.message); }
  }
  ck('every merchant script was tokenized (an unlexable file is NOT clean)', blind.length === 0, blind.join('; '));
  ck('NO-CLIENT-AVAILABILITY-WRITE: no setDoc/updateDoc/batch/tx/compat write targets providerAvailability',
     found.length === 0, found.join('; '));
  ck('the shell no longer writes shops/{uid} from the availability save',
     !/updateDoc\(f\.m\.doc\(f\.db, 'shops', S\.uid\)/.test(SHELL),
     'the server writes shops/{id}.openingHours in the same transaction');
}

/* ── 2 · detector controls ──────────────────────────────────────────────── */
head('2 · the detector is proven to bite');
{
  const real = read('merchant-v2.html');
  ck('CONTROL re-inserted modular setDoc in avSave → flagged', scanFile('merchant-v2.html', reinsertSetDoc(real)).length === 1);
  ck('CONTROL compat chain .collection(...).doc(u).set(...) → flagged',
     findWrites("db.collection('providerAvailability').doc(u).set({ a: 1 }, { merge: true });").length === 1);
  ck('CONTROL ref held in a variable then updateDoc(ref) / batch.set(ref) / tx.update(ref) → flagged',
     findWrites("var ref = doc(db, 'providerAvailability', u); await updateDoc(ref, {});").length === 1 &&
     findWrites("const r = m.doc(db, 'providerAvailability', u); b.set(r, {});").length === 1 &&
     findWrites("let r = db.collection('providerAvailability').doc(u); tx.update(r, {});").length === 1);
  ck('CONTROL a path string providerAvailability/<uid> → flagged',
     findWrites("setDoc(doc(db, 'providerAvailability/' + u), {});").length === 1);
  ck('CONTROL a mention in a comment or a longer string is NOT a write',
     findWrites("/* setDoc(doc(db, 'providerAvailability', u)) */ var s = \"setDoc providerAvailability\";").length === 0);
  const readSite = sourcesOf('merchant-v2.html', real).some((s) => tokenize(s.code).some(isCollStr));
  ck('POSITIVE CONTROL the remaining READ is seen by the scan (token present) and not flagged',
     readSite && /getDoc\(f\.m\.doc\(f\.db, 'providerAvailability', S\.uid\)\)/.test(real));
}

/* ── 3 · VM behaviour ───────────────────────────────────────────────────── */
head('3 · avSave in a VM — callable shape, saved-only-after-resolve, honest failure, no fallback');
const M = require(path.join(ROOT, 'sokoni-availability-model.js'));
const AV_LINE = (SHELL.match(/^ {2}var AV = \{[^\n]*\};$/m) || [])[0];
const s0 = SHELL.indexOf('  var AV_UNAVAILABLE');
const s1 = SHELL.indexOf('  /* ══ SETTINGS', s0);
const SLICE = s0 > -1 && s1 > s0 ? SHELL.slice(s0, s1) : null;
ck('the save block is sliceable (AV state + avPreflight … avSave)', !!AV_LINE && !!SLICE && SLICE.indexOf(SAVE_START) > -1);

function week() {
  const w = M.emptyWeek ? M.emptyWeek() : null;
  return w || { sun: { closed: true, periods: [] }, mon: { closed: false, periods: [{ open: '09:00', close: '17:00' }] },
    tue: { closed: true, periods: [] }, wed: { closed: true, periods: [] }, thu: { closed: true, periods: [] },
    fri: { closed: true, periods: [] }, sat: { closed: true, periods: [] } };
}
function ymdIn(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }

function harness(opts) {
  const log = { calls: [], toasts: [], renders: [], firestore: 0, order: [] };
  let resolveCall, rejectCall;
  const ctx = {
    console, Date, JSON, Object, Array, String, Promise, RegExp, Math, Number,
    window: { SokoniAvailabilityModel: M }, navigator: { onLine: opts.online !== false },
    S: Object.assign({ uid: 'owner-1', shop: { id: 'shop-A' }, servedBy: null, activeShopId: 'shop-A' }, opts.S || {}),
    toast: (m) => { log.toasts.push(m); log.order.push('toast:' + m); },
    nativePanel: () => ({}),
    firestore: () => { log.firestore++; throw new Error('firestore() must never be reached from the save path'); },
    _callable: (name) => (payload) => {
      log.calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
      log.order.push('call');
      if (opts.respond) return opts.respond(payload);
      return new Promise((res, rej) => { resolveCall = res; rejectCall = rej; });
    },
  };
  ctx.renderAvailability = () => log.renders.push({ saving: ctx.AV.saving, dirty: ctx.AV.dirty, saveErr: ctx.AV.saveErr });
  vm.createContext(ctx);
  vm.runInContext(AV_LINE + NL + 'function avModel () { return window.SokoniAvailabilityModel; }' + NL + SLICE + NL + 'this.AV = AV;', ctx);
  ctx.AV.hours = opts.hours || week(); ctx.AV.overrides = opts.overrides || {}; ctx.AV.loaded = true; ctx.AV.dirty = true;
  return { ctx, log, resolve: (v) => resolveCall && resolveCall(v), reject: (e) => rejectCall && rejectCall(e) };
}
const UNAVAILABLE = "Couldn't save — the schedule service isn't available yet. Nothing was changed.";
const saved = (log) => log.toasts.some((m) => /saved/i.test(m) && !/Couldn't/.test(m));
const err = (code, message, details) => Object.assign(new Error(message), { code, details });

(async () => {
  if (!SLICE || !AV_LINE) { report(); return; }

  /* 3a success: exact name + shape; Saved only after resolve */
  {
    const ov = {}; ov[ymdIn(10)] = { closed: true }; ov[ymdIn(20)] = { closed: false, periods: [{ open: '10:00', close: '14:00' }], label: 'Market day', note: 'x' };
    const h = harness({ overrides: ov });
    const p = h.ctx.avSave();
    await new Promise((r) => setImmediate(r));
    ck('the save calls the callable named exactly setShopAvailability', h.log.calls.length === 1 && h.log.calls[0].name === 'setShopAvailability');
    const pl = h.log.calls[0] && h.log.calls[0].payload;
    ck('payload is exactly { schedule: { hours, overrides } } for an owner (no shopId, no uid, no live fields)',
       pl && JSON.stringify(Object.keys(pl)) === '["schedule"]' && JSON.stringify(Object.keys(pl.schedule).sort()) === '["hours","overrides"]');
    ck('hours carry all 7 day keys, each { closed, periods[{open,close}] } — the server\'s field names',
       pl && M.DAYS.every((d) => pl.schedule.hours[d] && typeof pl.schedule.hours[d].closed === 'boolean' && Array.isArray(pl.schedule.hours[d].periods)) &&
       Object.keys(pl.schedule.hours).length === 7);
    ck('overrides map keeps closed / periods / label only (fields the server keeps)',
       pl && JSON.stringify(pl.schedule.overrides[ymdIn(10)]) === '{"closed":true}' &&
       JSON.stringify(pl.schedule.overrides[ymdIn(20)]) === '{"closed":false,"periods":[{"open":"10:00","close":"14:00"}],"label":"Market day"}');
    ck('"Saved" is NOT shown while the call is pending; the form is saving and still dirty',
       !saved(h.log) && h.ctx.AV.saving === true && h.ctx.AV.dirty === true);
    h.resolve({ data: { success: true, shopId: 'shop-A', availability: {}, verdict: { open: true } } });
    await p;
    ck('"Saved" is shown only AFTER the server resolved with success, and the form is clean',
       saved(h.log) && h.log.order.indexOf('call') < h.log.order.findIndex((x) => /saved/i.test(x)) && h.ctx.AV.dirty === false && h.ctx.AV.saving === false);
    ck('local shop record mirrors what the server wrote (structured openingHours), after resolve',
       h.ctx.S.shop.openingHours && h.ctx.S.shop.openingHours.mon && Array.isArray(h.ctx.S.shop.openingHours.mon.periods));
    ck('no Firestore client was touched on the save path', h.log.firestore === 0);
  }

  /* 3b resolved without success */
  {
    const h = harness({ respond: async () => ({ data: { success: false } }) });
    await h.ctx.avSave();
    ck('a resolve WITHOUT success:true is not announced as saved; form stays unsaved',
       !saved(h.log) && h.ctx.AV.dirty === true && /did not confirm/.test(h.ctx.AV.saveErr || ''));
  }

  /* 3c the failure matrix — honest message, unsaved, no fallback */
  const cases = [
    ['callable missing (functions/not-found)', err('functions/not-found', 'not-found'), true, UNAVAILABLE],
    ['internal', err('functions/internal', 'INTERNAL'), true, UNAVAILABLE],
    ['unavailable', err('functions/unavailable', 'Service unavailable'), true, UNAVAILABLE],
    ['offline', err('functions/unavailable', 'Failed to fetch'), false, UNAVAILABLE],
    ['the pre-schedule LIVE build (09-09) refusing a schedule-only payload',
     err('functions/invalid-argument', 'No availability fields supplied.'), true, UNAVAILABLE],
    ['server validation', err('functions/invalid-argument', 'Monday is open but has no hours.'), true,
     "Couldn't save — Monday is open but has no hours. Nothing was changed."],
    ['role without manageAvailability', err('functions/permission-denied', "Your role cannot change this shop's availability. Ask the owner.", { code: 'NO_CAPABILITY' }), true,
     "Couldn't save — Your role cannot change this shop's availability. Ask the owner. Nothing was changed."],
    ['healthcare-owned schedule', err('functions/failed-precondition', 'Healthcare hours are managed in the healthcare workspace.'), true,
     "Couldn't save — Healthcare hours are managed in the healthcare workspace. Nothing was changed."],
    ['no shop', err('functions/not-found', 'No shop found for your account.'), true,
     "Couldn't save — no shop was found for your account. Nothing was changed."],
  ];
  for (const [name, e, online, want] of cases) {
    const h = harness({ online, respond: async () => { throw e; } });
    await h.ctx.avSave();
    ck('failure · ' + name + ' → honest message, unsaved, no fallback write',
       h.ctx.AV.saveErr === want && h.log.toasts.indexOf(want) > -1 && !saved(h.log) &&
       h.ctx.AV.dirty === true && h.ctx.AV.saving === false && h.log.firestore === 0 && h.log.calls.length === 1,
       'got ' + JSON.stringify(h.ctx.AV.saveErr));
  }

  /* 3d employee names the shop */
  {
    const h = harness({ S: { servedBy: { role: 'manager' }, activeShopId: 'shop-A' }, respond: async () => ({ data: { success: true } }) });
    await h.ctx.avSave();
    ck('an employee session sends shopId (server checks manageAvailability); an owner never does',
       h.log.calls[0] && h.log.calls[0].payload.shopId === 'shop-A');
  }

  /* 3e preflight blocks before any call */
  {
    const w = week(); w.mon = { closed: false, periods: Array.from({ length: 7 }, (_, i) => ({ open: (10 + i) + ':00', close: (10 + i) + ':30' })) };
    const h = harness({ hours: w, respond: async () => ({ data: { success: true } }) });
    await h.ctx.avSave();
    ck('more than 6 periods a day is refused BEFORE the call (server limit)', h.log.calls.length === 0 && /at most 6 periods/.test(h.ctx.AV.saveErr || ''));
    const ov = {}; ov[ymdIn(-45)] = { closed: true };
    const h2 = harness({ overrides: ov, respond: async () => ({ data: { success: true } }) });
    await h2.ctx.avSave();
    ck('an out-of-range closed date blocks the save with a named message — never silently pruned (the server REPLACES the map)',
       h2.log.calls.length === 0 && (h2.ctx.AV.saveErr || '').indexOf(ymdIn(-45)) > -1 && Object.keys(h2.ctx.AV.overrides).length === 1);
    const w3 = week(); w3.tue = { closed: false, periods: [] };
    const h3 = harness({ hours: w3, respond: async () => ({ data: { success: true } }) });
    await h3.ctx.avSave();
    ck('the model validation still runs first (open day with no hours)', h3.log.calls.length === 0 && /no hours/.test(h3.ctx.AV.saveErr || ''));
  }

  /* ── 4 · contract cross-check with 2f's callable ──────────────────────── */
  head('4 · the payload matches the callable 2f owns');
  let fn = null;
  try { fn = execFileSync('git', ['show', FN_BRANCH + ':functions/kasshop.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { fn = null; }
  if (!fn) unp('kasshop.setShopAvailability source', FN_BRANCH + ' not fetched — `git fetch origin convergence/commercial-fn-on-ef1e992`');
  else {
    const at = fn.indexOf('exports.setShopAvailability');
    const end = fn.indexOf(NL + 'exports.', at + 10);
    const body = at < 0 ? '' : fn.slice(at, end > at ? end : fn.length);
    ck('2f reads data.schedule.hours and data.schedule.overrides', /_cleanHours\(data\.schedule\.hours\)/.test(body) && /_cleanOverrides\(data\.schedule\.overrides/.test(body));
    ck('2f reads data.shopId for an employee and checks manageAvailability', /data\.shopId/.test(body) && /manageAvailability/.test(body));
    ck('2f returns { success: true, … } after the transaction', /return \{ success: true, shopId, availability: live, verdict \}/.test(body));
    ck('2f limits match the client preflight (6 periods, 120 dates, -31/+400 days)',
       /list\.length > 6/.test(fn) && /keys\.length > 120/.test(fn) && /31 \* 86400000/.test(fn) && /400 \* 86400000/.test(fn));
  }

  /* ── 5 · the deploy precondition cannot be dropped in assembly ─────────── */
  head('5 · DEPLOY PRECONDITION recorded');
  const CL = read('CHANGELOG.md');
  const entryAt = CL.indexOf('setShopAvailability — Merchant V2 schedule saves through the server');
  const entry = entryAt > -1 ? CL.slice(entryAt, CL.indexOf(NL + '## [', entryAt + 1) > -1 ? CL.indexOf(NL + '## [', entryAt + 1) : CL.length) : '';
  ck('PRECONDITION-IN-CHANGELOG: the CHANGELOG entry states "' + PRECONDITION + '"', entry.indexOf(PRECONDITION) > -1);
  ck('the merchant architecture doc states it too', read('docs/MERCHANT_V2_TARGET_ARCHITECTURE.md').indexOf(PRECONDITION) > -1);
  ck('the shell source states it next to the save', SHELL.indexOf('requires functions: setShopAvailability live (verify with a') > -1);

  report();
})().catch((e) => { fail++; console.log('  FAIL harness crashed: ' + (e && e.stack || e)); report(); });

function report() {
  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' unproven' : ''));
  process.exit(fail ? 1 : 0);
}
