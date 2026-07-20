#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Architecture Guardian

   node scripts/architecture-guardian.js            report
   node scripts/architecture-guardian.js --gate     exit 1 on any CRITICAL
   node scripts/architecture-guardian.js --json

   EVERY RULE HERE ENCODES A DEFECT THAT ACTUALLY HAPPENED IN THIS REPOSITORY.

   That is deliberate. A guardian assembled from generic best practice produces
   a long list of theoretical violations and trains people to ignore it. Each
   rule below cites the incident that motivated it, so a failure is a claim of
   the form "this exact thing broke production before" rather than "a style
   guide disagrees".

   Rules are versioned. Adding one is cheap; changing what an existing ID means
   is not — downstream gates depend on the meaning being stable.
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GATE = process.argv.includes('--gate');
const JSON_OUT = process.argv.includes('--json');

const CRITICAL = 'CRITICAL', HIGH = 'HIGH', MEDIUM = 'MEDIUM';
const findings = [];
const results = [];
const rejected = [];

/* ── the compiler contract ───────────────────────────────────────────────────
   A rule may only run if architecture.manifest.json holds an incident record
   for it. This is the foundational principle made executable rather than
   aspirational: without it, "every rule traces to a real incident" is a claim
   in a comment that nothing checks, and the rule set silently fills with
   plausible-sounding additions over time.

   A rule without provenance is REJECTED, not merely warned about — and its
   rejection is reported, so removing evidence is as visible as adding a rule. */
let MANIFEST = { rules: {} };
try {
  MANIFEST = JSON.parse(fs.readFileSync('architecture.manifest.json', 'utf8'));
} catch (e) {
  console.error('\n  architecture.manifest.json is missing or unreadable — no rule can be trusted.');
  console.error('  ' + e.message + '\n');
  process.exit(2);
}

const REQUIRED_FIELDS = ['incidentId', 'date', 'rootCause', 'impact', 'evidence', 'risk'];

function rule(id, severity, title, incident, fn) {
  const prov = MANIFEST.rules[id];
  if (!prov) {
    rejected.push({ id, title, reason: 'no incident record in architecture.manifest.json' });
    return;
  }
  const missing = REQUIRED_FIELDS.filter((k) => !prov[k]);
  if (missing.length) {
    rejected.push({ id, title, reason: 'incomplete provenance — missing ' + missing.join(', ') });
    return;
  }

  let violations = [];
  let error = null;
  try { violations = fn() || []; } catch (e) { error = e.message; }

  /* A rule whose measured precision is below the manifest threshold may still
     run and report, but must not block a deploy. Noise that halts delivery is
     how a gate gets disabled wholesale. */
  const p = prov.precision || {};
  const noisy = typeof p.currentPrecision === 'number' &&
                p.currentPrecision < (MANIFEST.precisionPolicy || {}).noisyThreshold;

  results.push({ id, severity, title, incident, count: violations.length, error, noisy,
    incidentId: prov.incidentId, precision: p.currentPrecision });
  violations.forEach((v) => findings.push({ id, severity: noisy ? 'ADVISORY' : severity, title, ...v }));
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'Temp', 'coverage']);

function walk(dir, filter, out) {
  out = out || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(e.name)) out.push(p);
  }
  return out;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
const htmlFiles = () => walk('.', (n) => n.endsWith('.html'));
const fnFiles = () => walk('functions', (n) => n.endsWith('.js')).filter((p) => !/[\\/]test[\\/]/.test(p));

/* Strip comments before scanning. A fix comment that quotes the bug it fixed
   re-triggers the scanner otherwise — that happened, and produced a "defect"
   that was literally the description of its own repair.

   Comments are blanked, NOT removed: each is replaced by the same number of
   newlines it occupied. Collapsing a 20-line comment to one space shifts every
   line number after it, and the first run reported RULE-007 hits pointing at
   code that had nothing to do with the finding. A wrong line number in a gate
   report is worse than no line number — it sends people to the wrong file. */
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/^([ \t]*)\/\/.*$/gm, (m, indent) => indent + ' '.repeat(Math.max(0, m.length - indent.length)))
  .replace(/<!--[\s\S]*?-->/g, blank);

/* ══ RULE-001 — no hardcoded identity in an authorisation path ═════════════
   INCIDENT: bootstrapAdminClaim compared token.email to a hardcoded address.
   Phone sign-in carries no email claim, so the platform owner could never
   satisfy it and no administrator could ever be created. */
