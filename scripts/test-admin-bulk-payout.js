'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Regression — Admin OS bulk payout approval orchestrates the FROZEN wallet engine.
   Proves a BULK action ultimately invokes the SAME canonical processing path as a
   SINGLE approval (wallet.js `adminProcessPayout`), and never the retired
   `adminApprovePayouts` / deprecated `payouts` collection. This is the guard that
   keeps the wallet freeze honest: Admin OS ITERATES the engine, it does not bypass or
   duplicate it. Lifts the browser orchestration helper verbatim (same pattern as
   scripts/test-apps-render.js) and runs it against a mock callable.
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const aos     = fs.readFileSync(path.join(__dirname, '..', 'sokoni-aos.js'), 'utf8');
const adminOs = fs.readFileSync(path.join(__dirname, '..', 'functions', 'admin-os.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

/* Extract a top-level `async function NAME(...) { ... }` verbatim via brace matching. */
function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('function not found: ' + sig);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) { const c = src[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
  return src.slice(start, end);
}

const bulkSrc = extractFn(aos, 'async function _bulkApprovePayouts');
const _bulkApprovePayouts = new Function('return (' + bulkSrc + ')')();
const singleSrc = extractFn(aos, 'async function approvePayout');

(async () => {
  console.log('Admin OS bulk-payout orchestration');

  const calls = [];
  const mockCall = async (op, data) => { calls.push({ op: op, data: data }); if (data.requestId === 'PO_FAIL') throw new Error('gateway boom'); return { success: true }; };

  const res = await _bulkApprovePayouts(['PO_1', 'PO_2', 'PO_3'], mockCall);
  ok('bulk invokes the callable once per request', calls.length === 3);
  ok('every call routes to canonical adminProcessPayout (same op as single)', calls.every(c => c.op === 'adminProcessPayout'));
  ok('every call sends status="approved"', calls.every(c => c.data && c.data.status === 'approved'));
  ok('requestId param carries each id in order', calls.map(c => c.data.requestId).join(',') === 'PO_1,PO_2,PO_3');
  ok('bulk NEVER calls the retired adminApprovePayouts', !calls.some(c => c.op === 'adminApprovePayouts'));
  ok('summary counts successes', res.ok === 3 && res.total === 3 && res.failed.length === 0);

  calls.length = 0;
  const res2 = await _bulkApprovePayouts(['PO_1', 'PO_FAIL', 'PO_3'], mockCall);
  ok('one gateway failure does NOT abort the batch (per-item isolation)', res2.ok === 2 && res2.failed.length === 1 && res2.failed[0].id === 'PO_FAIL');
  ok('all three still attempted despite the middle failure', calls.length === 3);

  ok('SINGLE approvePayout uses the SAME canonical adminProcessPayout', /adminProcessPayout/.test(singleSrc) && /status:\s*"approved"/.test(singleSrc));
  ok('single approve does not touch the retired op', !/adminApprovePayouts/.test(singleSrc));
  ok('approveAllPayouts delegates to the tested orchestrator', /approveAllPayouts[\s\S]*?_bulkApprovePayouts\(ids,\s*_call\)/.test(aos));

  ok('retired op fully absent from sokoni-aos.js (whitelist + calls)', !/adminApprovePayouts/.test(aos));
  ok('server adminApprovePayouts export deleted', !/exports\.adminApprovePayouts\s*=/.test(adminOs));
  ok('deprecated `payouts`-collection write removed from admin-os.js', !/collection\('payouts'\)\.doc\(id\)/.test(adminOs));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
