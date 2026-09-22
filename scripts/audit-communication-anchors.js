#!/usr/bin/env node
/* Anchor coverage across every notification call site — MEASURED, not estimated.
 *
 *   node scripts/audit-communication-anchors.js
 *   node scripts/audit-communication-anchors.js --json
 *
 * WHY THIS EXISTS
 * ---------------
 * A unified business timeline is worth exactly as much as its anchor coverage. Without an
 * anchor a communication cannot be tied to the order it was about, so it never appears in the
 * history an operator searches — and the timeline reads as quiet rather than incomplete.
 *
 * "Most call sites are wired" is not a measurement. This script counts them, names each one,
 * and refuses to average away the two facts that matter:
 *
 *   1. which call sites reach the ONE notification engine, and of those, which pass an anchor
 *   2. which modules BYPASS it entirely with a notifier of their own
 *
 * THE SECOND FINDING IS THE IMPORTANT ONE. `notify.js` calls itself "ONE entry point for every
 * message SOKONI sends", and its header records that fragmentation had already produced a
 * silent production failure. Adding an anchor to notify.js does nothing for a module that
 * never calls it — so a coverage number computed only over notify.js callers would be
 * flattering and wrong.
 *
 * NOT EVERY EVENT HAS AN ANCHOR, and inventing one to raise a percentage is worse than a low
 * percentage. A welcome message is genuinely context-free. This script therefore reports three
 * buckets — anchored, anchorable-but-unwired, and context-free — and never scores the third as
 * a failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const JSON_OUT = process.argv.includes('--json');

/** Strip comments so prose about `anchorType` is never counted as a call site passing one. */
function strip(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && nx === '/') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* Events that genuinely have no business object. Listed explicitly so "context-free" is a
   DECISION someone made and can be argued with, not a shrug. */
const CONTEXT_FREE = Object.freeze({
  welcome: 'a welcome message is about the account existing, not about any transaction',
  otp: 'an OTP is about this login attempt; there is no business object yet',
  phone_verification: 'same as OTP',
  password_reset: 'an account security event, not a transaction',
  login_alert: 'an account security event, not a transaction',
  admin_alert: 'a platform operations alert; its subject is not a customer relationship',
  subscription_expiring: 'about the plan, which is not one of the approved anchors',
  subscription_expired: 'about the plan',
  subscription_activated: 'about the plan',
  seller_verified: 'about the account',
  merchant_approved: 'about the account',
});

const files = fs.readdirSync(FUNCTIONS)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => f !== 'notify.js');

const report = {
  engineCallers: [],     /* files that reach notify.js */
  anchored: [],          /* …and pass an anchor */
  unwired: [],           /* …and do not */
  localNotifiers: [],    /* files with their OWN notifier — they bypass the engine entirely */
  contextFreeTypes: Object.keys(CONTEXT_FREE),
};

for (const f of files) {
  const abs = path.join(FUNCTIONS, f);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
  const code = strip(src);

  const usesEngine = /require\(['"]\.\/notify['"]\)/.test(code);

  /* A LOCAL notifier: a module-level function that sends notifications itself. These bypass
     the one engine, so no anchor added to notify.js reaches them.
     THE NAME IS `_notify` IN PRACTICE, not `notify` — the first draft of this detector looked
     for the wrong one, found nothing, and reported five modules as compliant. A detector that
     cannot match is indistinguishable from an absence, which is why the control below exists. */
  const localDecl = /(?:^|\n)\s*(?:async\s+)?function\s+_?notify\s*\(/.test(code);

  if (localDecl) {
    /* Calls to the LOCAL helper — `_notify(` or a bare `notify(` that is not `x.notify(`.
       Counted so the size of the bypass is measured rather than described as "some". */
    const uses = (code.match(/(?<![.\w])_?notify\s*\(/g) || []).length;
    report.localNotifiers.push({ file: f, uses, alsoUsesEngine: usesEngine });
  }

  if (!usesEngine) continue;

  report.engineCallers.push(f);
  /* Does any call in this file pass an anchor? Measured on the stripped source, so the
     comment in connect-notify explaining anchors does not count as passing one. */
  const passesAnchor = /anchorType\s*:/.test(code) && /anchorId\s*:/.test(code);
  (passesAnchor ? report.anchored : report.unwired).push(f);
}

/* ── POSITIVE CONTROL ─────────────────────────────────────────────────────────────────────
 * These five modules were confirmed BY HAND to declare their own `_notify` helper. If the
 * detector cannot find them, it cannot find anything, and a clean report would mean "the
 * regex is wrong" rather than "the platform is compliant" — the single most dangerous result
 * an audit can produce. So the control runs first and the audit REFUSES to report without it.
 */
const MUST_DETECT = ['automation-engine.js', 'financial-os.js', 'franchise-engine.js',
  'installments.js', 'loyalty.js'];
const detected = report.localNotifiers.map((m) => m.file);
const controlMissed = MUST_DETECT.filter((f) => !detected.includes(f));
if (controlMissed.length) {
  console.error('\nDETECTOR CONTROL FAILED — these are known to declare a local notifier and');
  console.error('were not found: ' + controlMissed.join(', '));
  console.error('The coverage numbers below would be false. Fix the detector before trusting it.\n');
  process.exit(1);
}

/* ── Output ──────────────────────────────────────────────────────────────────────────────── */
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (a, b) => (b === 0 ? '—' : Math.round((a / b) * 100) + '%');

console.log('\nSOKONI Communication Engine — anchor coverage\n');
console.log('  Files reaching the one notification engine : ' + report.engineCallers.length);
console.log('  …passing a business anchor                 : ' + report.anchored.length +
  '  (' + pct(report.anchored.length, report.engineCallers.length) + ')');
console.log('  …not yet passing one                       : ' + report.unwired.length);

console.log('\nANCHORED');
report.anchored.forEach((f) => console.log('  ✓ ' + f));
if (!report.anchored.length) console.log('  (none)');

console.log('\nNOT YET ANCHORED — each needs two lines, or a stated reason it cannot have one');
report.unwired.forEach((f) => console.log('  · ' + f));
if (!report.unwired.length) console.log('  (none)');

console.log('\nMODULES WITH THEIR OWN NOTIFIER — these BYPASS the engine entirely');
console.log('  An anchor added to notify.js does NOTHING for these. They are the real ceiling');
console.log('  on coverage, and `notify.js` already records that this exact fragmentation once');
console.log('  produced a silent production failure.\n');
if (report.localNotifiers.length) {
  report.localNotifiers.forEach((m) => console.log('  ! ' + m.file.padEnd(34) +
    m.uses + ' call(s)' + (m.alsoUsesEngine ? '   (also uses the engine)' : '')));
} else {
  console.log('  (none — every notification goes through the one engine)');
}

console.log('\nCONTEXT-FREE BY DESIGN — never anchor these to raise a number');
report.contextFreeTypes.forEach((t) => console.log('  – ' + t.padEnd(24) + CONTEXT_FREE[t]));

console.log('\n' + '─'.repeat(76));
console.log('Coverage over ENGINE CALLERS is not coverage over SOKONI. The modules listed');
console.log('above with their own notifier are outside it, and no anchor reaches them until');
console.log('they call the engine. Report both numbers or neither.');
console.log('');

/* Read-only. Exits 0 always: this is a MEASUREMENT, and a measurement that fails a build
   teaches people to stop running it. */
process.exit(0);