rule('RULE-001', CRITICAL, 'No hardcoded identity in authorisation',
  'bootstrapAdminClaim gated on a hardcoded email; phone accounts have no email claim',
  () => {
    /* The first version of this rule matched any line containing an identity
       AND the substring "admin". It produced four findings, all false:
       PLATFORM_ADMIN_EMAIL (a notification recipient), a console help string,
       and two adminWA WhatsApp contact numbers. Storing an address is not an
       authorisation decision — COMPARING one is.

       So the test is now a comparison against an identity taken from the
       auth token, which is the actual defect shape. */
    const out = [];
    const COMPARE = new RegExp(
      '(?:token|claims|auth|user|request|req)\\s*\\??\\.?[\\w.?]*\\b' +
      '(?:email|phone|phoneNumber|phone_number)\\b\\s*(?:===?|!==?)\\s*' +
      "['\"][^'\"]+['\"]" +
      '|' +
      "['\"][^'\"]+['\"]\\s*(?:===?|!==?)\\s*" +
      '(?:token|claims|auth|user|request|req)\\s*\\??\\.?[\\w.?]*\\b(?:email|phone|phoneNumber|phone_number)\\b'
    );
    for (const f of [...fnFiles(), ...htmlFiles()]) {
      const src = stripComments(read(f));
      src.split(/\r?\n/).forEach((line, i) => {
        if (!COMPARE.test(line)) return;
        out.push({ file: f, line: i + 1, detail: line.trim().slice(0, 110) });
      });
    }
    return out;
  });

/* ══ RULE-002 — search write target must equal read target ═════════════════
   INCIDENT: the indexer wrote products to `products_index` while the live
   search engine read `sokoni_products`. Every product indexed for months was
   unreachable. No error was raised anywhere. */
