'use strict';
/* Sabotage proof for functions/reviews.js (hub review types + unboxing photo quarantine), sokoni-5b 2026-10-03.
   Each mutation breaks ONE control; it is CAUGHT only when its NAMED row fails in a run that reached its RESULT line.
   A mutation whose anchor is missing is UNPROVEN (not applied), and a crash is UNPROVEN (no verdict) — never CAUGHT.
   The file is restored after every mutation, including on a crash.
     node scripts/sabotage-review-authority.js        (run with the repo QUIESCENT — it edits functions/reviews.js) */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'reviews.js');
const ORIG = fs.readFileSync(F, 'utf8');
const M = [
  ['eligibility always satisfied', "return hit ? a.collection + '/' + hit.id : null;", "return a.collection + '/x';", 'H-2'],
  ['cancelled viewing counts', "return st !== 'cancelled' && st !== 'canceled';", 'return true;', 'H-3'],
  ['hub target not namespaced', 'const storeTarget = hub ? _targetKey(targetType, targetId) : targetId;', 'const storeTarget = targetId;', 'H-11'],
  ['hub review published on write', '    status:  "pending",', '    status:  hub ? "approved" : "pending",', 'H-8'],
  ['hub owner may moderate', 'if (os.exists && String((os.data() || {})[o.field] || "") === req.auth.uid) {', 'if (false) {', 'H-9'],
  ['hub body length unchecked', 'if (hub && (typeof body !== "string"', 'if (false && (typeof body !== "string"', 'H-7'],
  ['public unboxing path accepted', "o/unboxing-pending%2F' + uid", "o/unboxing(?:-pending)?%2F' + uid", 'U-5b'],
  ['failed copy publishes private URLs', 'return await ref.update({ publicImages: [], photoCopyFailed: true })', 'return await ref.update({ publicImages: r.images, photoCopyFailed: true })', 'U-12'],
  ['public copy kept after removal', 'await storage.bucket(bp.slice(0, i)).file(bp.slice(i + 1)).delete().catch(() => {});', 'void i;', 'U-11'],
  ["another user's file copied", "if (!o || o.uid !== String(r.uid || '')) continue;", 'if (!o) continue;', 'U-13'],
];
const rows = [];
try {
  for (const [name, find, repl, row] of M) {
    if (ORIG.split(find).length !== 2) { rows.push([name, row + ' FAILS', 'anchor not found / not unique', '—', 'UNPROVEN']); continue; }
    fs.writeFileSync(F, ORIG.replace(find, repl));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-review-authority.js')], { encoding: 'utf8', timeout: 120000 });
    fs.writeFileSync(F, ORIG);
    const out = (r.stdout || '') + (r.stderr || '');
    const done = /RESULT: \d+ passed, \d+ failed/.test(out);
    const failed = new RegExp('^\\s*FAIL ' + row.replace('-', '\\-') + ' ', 'm').test(out);
    rows.push([name, row + ' FAILS', !done ? 'crash / no RESULT' : (failed ? row + ' FAILED' : row + ' passed'), row, !done ? 'UNPROVEN' : (failed ? 'CAUGHT' : 'MISSED')]);
  }
} finally { fs.writeFileSync(F, ORIG); }
console.log('\nSabotage — review authority\n');
console.log('  MUTATION                              | EXPECTED     | ACTUAL              | ASSERTION | RESULT');
rows.forEach((x) => console.log('  ' + x[0].padEnd(38) + '| ' + x[1].padEnd(13) + '| ' + x[2].padEnd(20) + '| ' + x[3].padEnd(10) + '| ' + x[4]));
const caught = rows.filter((x) => x[4] === 'CAUGHT').length;
console.log('\nSABOTAGE: ' + caught + '/' + rows.length + ' caught' + (fs.readFileSync(F, 'utf8') === ORIG ? '' : '   !! FILE NOT RESTORED'));
process.exit(caught === rows.length ? 0 : 1);
