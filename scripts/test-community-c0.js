#!/usr/bin/env node
/* test-community-c0.js — community slice C0 (hosting only): stored-XSS port of 431b5c7 + honesty fixes on
 * community.html and requests.html. Static; no network, no Firebase, no browser.
 *
 *   X1  every `${…}` interpolation in either page that reads a user-written record field (post, reply, group,
 *       event, ask, notification, request, offer, delivery …) is wrapped in the canonical escaper
 *       (escapeHTML from security.js; requests.html's pre-existing _esc), a Number(), or is only a condition /
 *       a lookup key into a constant map
 *   X2  no inline handler carries a template value inside a JS string ('${…}'): HTML-escaping does not make a
 *       value safe in a JS-string context (&#39; decodes back to ' before the handler runs) — values ride data-*
 *   X3  both pages load security.js (the canonical escaper) before their inline scripts
 *   H1  no seed writer / demo content on community.html (seed posts, DEMO_* arrays, the demo gate)
 *   H2  no fabricated "500+" figure on either page; no member count element
 *   H3  community.html: no success string can render before its write resolved — each success string sits
 *       AFTER an awaited write inside its own function, and no write is fire-and-forget (.catch(()=>{}))
 *   H4  community.html report: the refusal path says "We couldn't send your report"; the old unconditional
 *       success notice is gone
 *   H5  requests.html: no false-success / false-reach strings; the honest "not published" copy is present
 *   H6  community.html: an empty snapshot renders the empty state (no early return into a writer)
 *   N*  negative controls: each check above, run on a copy with ONE defect re-introduced, must FAIL
 *
 *   node scripts/test-community-c0.js
 */
'use strict';
const fs = require('fs'), Path = require('path');
const ROOT = Path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + String(JSON.stringify(got)).slice(0, 500) + ']')); ok ? pass++ : fail++; };
/* COUNTERPROOF=<rev> reads both pages at that revision (e.g. 95425eb, the pre-C0 base) — the failures ARE the defects */
const CP = process.env.COUNTERPROOF;
const read = (f) => CP ? require('child_process').execFileSync('git', ['show', CP + ':' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(Path.join(ROOT, f), 'utf8');
if (CP) console.log('\nSOURCE: ' + CP + ' (counterproof — failures below ARE the defects; negative controls are skipped)');
const COMMUNITY = read('community.html');
const REQUESTS = read('requests.html');

/* ── helpers ─────────────────────────────────────────────────────────────────────────────────────── */
/* Return the index just past the balanced bracket that opens at s[i] ('(' '[' '{'), skipping strings. */
function balanced(s, i) {
  const open = s[i], close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'") { const q = c; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; } continue; }
    if (c === '`') { k = skipTemplate(s, k); continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return k + 1; }
  }
  return s.length;
}
/* s[i] === '`' → index of the closing backtick (nested ${…} handled). */
function skipTemplate(s, i) {
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '`') return k;
    if (s[k] === '$' && s[k + 1] === '{') { k = balanced(s, k + 1) - 1; }
  }
  return s.length;
}
/* Every ${…} expression in the source (outer and nested). */
function interpolations(src) {
  const out = [];
  let k = 0;
  while ((k = src.indexOf('${', k)) !== -1) {
    const end = balanced(src, k + 1);
    out.push({ at: k, expr: src.slice(k + 2, end - 1) });
    k += 2;
  }
  return out;
}
const SAFE_CALLS = ['escapeHTML', '_esc', 'Number', 'timeAgo', '_timeAgo', 'new Date', 'Math.round', 'encodeURIComponent'];
/* Remove safe wrappers, string literals and nested templates (scanned on their own); what is left must not
   read a user-record field except as a condition or as a lookup key into a constant map. */