rule('RULE-002', CRITICAL, 'Search write index equals read index',
  'products written to products_index, read from sokoni_products — silently undiscoverable',
  () => {
    const idx = read('functions/algolia-indexer.js');
    const reg = read('functions/search-sync.js');
    const w = (idx.match(/products:\s*\{\s*index:\s*'([^']+)'/) || [])[1];
    const r = (reg.match(/algoliaIndex:\s*'([^']+)'/) || [])[1];
    if (!w || !r) return [{ file: 'functions/algolia-indexer.js', line: 0, detail: 'could not resolve index names' }];
    return w === r ? [] : [{
      file: 'functions/algolia-indexer.js', line: 0,
      detail: 'writes "' + w + '" but SEARCH_SYNC reads "' + r + '"',
    }];
  });

/* ══ RULE-003 — no guard on a claim nothing sets ═══════════════════════════
   INCIDENT: 24 guards across 11 modules tested token.isAdmin. Nothing has ever
   written that claim, so every one denied every caller — including real
   administrators — with a correct-looking permission-denied. */
rule('RULE-003', CRITICAL, 'No authorisation guard on an unwritten claim',
  '24 guards tested token.isAdmin, a claim nothing sets — they denied everyone',
  () => {
    const files = fnFiles();
    /* Which claim names are ever WRITTEN? */
    const written = new Set();
    for (const f of files) {
      const src = read(f);
      const m = src.match(/setCustomUserClaims\([^)]*,\s*\{([\s\S]{0,400}?)\}/g) || [];
      m.forEach((blk) => {
        [...blk.matchAll(/([A-Za-z_][\w]*)\s*:/g)].forEach((k) => written.add(k[1]));
      });
      if (/\[role\]\s*:/.test(src)) { written.add('admin'); written.add('superAdmin'); }
    }
    ['admin', 'superAdmin', 'role'].forEach((k) => written.add(k));

    /* Two corrections after the first run reported five findings, most false.

       It flagged `isPartial` (a queue flag) and `isSeller`, neither of which is
       an authorisation claim at all — so the check is now limited to names that
       genuinely denote privilege.

       It also flagged post-launch-monitor.js, which DOES hedge on t.admin —
       just three lines below, inside a multi-line boolean. Hedging is now
       looked for in the surrounding window rather than on the one line. */
    const PRIVILEGE = /^(isAdmin|isSuperAdmin|isSupport|isFinance|isModerator|isStaff)$/;
    const out = [];
    for (const f of files) {
      if (/admin-claim\.js$/.test(f)) continue;      /* the compatibility shim */
      const lines = stripComments(read(f)).split(/\r?\n/);
      lines.forEach((line, i) => {
        const hits = [...line.matchAll(/\b(?:token|t|claims|auth)\s*\??\.\s*(is[A-Z]\w+)\b/g)];
        hits.forEach((h) => {
          const claim = h[1];
          if (written.has(claim) || !PRIVILEGE.test(claim)) return;
          /* A real claim anywhere in the enclosing expression rescues it. */
          const window = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
          if (/\b(?:token|t|claims|auth)\s*\??\.\s*(?:admin|superAdmin)\b/.test(window)) return;
          if (/_ac\.|isAdmin\(|isSuperAdmin\(|role\s*===?\s*['"](?:admin|superAdmin)/.test(window)) return;
          out.push({ file: f, line: i + 1, detail: claim + ' is never set by setCustomUserClaims and nothing nearby hedges — this guard always denies' });
        });
      });
    }
    return out;
  });

/* ══ RULE-004 — a written field must match the field queried ═══════════════
   INCIDENT: seller uploads wrote no top-level `status`, while every retrieval
   path filters where('status','==','active'). A Firestore equality filter never
   matches an absent field, so products were excluded before ranking. */
rule('RULE-004', CRITICAL, 'Product writes carry every field the read path filters on',
  "uploads omitted `status`; every query filters where('status','==','active')",
  () => {
    const seller = read('seller.js');
    const block = seller.slice(seller.indexOf('const newProduct'), seller.indexOf('let sellerProducts'));
    if (!block) return [];
    const needsStatus = /where\(\s*['"]status['"]\s*,\s*['"]==['"]\s*,\s*['"]active['"]/.test(
      read('sokoni-search-engine.js') + read('functions/search-service.js'));
    const hasStatus = /\n\s{8,}status:\s*["']active["']/.test(block);
    return (needsStatus && !hasStatus)
      ? [{ file: 'seller.js', line: 0, detail: "product upload omits top-level `status` but search filters on it" }]
      : [];
  });

/* ══ RULE-005 — no dead navigation targets ════════════════════════════════
   INCIDENT: 18 links pointed at pages that were never created, including three
   of four items in the seller bottom nav. */
rule('RULE-005', HIGH, 'Navigation targets resolve to a real page',
  'seller-earnings.html had 3 of 4 bottom-nav items pointing at nonexistent files',
  () => {
    const RUNTIME = /\$\{|['"]\s*\+|\+\s*['"]|<%|\{\{/;
    const out = [];
    for (const f of htmlFiles()) {
      const src = read(f);
      const targets = new Set();
      for (const m of src.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"/g)) targets.add(m[1]);
      for (const m of src.matchAll(/location\.(?:href|replace|assign)\s*[=(]\s*['"]([^'"]+)['"]/g)) targets.add(m[1]);
      for (const t of targets) {
        if (RUNTIME.test(t)) continue;
        if (/^(https?:|mailto:|tel:|javascript:|data:|sms:|whatsapp:|#)/i.test(t)) continue;
        let p = t.split('#')[0].split('?')[0].trim();
        if (!p) continue;
        if (p.startsWith('/')) p = p.slice(1);
        if (!p || fs.existsSync(p) || fs.existsSync(p + '.html')) continue;
        out.push({ file: f, line: 0, detail: 'dead target: ' + t });
      }
    }
    return out;
  });

/* ══ RULE-006 — every page is in the navigation registry ═══════════════════ */
rule('RULE-006', MEDIUM, 'Every page is registered in navigation-registry.json',
  'a page absent from the registry is invisible to Explore, breadcrumbs, search and KASS',
  () => {
    if (!fs.existsSync('navigation-registry.json')) {
      return [{ file: 'navigation-registry.json', line: 0, detail: 'registry missing — run scripts/build-nav-registry.js --write' }];
    }
    const reg = JSON.parse(read('navigation-registry.json'));
    const known = new Set(Object.keys(reg.pages || {}));
    return fs.readdirSync('.').filter((f) => f.endsWith('.html') && !known.has(f))
      .map((f) => ({ file: f, line: 0, detail: 'not in navigation-registry.json' }));
  });

/* ══ RULE-007 — a caught error must reach the user or the log ══════════════
   INCIDENT: pos-setup.html caught bootstrapDevice's failure, discarded it, and
   printed "check your connection" — the one cause it could not be, since the
   app had just loaded over that connection. Diagnosing it took a full trace. */
rule('RULE-007', HIGH, 'Caught errors are surfaced, not discarded',
  'POS setup discarded the server error and blamed the network for a permission failure',
  () => {
    const out = [];
    for (const f of [...htmlFiles(), ...walk('.', (n) => n.endsWith('.js') && !n.startsWith('test-'))]) {
      if (/[\\/]scripts[\\/]|node_modules|functions[\\/]test/.test(f)) continue;
      const src = stripComments(read(f));
      /* catch (err) { ... } where the body never mentions the binding, never
         logs, and never re-throws. An empty catch(_) with a default value is a
         different thing and is deliberately not flagged. */
      const re = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,320}?)\}/g;
      let m;
      while ((m = re.exec(src))) {
        const [, bind, body] = m;
        if (bind === '_' || bind === 'e_' || body.trim() === '') continue;
        if (new RegExp('\\b' + bind + '\\b').test(body)) continue;
        if (/throw|console\.(error|warn)|report\(|logClient/.test(body)) continue;
        if (!/showProvError|showError|innerHTML|textContent|alert\(|toast/i.test(body)) continue;
        /* The first run reported 105 of these, which is a rule nobody will read.
           A generic "couldn't load, try again" is often a fair thing to show.
           The DEFECT is narrower and worth blocking on its own: telling the user
           the problem is their connection, when the code never looked at the
           error and cannot possibly know that. POS setup did exactly this for a
           permission failure, and it cost a full pipeline trace to unpick. */
        if (!/connection|internet|network|offline|check your/i.test(body)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        out.push({ file: f, line,
          detail: 'catch(' + bind + ') blames the network without reading ' + bind + ' — the one cause it cannot verify' });
      }
    }
    return out;
  });

/* ══ RULE-008 — animation fill must not create a containing block ══════════
   INCIDENT: sk-page-in ended at translateY(0) with fill-mode:both, leaving an
   identity transform forever. Any non-none transform makes an element the
   containing block for its fixed descendants, which put banking.html's bottom
   nav at y=1157 on a 664px viewport — off-screen and unreachable. */
rule('RULE-008', MEDIUM, 'Page-entrance keyframes end at transform:none',
  "sk-page-in's identity matrix broke position:fixed on 2 pages' bottom nav",
  () => {
    const out = [];
    for (const f of walk('.', (n) => n.endsWith('.css'))) {
      const src = read(f);
      for (const m of src.matchAll(/@keyframes\s+([\w-]*page-in[\w-]*)\s*\{([\s\S]{0,300}?)\n\}/g)) {
        const [, name, body] = m;
        if (/to\s*\{[^}]*transform:\s*translate[^}]*\}/.test(body)) {
          out.push({ file: f, line: src.slice(0, m.index).split('\n').length,
            detail: '@keyframes ' + name + ' ends at a translate; use transform:none' });
        }
      }
    }
    return out;
  });

/* ══ RULE-009 — no service-account key inside the working tree ═════════════ */
rule('RULE-009', CRITICAL, 'No credentials inside the repository',
  'a committed key cannot be un-committed — removing the file leaves it in history',
  () => walk('.', (n) => n.endsWith('.json'))
    .filter((p) => /"type"\s*:\s*"service_account"/.test(read(p).slice(0, 400)))
    .map((p) => ({ file: p, line: 0, detail: 'service-account key in the working tree — move out and ROTATE it' })));

/* ══ RULE-010 — deployment drift ══════════════════════════════════════════
   INCIDENT: the launch review found main 212 commits ahead of origin. Every
   repair from an entire engineering cycle existed only on one workstation
   while production ran the broken code. */
rule('RULE-010', CRITICAL, 'Repository is not ahead of its remote',
  'a launch review found 212 commits unpushed — production ran the unrepaired code',
  () => {
    let sb = '';
    try {
      sb = execFileSync('git', ['status', '-sb'], { encoding: 'utf8', timeout: 15000 }).split('\n')[0];
    } catch (_) { return []; }
    const m = sb.match(/ahead (\d+)/);
    if (!m) return [];
    const n = parseInt(m[1], 10);
    return [{ file: '(repository)', line: 0,
      detail: n + ' commit(s) ahead of origin — fixes exist locally but not in production' }];
  });

/* ── report ─────────────────────────────────────────────────────────────── */
const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
const crit = bySeverity(CRITICAL), high = bySeverity(HIGH), med = bySeverity(MEDIUM);

/* Weighted so a single CRITICAL cannot be averaged away by passing rules. */
const score = Math.max(0, 100 - (crit * 15) - (high * 4) - (med * 1));

if (JSON_OUT) {
  console.log(JSON.stringify({ score, crit, high, med, results, findings }, null, 2));
  process.exit(GATE && crit > 0 ? 1 : 0);
}

console.log('\n' + '═'.repeat(80));
console.log('  SOKONI ARCHITECTURE GUARDIAN');
console.log('═'.repeat(80));
results.forEach((r) => {
  const mark = r.error ? 'ERROR' : r.count === 0 ? 'PASS ' : 'FAIL ';
  console.log('  ' + mark + '  ' + r.id + '  ' + r.severity.padEnd(8) + r.title);
  if (r.error) console.log('          rule crashed: ' + r.error);
  else if (r.count) console.log('          ' + r.count + ' violation(s) — ' + r.incident);
});

if (findings.length) {
  console.log('\n' + '─'.repeat(80));
  console.log('  VIOLATIONS');
  console.log('─'.repeat(80));
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 40).forEach((f) => {
    console.log('  [' + f.severity + '] ' + f.id + '  ' + f.file + (f.line ? ':' + f.line : ''));
    console.log('        ' + f.detail);
  });
  if (findings.length > 40) console.log('  … ' + (findings.length - 40) + ' more');
}

/* ── deployment certificate ──────────────────────────────────────────────────
   A permanent, evidence-bearing record of what was true at deploy time. Its
   value is retrospective: when something breaks in three months, the question
   "did the gate know about this?" has a filed answer instead of a memory. */
const certificate = {
  generatedAt: new Date().toISOString(),
  manifestVersion: MANIFEST.schemaVersion || 'unknown',
  commit: (() => {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch (_) { return 'unknown'; }
  })(),
  rulesEvaluated: results.length,
  rulesRejected: rejected.length,
  violations: { critical: crit, high, medium: med },
  score,
  gate: crit === 0 ? 'OPEN' : 'BLOCKED',
  blockingRules: [...new Set(findings.filter((f) => f.severity === CRITICAL).map((f) => f.id))],
  results: results.map((r) => ({ id: r.id, incidentId: r.incidentId, count: r.count, noisy: !!r.noisy })),
  /* Named explicitly so the certificate cannot be read as a clean bill of
     health for things it never examined. */
  notCertified: MANIFEST.notMeasured || [],
};

if (rejected.length) {
  console.log('\n' + '─'.repeat(80));
  console.log('  RULES REJECTED — no evidence, so not run');
  console.log('─'.repeat(80));
  rejected.forEach((r) => console.log('  ' + r.id + '  ' + r.title + '\n        ' + r.reason));
}

console.log('\n' + '═'.repeat(80));
console.log('  CRITICAL ' + crit + '  ·  HIGH ' + high + '  ·  MEDIUM ' + med);
console.log('  rules evaluated ' + results.length + '  ·  rejected for lack of evidence ' + rejected.length);
console.log('  ARCHITECTURE SCORE: ' + score + '/100');
console.log('  DEPLOY GATE: ' + (crit === 0 ? 'OPEN' : 'BLOCKED — ' + crit + ' critical violation(s)'));
if (certificate.notCertified.length) {
  console.log('\n  NOT CERTIFIED (never examined — absence of findings is not evidence):');
  certificate.notCertified.forEach((n) => console.log('    · ' + n.split('.')[0] + '.'));
}
console.log('═'.repeat(80) + '\n');

try {
  fs.mkdirSync('docs/certificates', { recursive: true });
  const f = 'docs/certificates/' + certificate.commit + '.json';
  fs.writeFileSync(f, JSON.stringify(certificate, null, 2));
  console.log('  certificate: ' + f + '\n');
} catch (e) {
  console.log('  (certificate not written: ' + e.message + ')\n');
}

process.exit(GATE && crit > 0 ? 1 : 0);
