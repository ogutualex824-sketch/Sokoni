#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — every CSS token a mounted module declares is defined by its host
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-module-tokens.js

   THE DEFECT THIS GUARDS. sokoni-merchant-sell.js styles its payment sheet with
   `background:var(--panel)` and its product cards with `var(--card)`.
   merchant-v2 defined NEITHER — it names the same surfaces --surface and
   --surface-2 — so both resolved to nothing and rendered TRANSPARENT. The
   payment sheet appeared to have no background, and tapping inside it felt
   unresponsive because there was no visible surface at all.

   Nothing failed loudly: an undefined custom property is not an error, it is
   simply empty. That is precisely the class of defect a test has to catch,
   because the browser never will.

   A module is entitled to the tokens it declares. The host must supply them —
   the same contract as supplying SokoniCash or SokoniReceiptDoc.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } };

/* Modules mounted into merchant-v2, and the host that must supply their tokens. */
const HOST = 'merchant-v2.html';
const MODULES = [
  'sokoni-merchant-sell.js',
  'sokoni-merchant-inventory-ui.js',
  'sokoni-merchant-store-ui.js',
  'sokoni-merchant-customers-ui.js',
  'sokoni-merchant-disputes-ui.js',
  'sokoni-merchant-messages-ui.js',
];

const host = read(HOST);
/* A token counts as DEFINED when it appears as a declaration (`--x:`), which
   includes an alias to another token. */
const defined = new Set(
  (host.match(/--[a-z0-9-]+\s*:/gi) || []).map((s) => s.replace(/\s*:$/, '').trim())
);

ck('K0  the host defines a palette at all',
  defined.size > 4, defined.size + ' custom properties declared');

let anyMissing = false;
MODULES.forEach((f) => {
  const src = read(f);
  if (!src) return;
  const used = new Set((src.match(/var\(\s*(--[a-z0-9-]+)/gi) || [])
    .map((s) => s.replace(/var\(\s*/i, '').trim()));

  /* Two legitimate reasons a token needs no host definition, and flagging
     either would make this suite cry wolf:
       · it is read WITH A FALLBACK — var(--x, 0px) is complete on its own
       · the module SETS IT ITSELF at runtime, e.g. a keyboard inset written
         with host.style.setProperty('--x', …) */
  const hasFallback = (t) =>
    new RegExp('var\\(\\s*' + t + '\\s*,').test(src);
  const selfSet = (t) =>
    new RegExp('setProperty\\(\\s*[\'"]' + t + '[\'"]').test(src);

  const missing = [...used].filter((t) => !defined.has(t) && !hasFallback(t) && !selfSet(t));
  if (missing.length) anyMissing = true;
  ck('K  ' + f + ' — every token it declares is defined by the host',
    missing.length === 0,
    missing.length
      ? 'MISSING: ' + missing.join(', ') + '  — these render as NOTHING, not as a default'
      : [...used].length + ' tokens, all defined');
});

/* ── the two that actually broke, named explicitly ─────────────────────── */
ck('K1  --panel is defined (the payment sheet background)',
  defined.has('--panel'), 'undefined meant a transparent sheet');
ck('K2  --card is defined (product card background)',
  defined.has('--card'), 'undefined meant transparent cards');

/* ── CONTROL: the detector must be able to fail ────────────────────────── */
const fakeUsed = new Set(['--definitely-not-defined-xyz']);
ck('K3  CONTROL the detector reports a genuinely missing token',
  [...fakeUsed].filter((t) => !defined.has(t)).length === 1,
  'a checker that cannot fail would have passed while the sheet was invisible');

ck('K4  CONTROL an alias counts as a definition',
  /--panel:\s*var\(/.test(host) ? defined.has('--panel') : true,
  'the host maps its own palette rather than duplicating colours');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  MODULE CSS TOKENS — a module is entitled to the tokens it declares');
console.log('  ' + '='.repeat(68));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
