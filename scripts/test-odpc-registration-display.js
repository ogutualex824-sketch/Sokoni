/* test-odpc-registration-display.js — the ODPC certificate is shown as exactly what it proves.
 *
 *   node scripts/test-odpc-registration-display.js     (no browser, no network)
 *
 * 2026-10-01 owner: show the ODPC registration in the Trust / Privacy & Legal area as a DATA PROCESSOR
 * registration, linked from the footer and the Privacy Notice; do NOT change the "Data Controller" wording (a legal
 * decision on the controller role is pending), and never present the processor certificate as a controller one.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const LEGAL = read('legal.html'), PRIV = read('privacy.html'), HOME = read('index.html');
const visible = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

console.log('\nODPC REGISTRATION — displayed as what it proves');
console.log('='.repeat(70));
const sec = (/<h2 id="regulatory-registration">[\s\S]*?<h2>/.exec(LEGAL) || [''])[0];
ck('legal.html has the Data Protection & Regulatory Registration section', /Data Protection &amp; Regulatory Registration/.test(sec));
for (const [label, re] of [
  ['registered with the ODPC, Kenya', /Office of the Data Protection Commissioner \(ODPC\), Kenya/],
  ['entity: Bravilex International Co. Limited', /Registered entity:<\/strong> Bravilex International Co\. Limited/],
  ['capacity: Data Processor', /Registered capacity:<\/strong> Data Processor/],
  ['identification 630-8669-F056', /Identification:<\/strong> 630-8669-F056/],
  ['serial 24670', /Certificate serial:<\/strong> 24670/],
  ['valid 28 July 2026 – 28 July 2028', /Valid:<\/strong> 28 July 2026 – 28 July 2028/],
]) ck('certificate field — ' + label, re.test(sec));
ck('the section never calls the registration a controller registration', !/Registered capacity:<\/strong>[^<]*Controller/i.test(sec) && !/registered as (a )?(data )?controller/i.test(visible(sec)));
ck('it states plainly that controllers and processors are registered separately', /registers data controllers and data processors separately/.test(sec));

/* the controller wording is untouched — compared against the committed baseline (HEAD) */
function headOf(f) { try { return cp.execFileSync('git', ['show', 'HEAD:' + f], { cwd: ROOT, encoding: 'utf8' }); } catch (_) { return null; } }
const baseLines = (s) => (s || '').split(/\r?\n/).filter((l) => /Data Controller/.test(l) && !/^\s*(<!--|-->)|registration|ODPC REGISTRATION|controller role/.test(l)).map((l) => l.trim());
for (const f of ['privacy.html', 'legal.html']) {
  const now = baseLines(visible(read(f))), was = baseLines(visible(headOf(f) || read(f)));
  ck(f + ': every visible "Data Controller" line is exactly as it was', was.length > 0 && was.every((l) => now.indexOf(l) >= 0) && now.length === was.length, JSON.stringify({ was, now }));
}

ck('Privacy Notice links to the registration', /<strong>ODPC registration:<\/strong> <a href="legal\.html#regulatory-registration">Data Processor registration details<\/a>/.test(PRIV));
ck('home footer links to the registration', /<a href="legal\.html#regulatory-registration">🏛️ Data Protection Registration<\/a>/.test(HOME));

/* the hash handler: #regulatory-registration opens the Data Protection tab; a crafted fragment cannot throw */
const handler = (/\/\* Handle URL hash[\s\S]*?\n\}\n/.exec(LEGAL) || [''])[0];
function runHash(h) {
  const calls = []; let scrolled = null;
  const ctx = { window: { location: { hash: h } }, setTimeout: (f) => f(), showLegalTab: (t) => calls.push(t),
    document: { querySelector: (sel) => ({ sel }), getElementById: (id) => ({ scrollIntoView: () => { scrolled = id; } }) } };
  vm.createContext(ctx);
  let threw = null; try { vm.runInContext(handler, ctx); } catch (e) { threw = e.message; }
  return { calls, scrolled, threw };
}
let h = runHash('#regulatory-registration');
ck('#regulatory-registration opens the Data Protection tab and scrolls to the section', h.calls[0] === 'data' && h.scrolled === 'regulatory-registration' && !h.threw, JSON.stringify(h));
h = runHash('#privacy');
ck('#privacy still opens the Privacy tab', h.calls[0] === 'privacy' && !h.threw);
h = runHash('#x"],body,[a="');
ck('a crafted fragment is ignored (no selector injection, no throw)', h.calls.length === 0 && !h.threw, JSON.stringify(h));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
