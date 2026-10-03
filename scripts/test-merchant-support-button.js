#!/usr/bin/env node
/* Merchant v2 — Help & Support in the sidebar (owner, 2026-10-03).
 *   node scripts/test-merchant-support-button.js          BASE=72dca56 node scripts/test-merchant-support-button.js (must FAIL)
 * Loads the REAL route contract (sokoni-merchant-routes.js) and runs its own validator; the shell is checked by source.
 * No browser. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nMerchant v2 Help & Support   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const tmp = path.join(os.tmpdir(), 'mvsup-routes-' + process.pid + '.js');
fs.writeFileSync(tmp, read('sokoni-merchant-routes.js'));
let C = null; try { C = require(tmp); } catch (e) { console.log('CRASH loading contract (no verdict): ' + e.message); process.exit(2); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }

const r = (C.ROUTES || []).find((x) => x.id === 'support');
ck('S-1', !!r && r.kind === 'exit' && r.href === '/support', 'the contract declares a `support` EXIT to /support', r);
ck('S-2', !!r && !/wa\.me|whatsapp|^https?:/i.test(String(r.href)), 'it stays in SOKONI — no WhatsApp, no external host');
ck('S-3', !!r && ['seller', 'merchant', 'cashier'].every((x) => (r.role || []).includes(x)), 'owners, merchants and cashiers all reach it');
ck('S-4', !!r && C.resolve('support') === 'support', 'the router resolves it (an undeclared id would be refused)');
let errs = null; try { const v = C.validate(); errs = Array.isArray(v) ? v : (v && v.errors) || []; } catch (e) { errs = ['validate threw: ' + e.message]; }
ck('S-5', Array.isArray(errs) && errs.length === 0, 'the contract\'s own validator accepts the whole route table', errs);
ck('S-6', !!r && !r.terminatesSession, 'leaving for Support does not end the session');

const SH = read('merchant-v2.html');
ck('U-1', /r\.id === 'support' && r\.kind === 'exit'/.test(SH) && /if \(support\) f\.appendChild\(navItem\(support\)\)/.test(SH),
  'the sidebar footer (also the phone drawer) renders Help & Support FROM the contract');
ck('U-2', !/location\.(href|assign)\s*[=(]\s*['"]\/?support/.test(SH), 'no hardcoded navigation to support — it goes through leaveShell like every exit');
ck('U-3', /var exit = CONTRACT\.ROUTES\.filter\(function \(r\) \{ return r\.kind === 'exit'; \}\)\[0\];/.test(SH) && C.ROUTES.filter((x) => x.kind === 'exit')[0].id === 'home',
  'CONTROL: the Marketplace exit in the footer is still `home`');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
