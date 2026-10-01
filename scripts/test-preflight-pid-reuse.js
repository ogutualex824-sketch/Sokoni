/* test-preflight-pid-reuse.js — the preflight's own-ancestor walk must not trust a recycled Windows PID.
 *
 *   node scripts/test-preflight-pid-reuse.js        (no browser, no network)
 *
 * 2026-10-01: a recursive ParentProcessId walk elsewhere tonight terminated an unrelated VS Code helper because a
 * dead parent's id had been reused. The preflight's ancestor walk (added the same night so a deploy does not count
 * its own wrapper as a peer) has the same exposure in reverse: a reused id would HIDE a genuine peer as "mine".
 * The walk now stops at a "parent" created after its child. This pins the parse and the stop rule by executing the
 * same logic on a synthetic process table.
 */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'environment-preflight.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(d) + ']' : '')); ok ? pass++ : fail++; };
console.log('\nPREFLIGHT — ancestor walk vs PID reuse');
console.log('='.repeat(70));

ck('process rows keep a creation time', /created: \(function \(v\) \{ const m = \/\(\\d\{10,\}\)\/\.exec\(String\(v \|\| ''\)\); return m \? Number\(m\[1\]\) : null; \}\(r\.CreationDate\)\),/.test(SRC));
ck('the walk stops at a parent created after its child', /if \(up && up\.created != null && cur\.created != null && up\.created > cur\.created\) break;/.test(SRC));

/* the same parse + walk, executed */
const parse = (v) => { const m = /(\d{10,})/.exec(String(v || '')); return m ? Number(m[1]) : null; };
ck('parses ConvertTo-Json "/Date(ms)/"', parse('/Date(1790773880168)/') === 1790773880168 && parse(null) === null);
function walk(procs, startPpid) {
  const mine = new Set(); const byPid = new Map(procs.map((p) => [p.pid, p]));
  let cur = byPid.get(startPpid);
  for (let i = 0; cur && i < 32; i++) {
    mine.add(cur.pid);
    const up = byPid.get(cur.ppid);
    if (up && up.created != null && cur.created != null && up.created > cur.created) break;
    cur = up;
  }
  return mine;
}
/* deploy chain: firebase(10, t=100) → wrapper(20, t=200) → suite runner(30, t=300) → preflight's parent */
const chain = [{ pid: 10, ppid: 1, created: 100 }, { pid: 20, ppid: 10, created: 200 }, { pid: 30, ppid: 20, created: 300 }];
ck('a genuine ancestor chain is all "mine"', [10, 20, 30].every((p) => walk(chain, 30).has(p)));
/* the runner's real parent (pid 20) died; pid 20 was REUSED by a peer runner created later (t=900) */
const reused = [{ pid: 20, ppid: 7, created: 900 }, { pid: 30, ppid: 20, created: 300 }, { pid: 7, ppid: 1, created: 50 }];
const m = walk(reused, 30);
ck('a reused parent id (created after the child) is NOT hidden as mine — the peer stays visible', m.has(30) && !m.has(20) && !m.has(7), [...m]);
ck('control: without the creation-time rule the peer WOULD be hidden', (() => {
  const byPid = new Map(reused.map((p) => [p.pid, p])); const mm = new Set(); let c = byPid.get(30);
  for (let i = 0; c && i < 32; i++) { mm.add(c.pid); c = byPid.get(c.ppid); }
  return mm.has(20);
})());
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
