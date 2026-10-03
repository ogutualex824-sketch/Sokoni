#!/usr/bin/env node
/* B2B functions ASSEMBLY CHECK — run on any combined functions tree before a deploy that carries rfqDispatch.
 *
 *   node scripts/check-b2b-functions-assembly.js [functionsDir]     (default: ./functions)
 *
 * WHY: rfq.js (sokoni-f3) requires ./b2b-leads (sokoni-2f) OPTIONALLY, so each line can be unit-tested alone.
 * On the two lines it is optional; in an ASSEMBLED tree it must resolve. Otherwise every lead is written without its
 * price snapshot, the month falls back to the local EAT helper, and nothing complains. This check fails CLOSED:
 * any missing file, missing export or unreadable source is exit 1, never a skip.
 *
 * It requires nothing (no firebase-admin init). It reads the source and checks the export NAMES the contract needs:
 *   rfq.js        exports.rfqDispatch, and index.js re-exports it by name
 *   b2b-leads.js  exports.leadFields + exports.monthOf (read by rfq.js) and the invoice side the leads feed:
 *                 b2bLeadMonthlyInvoices, b2bLeadPrice, adminSetB2bLeadPrice, re-exported in index.js
 *   commission    RATES.b2b_order present (0% lane): an accepted-quote PO is tagged commissionCategory 'b2b_order'
 */
'use strict';
const fs = require('fs'), path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'functions'));
let pass = 0, fail = 0;
function ok (id, cond, m) { console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m); cond ? pass++ : fail++; }
function read (f) { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return null; } }
const exported = (src, name) => !!src && new RegExp('(^|\\n)\\s*exports\\.' + name + '\\s*=|module\\.exports\\s*=\\s*\\{[^}]*\\b' + name + '\\b').test(src);
const reExported = (idx, name) => !!idx && new RegExp('exports\\.' + name + '\\s*=').test(idx);

console.log('\nB2B functions assembly   dir=' + dir + '\n');
const rfq = read('rfq.js'), leads = read('b2b-leads.js'), idx = read('index.js');
ok('A0', idx !== null, 'index.js readable');
ok('A1', rfq !== null, 'rfq.js present');
ok('A2', exported(rfq, 'rfqDispatch') && reExported(idx, 'rfqDispatch'), 'rfqDispatch exported and re-exported by name in index.js');
ok('A3', !!rfq && /require\(['"]\.\/b2b-leads['"]\)/.test(rfq), 'rfq.js requires ./b2b-leads (the dependency this check guards)');
ok('B1', leads !== null, 'b2b-leads.js present — REQUIRED in an assembled tree (rfq.js would silently write unpriced leads)');
['leadFields', 'monthOf'].forEach((n, i) => ok('B' + (i + 2), exported(leads, n), 'b2b-leads.js exports ' + n + ' (read by rfq.js)'));
['b2bLeadMonthlyInvoices', 'b2bLeadPrice', 'adminSetB2bLeadPrice'].forEach((n, i) =>
  ok('B' + (i + 4), exported(leads, n) && reExported(idx, n), n + ' exported and re-exported in index.js'));
const rateSrc = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /commission/i.test(f) && f.endsWith('.js')).map(read).filter(Boolean).join('\n') : '';
ok('C1', /\bb2b_order\b/.test(rateSrc), "commission authority defines the 0% 'b2b_order' lane (the accepted-quote PO's commissionCategory)");

/* G — the lead-invoice gate predicate is SHARED (sokoni-2f b1be68e / 077b245): one copy must exist in this tree, and
   when the caller names the other line's tree (GATE_PEER_DIR) the two copies must be byte-identical, so the gate the
   POS rail enforces is the gate the invoice side computes. The closure gate refuses an optional require, so this
   predicate is copied, not required, which makes byte equality the contract. */
const gateRel = path.join('shared', 'lead-invoice-gate.js');
const gate = (() => { try { return fs.readFileSync(path.join(dir, gateRel)); } catch (e) { return null; } })();
ok('G1', gate !== null, 'shared/lead-invoice-gate.js present (leadInvoiceGate delegates to it)');
const peer = process.env.GATE_PEER_DIR ? path.resolve(process.env.GATE_PEER_DIR) : null;
if (peer) {
  const other = (() => { try { return fs.readFileSync(path.join(peer, gateRel)); } catch (e) { return null; } })();
  ok('G2', !!gate && !!other && Buffer.compare(gate, other) === 0, 'shared/lead-invoice-gate.js byte-identical to ' + peer);
} else {
  ok('G2', false, 'GATE_PEER_DIR not set: byte equality with the POS line was NOT checked (fails closed; set it to that line\'s functions dir)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
