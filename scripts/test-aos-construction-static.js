#!/usr/bin/env node
/* AdminOS › Construction static certification (sokoni-aos-construction.js + admin-os.html + sokoni-aos.js hooks).
   READ-ONLY contract: no writes, no new approval path; denied reads are errors, never empty lists.
   PARITY: every construction category in the ONE intake (hub-register.js on the intake branch) is labelled here; the
   intake source is read from INTAKE_REF (git) — if unreadable the parity row FAILS. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (id, c, m) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m); c ? pass++ : fail++; };
const mod = fs.readFileSync(path.join(R, 'sokoni-aos-construction.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'admin-os.html'), 'utf8');
const aos = fs.readFileSync(path.join(R, 'sokoni-aos.js'), 'utf8');
const sb = { window: {} }; sb.window.window = sb.window;
let loaded = true; try { vm.runInNewContext(mod, sb.window, { timeout: 2000 }); } catch (e) { loaded = false; }
const M = sb.window.SokoniAOSConstruction;
ok('S1', loaded && M && typeof M.load === 'function', 'module loads and exposes SokoniAOSConstruction.load');
ok('S2', !!M && JSON.stringify(M.TABS.map((t) => t[0])) === '["applications","rfqs","leads","leadfees","rentals"]', 'tabs: applications, RFQs, leads, lead fees, rentals');

/* X — read-only */
ok('X1', !/\.(set|update|add|delete)\(|setDoc|updateDoc|addDoc|deleteDoc|httpsCallable/.test(mod), 'module never writes and calls no callable (read-only)');
const cols = Array.from(new Set((mod.match(/collection\('([A-Za-z0-9]+)'\)/g) || []).map((m) => m.slice(12, -2)))).sort();
ok('X2', JSON.stringify(cols) === JSON.stringify(['applications', 'b2bLeads', 'contactRequests', 'rentalBookings', 'rentalProducts', 'rfqRecipients', 'rfqs']), 'reads only the expected admin-readable collections (' + cols.join(',') + ')');
ok('X3', /This is not an empty list/.test(mod), 'a denied/failed read is never shown as an empty list');
ok('X4', /AdminOS › Applications/.test(mod) && /read-only/i.test(mod), 'applications are decided in AdminOS › Applications (one approval path)');
ok('X5', /'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'/.test(mod), 'esc() escapes all five HTML characters');
ok('X6', /no booking here is marked paid without it/.test(mod) && !/paid'\s*:\s*true|markPaid/.test(mod), 'rentals never claim payment without the payment purpose');
ok('X7', /priced at invoice/.test(mod) && !/priceKES\s*\|\|\s*200/.test(mod), 'lead price shown only when recorded ("—" otherwise); never an assumed figure');

/* P — intake parity */
let HR = null; const ref = process.env.INTAKE_REF || 'hosting/construction-intake-on-d824b58';
try { HR = execSync('git show ' + ref + ':hub-register.js', { cwd: R, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { HR = null; }
ok('P0', !!HR, 'intake hub-register.js read from ' + ref);
const cats = HR ? (HR.match(/\{ id:'[a-z-]+',\s+label:'[^']+',\s+hub:'construction'/g) || []).map((m) => m.match(/id:'([a-z-]+)'/)[1]) : [];
const missing = cats.filter((c) => !(M && M.CATS[c]));
ok('P1', !!HR && cats.length >= 8 && missing.length === 0, 'every intake construction category is labelled in AdminOS' + (missing.length ? ' (missing: ' + missing.join(',') + ')' : ''));

/* W — wiring */
ok('W1', /data-section="construction"[^>]*onclick="SokoniAOS\.navigate\('construction'\)/.test(html), 'sidebar has a Construction nav item');
ok('W2', /<div class="aos-panel" id="panel-construction" hidden>[\s\S]{0,200}id="constructionAdminBody"/.test(html), 'panel-construction exists');
ok('W3', html.indexOf('<script src="sokoni-aos-construction.js"></script>') > html.indexOf('<script src="sokoni-aos.js"></script>'), 'module loads after sokoni-aos.js');
ok('W4', /construction:\s+\(\) => window\.SokoniAOSConstruction && window\.SokoniAOSConstruction\.load\(\)/.test(aos), 'loader routes construction → SokoniAOSConstruction.load');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
