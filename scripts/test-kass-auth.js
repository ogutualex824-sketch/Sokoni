#!/usr/bin/env node
/* test-kass-auth.js — KASS authentication: missing ≠ invalid, and an invalid credential is NEVER a guest.
 *
 *   node scripts/test-kass-auth.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-auth.js  # functions/index.js @ 4e9607b — failures ARE the defect
 *
 * LIVE defect (production sokonichat-00058-hal, docs/C4_C8_PRODUCTION_PRIVACY_AUTH_CENSUS.md #1): /api/chat refused
 * only a MISSING auth_token; any non-empty string that failed verification became uid=null and the request went on
 * to the model and every read tool, at platform cost.
 *
 * The REAL sokoniChat request handler, the REAL auth classifier / verifier, the REAL tool-access map and the REAL
 * tool executor are sliced from functions/index.js and driven with a fake request/response. firebase-admin's
 * verifyIdToken is stubbed to behave like Firebase for each credential kind; the model client is stubbed and
 * counts calls — nothing leaves the machine.
 *
 * PROVES
 *   A1  a valid Firebase ID token proceeds: the model is called and the reply is 200
 *   A2  a missing token is refused 401 auth_required, and the model is never called
 *   A3  a garbage token is refused 401 auth_invalid — never a guest — and the model is never called
 *   A4  an expired token is refused 401 auth_expired (so the widget can refresh once), model never called
 *   A5  a revoked / otherwise-invalid token is refused 401 auth_invalid
 *   A6  a malformed (non-string / oversized) credential is refused without calling the verifier
 *   T1  every tool offered to the model has an EXPLICIT access grant (default deny: no unmapped tool)
 *   T2  a user-only tool refuses a caller without a verified identity
 *   T3  a public read tool is NOT open to a caller without identity while anonymous chat is disabled
 *   T4  an unknown tool name never runs
 *   T5  a verified user runs both public and user tools (control — explicit grants still work)
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const X = require('./lib/xss-probe');
const ROOT = path.resolve(__dirname, '..');
const CPM = !!process.env.COUNTERPROOF;
const IDX = CPM ? cp.execFileSync('git', ['show', '4e9607b:functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 }) : fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
const opt = (head) => { try { return X.extractFrom(IDX, head); } catch (e) { return ''; } };

/* the handler: the arrow passed to onRequest for exports.sokoniChat */
const at = IDX.indexOf('exports.sokoniChat = onRequest(');
const HANDLER = X.extractFrom(IDX.slice(at), 'async (req, res) => {');
const PIECES = [
  opt('async function _classifyKassAuth(token) {'),
  opt('async function _verifyKassToken(token) {'),
  opt('function _authRequired() {'),
  (IDX.match(/const KASS_GUEST_CHAT = [^;]+;/) || [''])[0],
  opt('const _KASS_TOOL_ACCESS = Object.freeze({') ? opt('const _KASS_TOOL_ACCESS = Object.freeze({').replace(/\}$/, '});').replace(/\}\);\);$/, '});') : '',
  opt('function _kassToolAllowed(name, ctx) {'),
  opt('async function _execChatTool(name, input, ctx) {'),
].filter(Boolean).join('\n');

/* Firebase-like verifier */
const verifyCalls = [];
function verifyIdToken(t) {
  verifyCalls.push(t);
  if (t === 'VALID-TOKEN') return Promise.resolve({ uid: 'user_1' });
  const err = (code) => Object.assign(new Error(code), { code });
  if (t === 'EXPIRED-TOKEN') return Promise.reject(err('auth/id-token-expired'));
  if (t === 'REVOKED-TOKEN') return Promise.reject(err('auth/id-token-revoked'));
  return Promise.reject(err('auth/argument-error'));
}
/* a Firestore stub that answers every read with "nothing" */
const emptySnap = { exists: false, empty: true, docs: [], size: 0, data: () => ({}), forEach() {} };
const q = () => { const o = { where: () => o, orderBy: () => o, limit: () => o, startAfter: () => o, doc: () => o, collection: () => o, get: async () => emptySnap, add: async () => ({ id: 'new1' }), set: async () => {}, update: async () => {} }; return o; };
const db = { collection: q, doc: q, runTransaction: async (f) => f({ get: async () => emptySnap, set() {}, update() {} }), batch: () => ({ set() {}, update() {}, commit: async () => {} }) };

