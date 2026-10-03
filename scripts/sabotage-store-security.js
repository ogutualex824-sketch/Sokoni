#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'store.html');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['drafts listed', "const _listable = p => !!(window.SokoniSellability", "const _listable = p => true || !!(window.SokoniSellability", 'D-1'],
  ['review comment raw', '<div class="st-review-comment">"${_esc(r.comment)}"</div>', '<div class="st-review-comment">"${r.comment}"</div>', 'X-1'],
  ['any URL allowed', "if (/^https?:\\/\\/[^\\s\"'<>`]+$/i.test(v)", "if (true || /^https?:\\/\\/[^\\s\"'<>`]+$/i.test(v)", 'X-1'],
  ['collection name raw', "'<span class=\"st-collection-name\">' + _esc(cat) + '</span>'", "'<span class=\"st-collection-name\">' + cat + '</span>'", 'X-1'],
  ['FS product name raw', "+ '<div class=\"st-product-name\">' + _esc(p.name||\"\") + '</div>'", "+ '<div class=\"st-product-name\">' + (p.name||\"\") + '</div>'", 'X-1'],
  ['hours raw', "'\">' + _esc(h) + \"</span>\"", "'\">' + h + \"</span>\"", 'X-1'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR x' + (O.split(a).length - 1) + '  ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-store-security.js')], { encoding: 'utf8' });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(',') + (ok ? '' : ' (exit ' + r.status + ')'));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
/* EQUIVALENT MUTANT (recorded, NOT counted as caught): dropping the https pre-check on store.website changes nothing
   observable — _safeUrl still refuses javascript:/data:/vbscript: and yields href="". Defense in depth, not a guard a
   test can isolate. */
console.log('EQUIVALENT (not counted): website https pre-check — _safeUrl already refuses the scheme');
process.exit(c === M.length ? 0 : 1);