function residue(expr) {
  let e = expr;
  e = e.replace(/`/g, '\u0000');                      /* nested templates: their own ${} are scanned separately */
  for (let guard = 0; guard < 200; guard++) {
    let hit = false;
    for (const fn of SAFE_CALLS) {
      const re = new RegExp('(^|[^A-Za-z0-9_$.])' + fn.replace(/[.$]/g, (c) => '\\' + c) + '\\s*\\(');
      const m = re.exec(e);
      if (m) { const open = m.index + m[0].length - 1; const end = balanced(e, open); e = e.slice(0, m.index + m[1].length) + ' SAFE ' + e.slice(end); hit = true; }
    }
    if (!hit) break;
  }
  e = e.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' STR ');
  e = e.replace(/\u0000[^\u0000]*\u0000/g, ' TPL ');
  return e;
}
const RECORD = '(?:p|r|g|n|ev|ask|o|d|del|tl|b|order|post|reply|group|req)';
function unsafeFields(expr) {
  const e = residue(expr);
  const bad = [];
  const re = new RegExp('(^|[^A-Za-z0-9_$.])(' + RECORD + '\\.[A-Za-z_$][A-Za-z0-9_$]*)', 'g');
  let m;
  while ((m = re.exec(e))) {
    const startTok = m.index + m[1].length, endTok = startTok + m[2].length;
    const before = e.slice(0, startTok).trimEnd(), after = e.slice(endTok).trimStart();
    if (before.endsWith('[') && after.startsWith(']')) continue;                       /* CONST_MAP[rec.x] */
    if (/^(\?(?!\?)|\?\.|===|!==|==|!=|&&|>|<|\.length\b)/.test(after)) continue;      /* condition / optional chain / count */
    if (/^\|\|\s*\[\]\s*\)\s*(\.slice\([^)]*\)\s*)?\.map\(/.test(after)) continue;       /* (rec.list||[]).map(x=>`…`) — the row template is scanned on its own */
    bad.push(m[2]);
  }
  return bad;
}
function xssAudit(src) {
  const bad = [];
  for (const { at, expr } of interpolations(src)) {
    const f = unsafeFields(expr);
    if (f.length) bad.push({ line: src.slice(0, at).split('\n').length, fields: f, expr: expr.slice(0, 80) });
  }
  return bad;
}
function handlerAudit(src) {
  const bad = [];
  const re = /\son[a-z]+\s*=\s*"[^"]*'\$\{/g; let m;
  while ((m = re.exec(src))) bad.push({ line: src.slice(0, m.index).split('\n').length, at: m[0].slice(0, 80) });
  return bad;
}
/* Body of `name` (function declaration or window.name = function / async function). */
function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(|window\\.' + name + '\\s*=\\s*(?:async\\s+)?function\\s*\\(');
  const m = re.exec(src); if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index + m[0].length - 1));
  return src.slice(open, balanced(src, open));
}
/* success string must appear only AFTER an awaited write in the same function, and no write may be un-awaited */
function successAfterWrite(src, fn, successRe) {
  const body = fnBody(src, fn);
  if (!body) return { ok: false, why: 'function ' + fn + ' not found' };
  const w = body.search(/await\s+m\.(addDoc|setDoc|updateDoc|deleteDoc)\s*\(/);
  const sm = successRe.exec(body);
  const unawaited = /(^|[^t]\s|[;{(,])m\.(addDoc|setDoc|updateDoc|deleteDoc)\s*\(/.test(body.replace(/await\s+m\./g, 'AWAITED.'));
  return { ok: w >= 0 && !!sm && sm.index > w && !unawaited, why: { write: w, success: sm && sm.index, unawaited } };
}
const SUCCESS = [
  ['submitReport', /Report sent/],
  ['createGroup', /Group created/],
  ['submitEvent', /Event saved/],
  ['submitAsk', /Question saved/],
  ['toggleFollowUser', /Following \$\{name\}/],
];
const REQ_FALSE = [/Sellers will respond/i, /Offer sent/i, /The buyer will see it/i, /✅ Posted/, /Verified Sokoni drivers will pick/i, /get a live tracking link/i,
  /all see the same live status/i, /href="tel:\+254"/, /sellers will contact you directly/i, /I Can Deliver This/, /Confirm Accept/, /Mark: Delivered/];

function audits(C, R) {
  const r = {};
  r.X1c = xssAudit(C); r.X1r = xssAudit(R);
  r.X2 = handlerAudit(C).concat(handlerAudit(R));
  const secBefore = (s) => { const a = s.indexOf('src="security.js"'); const b = s.search(/<script>\s*\n?(?:const|let|var|\/\*|function)/); return a >= 0 && (b < 0 || a < b); };
  r.X3 = secBefore(C) && secBefore(R);
  const code = C.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');   /* comment prose may NAME what was removed */
  r.H1 = ['_seedFirestore', 'authorUid:"seed"', 'DEMO_GROUPS', 'DEMO_EVENTS', 'DEMO_ASKS', 'DEMO_BIZ', '_demoAllowed', 'ccEvLocal', 'ccAskLocal']
    .filter((t) => code.includes(t));
  r.H2 = ['500+', 'cmMemberCount'].filter((t) => C.includes(t) || R.includes(t));
  r.H3 = SUCCESS.map(([fn, re]) => [fn, successAfterWrite(C, fn, re)]).filter(([, v]) => !v.ok);
  const ff = C.match(/m\.(addDoc|setDoc|updateDoc|deleteDoc)\([^;]*\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || [];
  r.H3ff = ff;
  r.H3old = ['Event created!', 'Question posted!', 'RSVP saved', 'Group created! Share', 'Report submitted'].filter((t) => C.includes(t));
  const rep = fnBody(C, 'submitReport') || '';
  r.H4 = /We couldn't send your report/.test(rep) && /catch\s*\(e\)\s*\{[\s\S]*fail\(e\)/.test(rep);
  r.H5false = REQ_FALSE.filter((re) => re.test(R)).map(String);
  r.H5honest = /Requests are not published to sellers yet/.test(R) && /Offers are not delivered to buyers yet/.test(R) && /Delivery requests are not sent to drivers yet/.test(R);
  r.H6 = /posts = snap\.empty \? \[\] :/.test(C) && /No posts here yet/.test(C);
  return r;
}

/* ── the real pages ─────────────────────────────────────────────────────────────────────────────── */
console.log('\n── working tree ──');
const A = audits(COMMUNITY, REQUESTS);
ck('X1 community.html: every user-record field in an interpolation is escaped (' + interpolations(COMMUNITY).length + ' interpolations scanned)', !A.X1c.length, A.X1c);
ck('X1 requests.html: every user-record field in an interpolation is escaped (' + interpolations(REQUESTS).length + ' interpolations scanned)', !A.X1r.length, A.X1r);
ck('X2 no inline handler carries a template value inside a JS string', !A.X2.length, A.X2);
ck('X3 both pages load security.js (escapeHTML) before their inline scripts', A.X3);
ck('X4 the 431b5c7 group hunk is present: name, description and emoji escaped', /\$\{escapeHTML\(g\.name\)\}/.test(COMMUNITY) && /\$\{escapeHTML\(g\.desc\)\}/.test(COMMUNITY) && /\$\{escapeHTML\(g\.emoji\)\}/.test(COMMUNITY));
ck('H1 no seed writer, no DEMO_* content, no demo gate, no localStorage-as-community lists', !A.H1.length, A.H1);
ck('H2 no fabricated "500+" and no member-count element on either page', !A.H2.length, A.H2);
ck('H3 every success string follows an awaited write in its own function (report, group, event, ask, follow)', !A.H3.length, A.H3);
ck('H3 no fire-and-forget Firestore write (.catch(()=>{})) remains on community.html', !A.H3ff.length, A.H3ff);
ck('H3 the old unconditional success strings are gone', !A.H3old.length, A.H3old);
ck('H4 report refusal shows "We couldn\'t send your report"', A.H4);
ck('H5 requests.html: no false-success / false-reach strings', !A.H5false.length, A.H5false);
ck('H5 requests.html: the honest "not published" copy is present (requests, offers, deliveries)', A.H5honest);
ck('H6 an empty snapshot renders the empty state', A.H6);

/* ── negative controls: each re-introduced defect must be caught ─────────────────────────────────── */
if (CP) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
console.log('\n── negative controls (each must be DETECTED) ──');
const neg = (label, C, R, pick) => { const r = audits(C, R); const caught = pick(r); ck('N ' + label + ' → detected', caught, r); };
const swap = (s, a, b) => { if (!s.includes(a)) throw new Error('negative control anchor missing: ' + a); return s.replace(a, b); };
neg('raw group name sink ${g.name}', swap(COMMUNITY, '${escapeHTML(g.name)}', '${g.name}'), REQUESTS, (r) => r.X1c.some((x) => x.fields.includes('g.name')));
neg('raw notification title ${n.title}', swap(COMMUNITY, '${escapeHTML(n.title)}', '${n.title}'), REQUESTS, (r) => r.X1c.some((x) => x.fields.includes('n.title')));
neg('raw post body via ContactGuard only', swap(COMMUNITY, '${escapeHTML(ContactGuard.sanitiseForDisplay(p.body||""))}', '${ContactGuard.sanitiseForDisplay(p.body||"")}'), REQUESTS, (r) => r.X1c.some((x) => x.fields.includes('p.body')));
neg('raw request category ${r.category}', COMMUNITY, swap(REQUESTS, '${_esc(r.category)}', '${r.category}'), (r) => r.X1r.some((x) => x.fields.includes('r.category')));
neg("id spliced into a JS string in onclick", swap(COMMUNITY, 'data-gid="${escapeHTML(g.id)}" onclick="joinGroup(this.dataset.gid)"', 'onclick="joinGroup(\'${escapeHTML(g.id)}\')"'), REQUESTS, (r) => r.X2.length > 0);
neg('seed writer restored', swap(COMMUNITY, '      posts = snap.empty ? [] :', '      if(snap.empty){ _seedFirestore(); return; }\n      posts = snap.empty ? [] :'), REQUESTS, (r) => r.H1.includes('_seedFirestore'));
neg('"500+ members" restored', swap(COMMUNITY, '<span><strong id="cmTodayCount">', '<span><strong id="cmMemberCount">500+</strong> members</span><span><strong id="cmTodayCount">'), REQUESTS, (r) => r.H2.length > 0);
neg('report success before the write (fire-and-forget + unconditional notice)',
  swap(COMMUNITY, "    await m.addDoc(m.collection(window.firebaseDB,'communityReports'),", "    _addNotif('🚩 Report sent','');\n    await m.addDoc(m.collection(window.firebaseDB,'communityReports'),"), REQUESTS, (r) => r.H3.some(([fn]) => fn === 'submitReport'));
neg('group write made fire-and-forget', swap(COMMUNITY, '    await m.setDoc(m.doc(db,\'communityGroups\',g.id),', '    m.setDoc(m.doc(db,\'communityGroups\',g.id),'), REQUESTS, (r) => r.H3.some(([fn]) => fn === 'createGroup'));
neg('requests "Offer sent!" restored', COMMUNITY, swap(REQUESTS, 'Offer saved on this device only.', '✅ Offer sent! The buyer will see it.'), (r) => r.H5false.length > 0);
neg('requests "Sellers will respond" restored', COMMUNITY, swap(REQUESTS, 'msgEl.textContent="Saved as a draft on this device. Requests are not published to sellers yet.";', 'msgEl.innerHTML=\'✅ Posted! Sellers will respond via Messages\';'), (r) => r.H5false.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