function build() {
  let modelCalls = 0;
  const anthropic = { messages: { create: async () => { modelCalls++; return { content: [{ type: 'text', text: 'Hello from KASS' }], stop_reason: 'end_turn' }; } } };
  const scope = {
    admin: { auth: () => ({ verifyIdToken }), firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n } }) },
    db, checkRateLimitDurable: async () => ({ ok: true }), _getAnthropicClient: () => anthropic, Anthropic: function () { return anthropic; },
    ANTHROPIC_API_KEY: { value: () => 'test-key' }, console: { log() {}, warn() {}, error() {}, info() {} },
    _kassCommission: { commissionPromptLine: () => 'Commission line' },
  };
  const api = X.runWith('(function(){ ' + PIECES + '\nreturn { handler: (' + HANDLER + '), classify: (typeof _classifyKassAuth === "function" ? _classifyKassAuth : null), exec: _execChatTool, access: (typeof _KASS_TOOL_ACCESS === "object" ? _KASS_TOOL_ACCESS : null) }; })()', scope);
  return { api, modelCalls: () => modelCalls };
}
async function call(token) {
  const b = build();
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(j) { out.body = j; return res; }, send(j) { out.body = j; return res; }, set() { return res; }, setHeader() {}, end() {} };
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  if (token !== undefined) body.auth_token = token;
  try { await b.api.handler({ method: 'POST', headers: {}, ip: '1.2.3.4', body }, res); } catch (e) { out.crash = e.message; }
  return Object.assign(out, { model: b.modelCalls() });
}

