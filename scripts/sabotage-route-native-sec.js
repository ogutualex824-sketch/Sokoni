/* Sabotage runner for the kind-vs-sec contract.
   The invariant under test:
       kind controls the current surface; sec may exist only as compatibility vocabulary
       on a route the shell actually mounts through the legacy shell, and it must NEVER
       override native routing.
   Every edit asserts it matched exactly once; every verdict is the EXIT CODE. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SUITES = ['scripts/test-route-native-sec-contract.js', 'scripts/test-merchant-routes.js'];

const CASES = [
  /* ── kind must decide the surface ───────────────────────────────────────── */
  ['Products stops being native (kind -> seller)', 'sokoni-merchant-routes.js',
   "    { id:'products', name:'Products', icon:'🏷️', tier:'primary',\n      kind:'native',",
   "    { id:'products', name:'Products', icon:'🏷️', tier:'primary',\n      kind:'seller', sec:'products',"],

  ['Receipts stops being native', 'sokoni-merchant-routes.js',
   "      kind:'native',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],\n      mobile:true, desktop:true, activeKey:'receipts' },",
   "      kind:'seller', sec:'receipts',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],\n      mobile:true, desktop:true, activeKey:'receipts' },"],

  ['Flash Sale stops being native', 'sokoni-merchant-routes.js',
   "      kind:'native',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],\n      mobile:true, desktop:true, activeKey:'flash-sale' },",
   "      kind:'seller', sec:'flash',\n      role:['seller','merchant'], ctx:[CTX.SELLER_UID, CTX.SHOP_ID],\n      mobile:true, desktop:true, activeKey:'flash-sale' },"],

  /* ── sec must never win over kind ───────────────────────────────────────── */
  ['sec wins: the shell mounts seller.html whenever sec exists', 'merchant-v2.html',
   "    if (m.kind === 'seller') { showOnly(framePanel('seller:' + (m.sec || ''), 'seller.html' + (m.sec ? '#' + m.sec : ''), m.name)); return; }",
   "    if (m.sec) { showOnly(framePanel('seller:' + (m.sec || ''), 'seller.html' + (m.sec ? '#' + m.sec : ''), m.name)); return; }"],

  /* ── inbound compatibility is carried by ids and aliases ────────────────── */
  ['the flash alias is removed (old ?sec=flash bookmarks)', 'sokoni-merchant-routes.js',
   "    flash:       'flash-sale'\n  };", "  };"],

  ['an unknown route silently falls back instead of refusing', 'merchant-v2.html',
   "      console.error('[merchant-v2] unknown route \"' + id + '\" — not in the contract. Refused.');\n      return;",
   "      rid = 'dashboard';"],

  /* ── a genuinely legacy route must KEEP its sec ─────────────────────────── */
  ['a kind:seller route loses its sec', 'sokoni-merchant-routes.js',
   "      kind:'seller', sec:'stories',", "      kind:'seller',"],

  /* ── the contract rule itself must not be weakened ──────────────────────── */
  ['the native/sec rule is deleted from the validator', 'sokoni-merchant-routes.js',
   "      if (r.kind === 'native' && (r.src || r.sec || r.tab))\n        errs.push(at + ': native route must not declare src/sec/tab');",
   "      /* rule removed */"],

  ['the action-owner rule is deleted', 'sokoni-merchant-routes.js',
   "      if (byId[id] && a.owner === 'seller' && byId[id].kind !== 'seller')",
   "      if (false && a.owner === 'seller' && byId[id].kind !== 'seller')"],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ')');
    missed++; continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));

  let worst = 0; const detail = [];
  for (const suite of SUITES) {
    let code = 0, out = '';
    try { out = execFileSync(process.execPath, [suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
    const fails = (out.match(/^ {2}FAIL/gm) || []).length;
    if (code !== 0) worst = 1;
    detail.push(path.basename(suite, '.js').replace('test-', '').replace('route-native-sec-contract', 'sec')
      + '(' + code + ',f' + fails + (/^ {2}aborted/m.test(out) ? ',ab' : '') + ')');
  }
  fs.writeFileSync(p, orig);

  console.log('  ' + (worst ? 'CAUGHT ' : 'MISSED ') + label.padEnd(52) + detail.join(' '));
  if (worst) caught++; else missed++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
