#!/usr/bin/env node
'use strict';
/* ============================================================================
   Profile — trust score & verification DISPLAY (2026-10-03). Server authority: functions/profile-engine.js
   (branch fix/profile-trust-authority-on-72dca56). This suite proves the page shows the server's answer.
     D1  the overview's trust {score, level} is copied once onto the cached overview → the nine widgets that read
         ov.trustScore show the real score (was always 0), executed
     D2  unknown trust is "—", never 0 / "Bronze" (hero ring, level)
     D3  insights: no level chips and no "+N since last visit" until known; the baseline is per account
     D4  Identity grid: pending → "Under review" (status page, no resubmit), rejected → "Needs attention" + reason,
         expired → "Expired — renew"; verified → "✓ Verified"
     D5  Verify email / phone open the on-page flows (account-centre only displays them); #verify routes too
   node scripts/test-profile-trust-display.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.env.SOK_FILES_ROOT || path.resolve(__dirname, '..');
const P = fs.readFileSync(path.join(ROOT, 'profile.html'), 'utf8').replace(/\r/g, '');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 220) : '')); } };
const fnSrc = (name) => { const i = P.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0; for (let k = P.indexOf('{', i); k < P.length; k++) { if (P[k] === '{') d++; else if (P[k] === '}' && --d === 0) return P.slice(i, k + 1); } return ''; };

/* D1 */
const norm = fnSrc('_skNormOv');
let ov = null;
try { const c = {}; vm.createContext(c); vm.runInContext(norm + ';this.o=_skNormOv({trust:{score:65,level:"Silver",factors:[]}});this.n=_skNormOv({});', c); ov = c; } catch (e) { ov = { err: e.message }; }
ck('D1a normaliser copies trust.score/level → trustScore/trustLevel; absent trust stays absent', ov.o && ov.o.trustScore === 65 && ov.o.trustLevel === 'Silver' && ov.n && !('trustScore' in ov.n), ov.err);
ck('D1b the cached overview the widgets read is normalised (both writers)', /window\._piOverview = _skNormOv\(data\); _render\(data\);/.test(P) && /if \(!window\._piOverview\) window\._piOverview = _skNormOv\(data\);/.test(P));
const readers = (P.match(/ov\.trustScore/g) || []).length;
ck('D1c the ' + readers + ' ov.trustScore readers now receive a real value (no reader of a field the server never sends)', readers >= 8 && norm.length > 0);

/* D2 */
ck('D2 unknown trust renders "—" (hero number + level), never 0 / Bronze', /typeof data\.trust\.score === 'number'\) \? data\.trust\.score : '—'/.test(P) && /lvl\.textContent = level \|\| '—';/.test(P) && !/data\.trust \? data\.trust\.score : 0/.test(P));

/* D3 */
ck('D3 insights: level chips + delta only when known; baseline keyed per account', /var _trustKnown = typeof ov\.trustScore === 'number';/.test(P) && /if \(!_trustKnown\) \{/.test(P) && /'_piTrustPrev:' \+ \(ov\.uid \|\| ''\)/.test(P) && !/localStorage\.getItem\('_piTrustPrev'\)/.test(P));

/* D4 — run the grid with each state */
const gi = P.indexOf('var VERIF_MAP = [');
const ge = P.indexOf('// Populate QR hint', gi);
const gridSrc = P.slice(gi, ge);
function grid (verifications, facetStates) {
  const els = { piVerifGrid: { innerHTML: '' } };
  const c = { document: { getElementById: (id) => els[id] || null }, escHtml: (x) => String(x).replace(/"/g, '&quot;').replace(/</g, '&lt;'), data: { verifications, facetStates } };
  vm.createContext(c); vm.runInContext(gridSrc, c);
  return els.piVerifGrid.innerHTML;
}
let h = '';
try { h = grid({ email: true }, { identity: { state: 'pending' }, kra: { state: 'rejected', reason: 'PIN does not match name' }, bank: { state: 'expired' } }); } catch (e) { h = 'ERR ' + e.message; }
const item = (label) => (h.split(/(?=<(?:a|div) )/).find((x) => x.includes('>' + label + '<')) || '');
ck('D4a verified → "✓ Verified"', /✓ Verified/.test(item('Email')), item('Email'));
ck('D4b pending identity → "Under review", links to the status page (no resubmission flow)', /Under review/.test(item('Identity')) && /account-centre\.html#verification/.test(item('Identity')), item('Identity'));
ck('D4c rejected KRA → "Needs attention" with the reviewer\'s reason', /Needs attention/.test(item('KRA')) && /PIN does not match name/.test(item('KRA')), item('KRA'));
ck('D4d expired bank → "Expired — renew"; nothing pending stays "Tap to verify"', /Expired — renew/.test(item('Bank')) && /Tap to verify/.test(item('Address')), item('Bank'));

/* D5 */
let h2 = ''; try { h2 = grid({}, {}); } catch (e) { h2 = 'ERR ' + e.message; }
const email2 = h2.split(/(?=<(?:a|div) )/).find((x) => x.includes('>Email<')) || '';
ck('D5a unverified Email / Phone badges open the ON-PAGE flows (account-centre only displays them)', /onclick="window\._pvSendEmail&&window\._pvSendEmail\(\)"/.test(email2) && /onclick="window\._pvStartPhone&&window\._pvStartPhone\(\)"/.test(item('Phone')), item('Phone'));
ck('D5b #verify (account-centre\'s button) routes to the canonical entry; empty hash restores Overview', /if \(key === 'verify'\)\{\n\s*if \(window\._pvOpenVerifyFromHash\) window\._pvOpenVerifyFromHash\(\);/.test(P) && /\|\| _DEFAULT_TAB;/.test(P));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
