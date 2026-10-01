'use strict';
/* Completion PIN — the three screens (owner 2026-10-01).
   Buyer (track.html): masked by default, Show/Hide, PIN only in memory, PIN YAKO safety checklist, expired → ask the
   SERVER for a new one. Rider (driver.html): 6 digits only, every entry verified by completeDeliveryWithPin, no
   browser-side check, no client status write. Seller (merchant-v2.html): masked state + "Send customer PIN" (server);
   never the PIN or its hash.
     node scripts/test-completion-pin-ui.js
     BASE=72dca56 node scripts/test-completion-pin-ui.js   (live hosting must FAIL) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
console.log('\nCompletion PIN UI   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* buyer */
const tr = read('track.html'), trc = code(tr);
const tblk = (trc.match(/var _pinVal=null[\s\S]*?_paint\(\); _load\(\);/) || [''])[0];
ck('B-1', /id="pinCode"[^>]*>• • • • • •</.test(tr) && /id="pinToggle"[^>]*aria-pressed="false"/.test(tr), 'the buyer\'s PIN is MASKED by default, with an accessible Show/Hide toggle');
ck('B-2', !!tblk && /\(_pinVal&&_shown\)\?/.test(tblk) && !/localStorage|sessionStorage|indexedDB|location\.(hash|search)/.test(tblk), 'the PIN is shown only on Show, held only in memory (never storage, never the URL)');
ck('B-3', /PIN YAKO NI PRODUCT YAKO!/.test(tr) && ['right product', 'quantity', 'condition', 'size / model / colour', 'matches your order'].every((w) => tr.indexOf(w) > 0),
  'the PIN YAKO NI PRODUCT YAKO safety checklist (product, quantity, condition, size/model/colour, matches) is on the card');
ck('B-4', /d\.state==='EXPIRED'/.test(tblk) && /_cf\('sendDeliveryPin'\)\(\{orderId:_orderId\}\)/.test(tblk), 'an EXPIRED PIN tells the buyer, who can ask the SERVER for a new one');
/* rider */
const dr = read('driver.html'), drc = code(dr);
ck('R-1', !/\\d\{4,8\}/.test(drc) && !/maxlength="4" placeholder="4-digit PIN"/.test(dr), 'no rider PIN entry accepts 4 (or 4–8) digits any more');
const sub = (drc.match(/window\._dhSubmitProof = async function\(fsId\) \{[\s\S]*?\n\};/) || [''])[0];
ck('R-2', /\/\^\\d\{6\}\$\/\.test\(pin\)/.test(sub) && /httpsCallable\('completeDeliveryWithPin'\)/.test(sub) && !/DeliveryHub\.submitProof/.test(sub),
  'the hub proof modal verifies 6 digits on the SERVER (completeDeliveryWithPin) — no browser-side check, no client status write');
ck('R-3', /id="dhPinEntry"[^>]*maxlength="6"/.test(dr) && /Ask the buyer for their 6-digit delivery PIN/.test(dr), 'the rider is told to ask the buyer after inspection; the field takes exactly 6');
ck('R-4', (drc.match(/\/\^\\d\{6\}\$\/\.test\(/g) || []).length >= 3, 'every rider PIN path checks exactly 6 digits');
/* seller */
const mv = read('merchant-v2.html'), mvc = code(mv);
const pb = (mvc.match(/function pinBlock \(o\) \{[\s\S]*?\n  \}/) || [''])[0];
ck('S-1', !!pb && /data-send-pin=/.test(pb) && !/deliveryPinHash|\.pin\b|sealed/.test(pb), 'the order sheet shows the MASKED PIN state + "Send customer PIN" — never the PIN or its hash');
ck('S-2', /pinIssued: !!d\.deliveryPinHash/.test(mvc) && !/pinHash:\s*d\.deliveryPinHash/.test(mvc), 'the order row carries only a boolean that a PIN exists (the hash value is never copied)');
ck('S-3', /_callable\('sendDeliveryPin'\)\(\{ orderId: sp\.dataset\.sendPin \}\)/.test(mvc), 'the button asks the SERVER (sendDeliveryPin) — the PIN goes to the buyer\'s phone only');
ck('S-4', /if \(!o\.isDelivery \|\| !o\.paidVerified/.test(pb), 'offered only for a PAID DELIVERY order');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