(async () => {
  console.log('\nSOURCE: functions/index.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defect' : 'working tree (fix)'));
  const v = await call('VALID-TOKEN');
  ck('A1  a valid ID token proceeds: model called, 200', v.status === 200 && v.model >= 1, v);
  const m = await call(undefined);
  ck('A2  a missing token → 401 auth_required, model never called', m.status === 401 && m.model === 0 && (CPM || (m.body && m.body.code === 'auth_required')), m);
  const g = await call('garbage');
  ck('A3  a garbage token → 401 auth_invalid, never a guest, model never called', g.status === 401 && g.model === 0 && !!g.body && g.body.code === 'auth_invalid', g);
  const ex = await call('EXPIRED-TOKEN');
  ck('A4  an expired token → 401 auth_expired, model never called', ex.status === 401 && ex.model === 0 && !!ex.body && ex.body.code === 'auth_expired', ex);
  const rv = await call('REVOKED-TOKEN');
  ck('A5  a revoked token → 401 auth_invalid, model never called', rv.status === 401 && rv.model === 0 && !!rv.body && rv.body.code === 'auth_invalid', rv);
  const before = verifyCalls.length;
  const mf1 = await call({ not: 'a string' });
  const mf2 = await call('x'.repeat(5000));
  ck('A6  a malformed credential (object / oversized) → 401, verifier not called, model not called',
    mf1.status === 401 && mf2.status === 401 && mf1.model === 0 && mf2.model === 0 && verifyCalls.length === before, { mf1: mf1.status, mf2: mf2.status, verifierCalls: verifyCalls.length - before });

  /* ── tool access ── */
  const b = build();
  const toolsBlock = IDX.slice(IDX.indexOf('const _CHAT_TOOLS'), IDX.indexOf('];', IDX.indexOf('const _CHAT_TOOLS')));
  const offered = [...toolsBlock.matchAll(/name: *"([a-z_]+)"/g)].map((x) => x[1]);
  const access = b.api.access;
  ck('T1  every tool offered to the model has an explicit access grant (no unmapped tool)', !!access && offered.length > 10 && offered.every((n) => access[n] === 'user' || access[n] === 'public'), access ? offered.filter((n) => !access[n]) : 'no access map');
  const w = await b.api.exec('get_wallet', {}, { uid: null, addAction() {} });
  ck('T2  a user-only tool (get_wallet) refuses a caller without identity', !!w && w.requiresAuth === true, w);
  const s = await b.api.exec('get_page_url', { page: 'home' }, { uid: null, addAction() {} });
  ck('T3  a public read tool is not open to a caller without identity while anonymous chat is disabled', !!s && s.requiresAuth === true, s);
  const u = await b.api.exec('delete_everything', {}, { uid: 'user_1', addAction() {} });
  ck('T4  an unknown tool name never runs, even for a verified user', !!u && !!u.error, u);
  const pu = await b.api.exec('get_page_url', { page: 'home' }, { uid: 'user_1', addAction() {} });
  const uu = await b.api.exec('get_wallet', {}, { uid: 'user_1', addAction() {} });
  ck('T5  a verified user runs public and user tools (control)', !!pu && !pu.requiresAuth && !!uu && !uu.requiresAuth, { pu, uu });

  /* ── the widget: one forced-refresh retry on a refused sign-in; history stays intact ── */
  {
    const WID = CPM ? cp.execFileSync('git', ['show', '4e9607b:kass-widget.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(ROOT, 'kass-widget.js'), 'utf8');
    const getTok = X.extractFrom(WID, 'function _getAuthToken(');
    const callK = X.extractFrom(WID, 'function _callKass(');
    const run = async (responses) => {
      const seen = [];
      const forced = [];
      const user = { getIdToken: (f) => { forced.push(!!f); return Promise.resolve(f ? 'FRESH' : 'STALE'); } };
      const fetchFn = (url, o) => { const b = JSON.parse(o.body); seen.push(b.auth_token); const r = responses.shift(); return Promise.resolve({ ok: r.status === 200, status: r.status, statusText: '', json: () => Promise.resolve(r.body) }); };
      const scope = { fetch: fetchFn, _authReady: () => Promise.resolve(user), _dbg() {}, _friendlyMsg: (m) => m, ENDPOINT: '/api/chat', performance: { now: () => 0 }, setTimeout, clearTimeout, AbortController, navigator: { onLine: true }, window: { location: { origin: 'x' } } };
      const api = X.runWith('(function(){ var _history = [{role:"user",content:"earlier"},{role:"assistant",content:"earlier reply"}];\n' + getTok + '\n' + callK + '\nreturn { call: _callKass, hist: function(){ return _history; } }; })()', scope);
      let out, err;
      try { out = await api.call('hello'); } catch (e) { err = e.message; }
      return { out, err, seen, forced, hist: api.hist().map((h) => h.content) };
    };
    const r1 = await run([{ status: 401, body: { code: 'auth_expired', error: 'expired' } }, { status: 200, body: { response: 'hi there' } }]);
    ck('W1  widget: a refused (expired) sign-in is retried ONCE with a freshly minted token, and succeeds', !!r1.out && r1.seen.length === 2 && r1.seen[1] === 'FRESH' && r1.forced[1] === true, r1);
    const r2 = await run([{ status: 401, body: { code: 'auth_invalid', error: 'bad' } }, { status: 401, body: { code: 'auth_invalid', error: 'still bad' } }]);
    ck('W2  widget: a second refusal is shown, never retried again', !!r2.err && r2.seen.length === 2, { err: r2.err, calls: r2.seen.length });
    ck('W3  widget: a failed retry leaves earlier conversation turns intact (removes only its own message)', JSON.stringify(r2.hist) === JSON.stringify(['earlier', 'earlier reply']), r2.hist);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
