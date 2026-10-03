'use strict';
/* Review approval — the screens (owner 2026-10-01: every review approved in AdminOS before it is public).
     node scripts/test-review-approval-ui.js        BASE=72dca56 node scripts/test-review-approval-ui.js (must FAIL) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
console.log('\nReview approval UI   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const aos = code(read('sokoni-aos.js'));
const panel = (aos.match(/\} else if \(tab === "reviews"\) \{[\s\S]*?\n    \}\n  \}/) || [''])[0];
ck('A-1', /_call\("adminGetReviews", \{ kind: kd, status: st, limit: 30, cursor:/.test(panel), 'the AdminOS queue loads by STATUS with a cursor (pending by default)');
ck('A-2', /catch \(e\) \{ body\.innerHTML = _emptyMsg\("Couldn't load the review queue/.test(panel) && !/\.catch\(\(\) => \(\{ reviews: \[\] \}\)\)/.test(panel), 'a failed load says so — never a fake "no reviews pending"');
ck('A-3', ['approve', 'reject', 'request_changes', 'archive', 'remove', 'restore'].every((k) => panel.indexOf(k + ':') > 0 || panel.indexOf(k + ':[') > 0), 'every server action (approve / reject / request changes / archive / remove / restore) is offered by state');
ck('A-4', /SokoniAOS\.reviewHistory\(/.test(panel) && /'adminGetReviewHistory'/.test(aos) && /_call\("adminGetReviewHistory"/.test(aos), 'each review\'s moderation history opens from the queue (routed via adminOsDispatch)');
ck('A-5', /if \(action === "reject" \|\| action === "remove" \|\| action === "request_changes"\)[\s\S]{0,300}A reason is required/.test(aos), 'reject / remove / request-changes require a reason (kept in the history)');
ck('A-6', /res && res\.unchanged \? "No change/.test(aos), 'the toast reports the SERVER\'s state (incl. "no change"), not the button pressed');
const biz = read('business.html');
ck('B-1', /_res\.data\.status === 'approved'/.test(biz) && /awaiting approval/.test(biz) && !/showToast\('Review submitted — thank you!'\)/.test(biz), 'the shop page says the review is AWAITING APPROVAL, never that it is published');
const rv = read('reviews.html');
ck('B-2', !/showNotif\("Review submitted! Thank you ⭐","success"\)/.test(rv) && /Saved on this device only/.test(rv), 'reviews.html no longer claims a device-only testimonial was submitted');
/* UNBOXING (owner 2026-10-01/03) */
const ub = read('unboxing.html'), ubc = code(ub);
const allR = (ubc.match(/function allReviews\(\)\{[\s\S]*?\n\}/) || [''])[0];
ck('U-1', !/DEMO/.test(allR) && !/getReviews\(\)/.test(allR) && /status==='approved'/.test(allR), 'the wall shows SERVER-APPROVED posts only — no made-up sample posts, no device-only copies');
ck('U-2', /httpsCallable\('submitUnboxing'\)/.test(ubc) && !/SokoniDB\.saveUnboxingReview\(/.test(ubc), 'the form submits through submitUnboxing (no direct browser write)');
ck('U-3', !/u\.points=\(u\.points\|\|0\)\+50/.test(ubc) && !/\+50 loyalty points/.test(ub), 'no invented loyalty points (browser-written +50) and no promise of them');
ck('U-4', /will appear once SOKONI approves it/.test(ubc) && !/Review posted!/.test(ubc), 'success says it awaits approval — never "posted"');
ck('U-5', /id="dropZone" hidden/.test(ub), 'the photo picker is hidden until photos can actually be uploaded');
const db = read('sokoni-db.js');
ck('U-6', /query\(collection\(db, 'unboxingReviews'\), where\('status', '==', 'approved'\), limit\(100\)\)/.test(db), 'the public wall listener asks for APPROVED posts (the rules refuse an unconstrained query)');
ck('U-7', /SokoniAOS\.reviewQueue\('\$\{_esc\(st\)\}', null, '\$\{k\}'\)/.test(aos) && /kind: _revState\.kind, reviewId: id/.test(aos) && /kind: kd, status: st/.test(aos), 'AdminOS switches Reviews | Unboxing; list and moderation carry the kind');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
