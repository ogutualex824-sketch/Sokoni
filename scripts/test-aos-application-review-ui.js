#!/usr/bin/env node
'use strict';
/* ============================================================================
   AdminOS Applications — review tools UI (applicationReview) — static contract (no browser)
     R1  wiring: per-row Claim/Release, Note, Archive/Unarchive, History through ONE delegated handler
     R2  the callable is applicationReview (own callable, not adminOsDispatch) with the contract payloads
     R3  decisions are untouched: applicationDecide / applicationReconcile calls and buttons unchanged,
         and the review code never calls them
     R4  no client writes to applications/* (no Firestore access in the module at all)
     R5  every server value reaching markup is escaped (helpers executed in a VM with hostile input)
     R6  archive is labelled a queue view; nothing is stored client-side (no localStorage)
   node scripts/test-aos-application-review-ui.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const AOS = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); } };
const between = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + 1); return i >= 0 && j > i ? s.slice(i, j) : ''; };
const mod = between(AOS, '// ── Applications (canonical applicationList', '// ── Bookings (canonical providerBookings');
const review = between(mod, '/* ── Review tools (applicationReview callable', '  function _findApp(id)');
const lift = (name) => { const m = mod.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}')); if (!m) throw new Error('not found: ' + name); return m[0]; };

ck('0 module and review block located', mod.length > 2000 && review.length > 2000);

/* R1 */
ck('R1 row renders review marks + review buttons + the history row', /_appProjection\(i\) \+ _appReviewMarks\(i\.id\) \+ '<\/td>'/.test(mod) &&
  /'<div class="app-acts app-review" aria-label="Review tools">' \+ _appReviewButtons\(i\.id\) \+ '<\/div><\/td>'/.test(mod) && /'<\/tr>' \+ _appHistoryRow\(i\.id\);/.test(mod));
ck('R1b the ONE delegated handler routes rv_history / rv_hide / claim-release-note-archive-unarchive',
  /if \(act === "rv_history"\) \{ _showAppHistory\(id\); return; \}/.test(mod) && /if \(act === "rv_hide"\) \{ delete _appHistOpen\[id\]; _loadApplications\(false\); return; \}/.test(mod) &&
  /\["rv_claim", "rv_release", "rv_note", "rv_archive", "rv_unarchive"\]\.includes\(act\)\) \{ _reviewApplication\(id, act\); return; \}/.test(mod) &&
  (mod.match(/document\.addEventListener\("click"/g) || []).length === 1);
