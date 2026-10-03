#!/usr/bin/env node
'use strict';
/* AdminOS Sports review queue (owner 2026-10-03)
     P1  admin-os.html: one Sports nav entry, one panel-sports, module after sokoni-aos.js; sokoni-aos.js untouched
     P2  the ONLY server call is sportsDispatch with ops admin.queue / admin.teamDecide / admin.tournamentDecide; no Firestore
         writes from the browser
     P3  reject requires a reason; a failed load says it is NOT an empty queue
     P4  rendering (real cards): every field escaped; paid tournaments say payments are not live; under-review vs submitted
   node scripts/test-aos-sports.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-aos-sports.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };

ck('P1 one Sports nav entry + one panel-sports; module loaded after sokoni-aos.js', (HTML.match(/data-section="sports"/g) || []).length === 1
  && (HTML.match(/id="panel-sports"/g) || []).length === 1 && HTML.indexOf('src="sokoni-aos-sports.js"') > HTML.indexOf('src="sokoni-aos.js"'));
const ops = (SRC.match(/op: '([a-zA-Z.]+)'/g) || []).map((m) => m.slice(5, -1));
ck('P2 only sportsDispatch admin ops; no Firestore access', /httpsCallable\('sportsDispatch'\)/.test(SRC) && ops.length && ops.every((o) => ['admin.queue', 'admin.teamDecide', 'admin.tournamentDecide'].includes(o))
  && !/firestore\(\)/.test(SRC), ops);
ck('P3 reject requires a reason; error ≠ empty queue', /A reason is required to reject/.test(SRC) && /This is not an empty queue/.test(SRC));
const win = {}; const ctx = { window: win, document: { readyState: 'complete', getElementById: () => null, addEventListener () {} }, MutationObserver: function () { this.observe = () => {}; } };
vm.createContext(ctx); vm.runInContext(SRC, ctx);
const A = win.SokoniAOSSports;
const tc = A._teamCard({ id: 't1', name: '<script>x</script>FC', sport: 'football', ownerUid: 'u"1', captainUid: 'c1', status: 'submitted' });
const pc = A._tourCard({ id: 'r1', name: 'Cup', sport: 'football', organiserUid: 'o1', capacity: 8, entryFeeKES: 2000, regOpensAt: Date.parse('2026-11-01'), regClosesAt: Date.parse('2026-11-10'), startsAt: Date.parse('2026-11-15'), status: 'under_review' });
ck('P4a every field escaped', !/<script>x<\/script>/.test(tc) && /&lt;script&gt;/.test(tc) && /u&quot;1/.test(tc));
ck('P4b a paid tournament states payments are not live; under-review badge; no "Mark under review" button once under review',
  /payments not live yet/.test(pc) && /Under review/.test(pc) && !/Mark under review/.test(pc));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
