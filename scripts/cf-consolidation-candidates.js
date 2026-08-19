/* ══════════════════════════════════════════════════════════════════════════════
   CF CONSOLIDATION CANDIDATES — ranked by value and blast radius
   ══════════════════════════════════════════════════════════════════════════════
   The architecture gate demands ~212 fewer exports. Which ones is not a matter
   of taste:

     * Triggers CANNOT be dispatched. onDocumentWritten/onSchedule/onRequest each
       bind to their own event; collapsing them is not available. Only onCall
       functions can move behind a dispatcher, which is the pattern this repo
       already uses (13 domain dispatchers).
     * Every dispatched op must STOP being individually exported (the
       "no dispatched op double-exported" invariant), so each consolidation
       breaks any client still calling the old name directly. Client call sites
       are therefore the blast radius, and the ranking is by them.

   READ ONLY. Reports; changes nothing.

     node scripts/cf-consolidation-candidates.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

/* ── every client call site, once ─────────────────────────────────────────── */
const CALL_RE = [
  /httpsCallable\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /sokoniCallable\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /\bCF\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /callable\(\s*['"]([A-Za-z0-9_]+)['"]/g,
];
const callSites = {};
(function walk(d) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
  for (const x of e) {
    if (x.name === 'node_modules' || x.name === '.git' || x.name === 'functions') continue;
    const p = path.join(d, x.name);
    if (x.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html|mjs)$/.test(x.name)) continue;
    let s; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    for (const re of CALL_RE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        (callSites[m[1]] = callSites[m[1]] || new Set())
          .add(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    }
  }
})(ROOT);

/* ── classify each module's exports by kind ───────────────────────────────── */
const KIND = [
  { re: /onCall\s*\(/,            k: 'onCall' },
  { re: /onDocument[A-Za-z]*\s*\(/, k: 'trigger' },
  { re: /onSchedule\s*\(/,        k: 'schedule' },
  { re: /onRequest\s*\(/,         k: 'http' },
  { re: /onObject[A-Za-z]*\s*\(/, k: 'storage' },
];

const files = fs.readdirSync(FN).filter((f) => /\.js$/.test(f));
const report = [];

for (const f of files) {
  let src; try { src = fs.readFileSync(path.join(FN, f), 'utf8'); } catch (_) { continue; }
  const counts = { onCall: 0, trigger: 0, schedule: 0, http: 0, storage: 0, other: 0 };
  const onCallNames = [];

  const re = /^\s*(?:exports\.([A-Za-z0-9_]+)\s*=|const\s+([A-Za-z0-9_]+)\s*=)\s*(on[A-Za-z]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[2];
    const ctor = m[3];
    const kind = (KIND.find((k) => k.re.test(ctor + '(')) || { k: 'other' }).k;
    counts[kind]++;
    if (kind === 'onCall') onCallNames.push(name);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) continue;

  const sites = new Set();
  let calledNames = 0;
  for (const n of onCallNames) {
    if (callSites[n]) { calledNames++; callSites[n].forEach((s) => sites.add(s)); }
  }

  report.push({
    file: f.replace(/\.js$/, ''),
    total, onCall: counts.onCall, trigger: counts.trigger,
    schedule: counts.schedule, http: counts.http, storage: counts.storage,
    calledNames, sites: sites.size,
  });
}

/* Value = onCall count (what can move). Cost = distinct client files to edit. */
report.sort((a, b) => (b.onCall - a.onCall) || (a.sites - b.sites));

console.log('\nCF CONSOLIDATION CANDIDATES');
console.log('='.repeat(84));
console.log('  Only onCall can move behind a dispatcher. "client files" is the blast radius:');
console.log('  every one must be edited in the same change, or the call breaks.\n');
console.log('  ' + 'MODULE'.padEnd(30) + 'onCall  trig  sched  http |  called  client files');
console.log('  ' + '-'.repeat(78));

let dispatchable = 0, untouchable = 0;
for (const r of report.slice(0, 30)) {
  console.log('  ' + r.file.padEnd(30) +
    String(r.onCall).padStart(6) + String(r.trigger).padStart(6) +
    String(r.schedule).padStart(7) + String(r.http).padStart(6) + ' |' +
    String(r.calledNames).padStart(8) + String(r.sites).padStart(14));
}
for (const r of report) { dispatchable += r.onCall; untouchable += r.trigger + r.schedule + r.http + r.storage; }

console.log('');
console.log('  onCall across ALL modules (dispatchable)     : ' + dispatchable);
console.log('  triggers/schedules/http (CANNOT consolidate) : ' + untouchable);
console.log('  target reduction                             : 212');
console.log('='.repeat(84) + '\n');