ck('R1c review buttons carry ids in data attributes via _esc(); no inline handlers in the module',
  /const rb = \(act, label\) => '<button class="aos-btn-sm" data-app-act="' \+ act \+ '" data-app-id="' \+ _esc\(id\) \+ '">' \+ label \+ '<\/button>';/.test(review) && !/onclick=|on[a-z]+="/i.test(mod));

/* R2 */
const calls = [...review.matchAll(/_call\("([A-Za-z]+)", ([^;]*?)\);/g)].map((m) => [m[1], m[2]]);
ck('R2 review code calls ONLY applicationReview', calls.length >= 5 && calls.every((c) => c[0] === 'applicationReview'), calls.map((c) => c[0]));
const want = [
  /takeOver \? \{ applicationId: id, action: "claim", takeOver: true \} : \{ applicationId: id, action: "claim" \}/,
  /\{ applicationId: id, action: "release" \}/,
  /\{ applicationId: id, action: "note", text: text\.slice\(0, 2000\) \}/,
  /\{ applicationId: id, action: act === "rv_archive" \? "archive" : "unarchive" \}/,
  /\{ applicationId: id, action: "history" \}/,
];
ck('R2b payloads: claim (takeOver only after an explicit confirm), release, note{text}, archive|unarchive, history',
  want.every((re) => re.test(review)) && /if \(takeOver && !confirm\(/.test(review), want.filter((re) => !re.test(review)).map(String));
ck('R2c applicationReview is its own callable — NOT routed through adminOsDispatch', !/'applicationReview'/.test(between(AOS, '_ADMIN_OS_OPS', ']);')));
ck('R2d a refusal is never shown as success ("Not done: <server message>")', /_toast\("Not done: " \+ \(e && e\.message \|\| "server refused"\), "error"\);/.test(review));

/* R3 */
ck('R3 decisions unchanged: applicationDecide payload + the four decisions + reconcile', /_call\("applicationDecide", \{ applicationId: id, decision, reason \}\)/.test(mod) &&
  /\["approve", "reject", "suspend", "request_info"\]\.includes\(act\)/.test(mod) && /_call\("applicationReconcile", \{ applicationId: id \}\)/.test(mod) &&
  (mod.match(/_call\("applicationDecide"/g) || []).length === 1);
const reviewCode = review.replace(/\/\*[\s\S]*?\*\//g, '');
ck('R3b review code never calls applicationDecide / applicationReconcile / _decideApplication', reviewCode.length > 2000 && !/applicationDecide|applicationReconcile|_decideApplication\(/.test(reviewCode));

/* R4 */
const FS_WRITE = /_db\.|collection\(|\.set\(|\.update\(|\.add\(|setDoc|updateDoc|addDoc|firestore\(/;
ck('R4 no Firestore access anywhere in the Applications module (server writes applicationReviews/* only)', !FS_WRITE.test(mod));
ck('R4b control: the detector catches a direct applications write', FS_WRITE.test(review + '_db.collection("applications").doc(id).update({status:"approved"})'));

/* R5 — run the real render helpers with hostile values */
const ctx = { _currentUser: { uid: 'me' }, _spinner: () => '<div class="aos-spinner"></div>' };
vm.createContext(ctx);
vm.runInContext(AOS.match(/function _esc\(s\) \{[\s\S]*?\n  \}/)[0] + '\n' +
  'const _appReview = {}; const _appHist = {}; const _appHistOpen = {};\n' +
  between(review, 'const _APP_EVENT_WORD', 'function _appWho') + '\n' +
  ['_appWho', '_appWhen', '_appReviewMarks', '_appReviewButtons', '_appHistoryRow'].map(lift).join('\n') +
  '\nthis.R=_appReview; this.H=_appHist; this.O=_appHistOpen; this.marks=_appReviewMarks; this.btns=_appReviewButtons; this.hist=_appHistoryRow;', ctx);
const EVIL = '"><img src=x onerror=alert(1)><script>x</script>';
ctx.R['a1'] = { reviewerUid: EVIL, archived: true };
ctx.R['a2'] = { reviewerUid: 'me', archived: false };
ctx.O['a1'] = true; ctx.H['a1'] = { notes: [{ text: EVIL, by: EVIL, at: 1700000000000 }], events: [{ action: EVIL, by: 'me', reason: EVIL, at: 1700000000000 }] };
const outA = ctx.marks('a1') + ctx.btns('a1') + ctx.hist('a1') + ctx.btns('a1"x');
const outB = ctx.marks('a2') + ctx.btns('a2');
ck('R5 hostile reviewer uid / note text / event action+reason / id are escaped (no live tag, no attribute breakout)',
  !/<img|<script/i.test(outA) && /&lt;img src=x/.test(outA) && /&lt;script&gt;/.test(outA) && /data-app-id="a1&quot;x"/.test(outA), outA.slice(0, 300));
ck('R5b state words: own claim → "Reviewer: you" + Release; other reviewer → Take over; archived → Unarchive + "queue view"',
  /Reviewer: you/.test(outB) && /data-app-act="rv_release"/.test(outB) && /data-app-act="rv_archive"/.test(outB) &&
  /data-app-act="rv_claim" data-app-id="a1">Take over/.test(outA) && /data-app-act="rv_unarchive"/.test(outA) && /Archived \(queue view — status unchanged\)/.test(outA));
ck('R5c history row: notes labelled admin-only; unknown time renders —; loading shows a spinner, an error is said, not hidden',
  /Internal notes<\/strong> <span class="app-sub">\(admins only — never shown to the applicant\)/.test(outA) &&
  (() => { ctx.O['z'] = true; ctx.H['z'] = null; const l = ctx.hist('z'); ctx.H['z'] = { error: '<b>x</b>' }; const e = ctx.hist('z'); ctx.H['z'] = { notes: [{ text: 't', by: 'u', at: null }], events: [] }; const n = ctx.hist('z');
    return /aos-spinner/.test(l) && /Couldn.t load history — &lt;b&gt;x&lt;\/b&gt;/.test(e) && /<span class="app-sub">— · u<\/span>/.test(n) && /No events recorded/.test(n); })());

/* R6 */
ck('R6 nothing stored client-side; review state is only what the server answered this session',
  !/localStorage|sessionStorage/.test(review) && /const _appReview = \{\};/.test(review) && /if \(r && r\.review\) _appReview\[id\] = \{ reviewerUid: r\.review\.reviewerUid \|\| null, archived: r\.review\.archived === true \};/.test(review));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
