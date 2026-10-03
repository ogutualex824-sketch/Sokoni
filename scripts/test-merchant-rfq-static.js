#!/usr/bin/env node
/* Static certification for the merchant-v2 RFQs & Quotes module (sokoni-merchant-rfq.js).
   Contract: every state change is a server op on rfqDispatch (functions/rfq.js); the client never prices,
   never assumes VAT, never hands off to WhatsApp, renders unknowns as '—', and is registered in the shell
   (route + MODULES + script tag). Pure source checks + one helper execution in a vm sandbox. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'sokoni-merchant-rfq.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'merchant-v2.html'), 'utf8');
const routes = fs.readFileSync(path.join(R, 'sokoni-merchant-routes.js'), 'utf8');
let pass = 0, fail = 0;
function ok (name, cond) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } }

/* S — syntax + global */
let parsed = true; try { new vm.Script(src); } catch (e) { parsed = false; }
ok('S1 module parses', parsed);
const sandbox = { window: {}, document: undefined }; sandbox.global = sandbox.window;
try { vm.runInNewContext(src.replace(/^/, ''), Object.assign(sandbox, { self: sandbox.window }), { timeout: 2000 }); } catch (e) { /* DOM-free load */ }
const G = sandbox.window.SokoniMerchantRfq || sandbox.SokoniMerchantRfq;
ok('S2 exposes SokoniMerchantRfq.mount', !!G && typeof G.mount === 'function');
ok('S3 SECTIONS = mine,new,received,consent', !!G && JSON.stringify((G.SECTIONS || []).map(s => s.id)) === '["mine","new","received","consent"]');

/* O — server ops: the client calls only ops the server implements (rfq.js H.* on functions/b2b-rfq-on-e61c73e) */
const SERVER_OPS = ['cancel', 'create', 'decline', 'get', 'listMine', 'listReceived', 'quote', 'respond'];
const used = Array.from(new Set((src.match(/rfq\('([a-zA-Z]+)'/g) || []).map(m => m.slice(5, -1)))).sort();
ok('O1 every client op exists on the server', used.length > 0 && used.every(o => SERVER_OPS.includes(o)));
ok('O2 every server op has a client surface', SERVER_OPS.every(o => used.includes(o)));
const callables = Array.from(new Set((src.match(/call\('([a-zA-Z0-9]+)'/g) || []).map(m => m.slice(6, -1)))).sort();
ok('O3 callables limited to b2bLeadPrice/rfqDispatch/findSuppliers/setSupplyParticipation', JSON.stringify(callables) === '["b2bLeadPrice","findSuppliers","rfqDispatch","setSupplyParticipation"]');

/* M — money / tax honesty */
ok('M1 no client-side total arithmetic on quotes (server totals rendered)', /q\.totalKES/.test(src) && !/totalKES\s*=/.test(src));
ok('M2 quote refuses a missing VAT choice', /SOKONI never assumes it/.test(src));
ok('M3 no hard-coded 0.16 VAT', !/0\.16/.test(src));
ok('M4 consent states the lead price + VAT from the server, monthly, no order commission',
  /call\('b2bLeadPrice'/.test(src) && /kes\(p\.priceKES\)/.test(src) && /esc\(p\.vat\)/.test(src)
  && /invoiced monthly/.test(src) && /no commission on the orders you win/.test(src));
/* The price is admin-configurable (adminSetB2bLeadPrice) and its VAT wording is the commercial authority's. */
/* (The supplier's own quote VAT choice "16% VAT (I am VAT-registered)" is the supplier's declaration, not a lead fee.) */
ok('M7 no hard-coded lead price or lead VAT in the module', !/KES 200/.test(src) && !/\+ 16% VAT/.test(src));
ok('M8 opt-in disabled while the price is unknown (button + click guard); opt-out always allowed',
  /data-rfq-consent="on"' \+ \(known \? '' : ' disabled/.test(src)
  && /if \(on && !\(lp && !lp\.error && Number\(lp\.priceKES\) > 0\)\)/.test(src)
  && /data-rfq-consent="off">Stop receiving RFQs/.test(src));
ok('M5 held payment not faked — shown as not available yet', /held until delivery\) is not available yet/.test(src));
ok('M6 kes() renders unknown as —', /isFinite\(v\) && v >= 0 \? 'KES ' .*: '—'/.test(src));

/* X — safety */
ok('X1 no WhatsApp hand-off', !/wa\.me|whatsapp/i.test(src));
ok('X2 esc() escapes & < > " \'', /'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'/.test(src));
ok('X3 chat uses SokoniInbox.openForTransaction(\'rfq\', …) with honest fallback',
  /SokoniInbox\.openForTransaction\('rfq', txId\)/.test(src) && /Messaging for RFQs is not available yet/.test(src));
ok('X4 load failure is not rendered as an empty list', /This is not an empty list/.test(src));
ok('X5 no localStorage business state', !/localStorage/.test(src));
ok('X6 supplier links go to seller-public storefront by business id', /seller-public\.html\?business=/.test(src));

/* SH — shell registration */
ok('SH1 merchant-v2 loads the module', /<script src="sokoni-merchant-rfq\.js"><\/script>/.test(html));
ok('SH2 MODULES.rfqs → SokoniMerchantRfq with business ctx', /rfqs:\s*\{ global: 'SokoniMerchantRfq',[\s\S]{0,120}merchantContext: merchantContext/.test(html));
ok('SH3 route rfqs is native + Commerce group', /id:'rfqs'[\s\S]{0,80}kind:'native'/.test(routes) && /ids:\['supply','rfqs'\]/.test(routes));
let v = null; try { const sb = { window: {} }; sb.global = sb.window; vm.runInNewContext(routes, sb); const M = sb.window.SokoniMerchantRoutes || sb.SokoniMerchantRoutes; v = M && M.validate ? M.validate() : null; } catch (e) { v = null; }
ok('SH4 routes validate() → []', Array.isArray(v) && v.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
