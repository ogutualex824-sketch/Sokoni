'use strict';
/* onOrderStatusChange × the completion-PIN engine (owner 2026-10-01). Source-level: the engine itself is proven by
   test-completion-pin-core (33/0) — this pins the WIRING in the 00065-fud lineage.
     node scripts/test-oosc-completion-pin.js            (this tree)
     BASE=106db63 node scripts/test-oosc-completion-pin.js (live baseline must FAIL) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
const idx = read('functions/index.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const a = idx.indexOf('exports.onOrderStatusChange = onDocumentUpdated(');
const body = a < 0 ? '' : strip(idx.slice(a, idx.indexOf('\nexports.', a + 10)));
console.log('\nonOrderStatusChange × completion PIN   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
ck('W-0', body.length > 2000, 'the trigger body was found');
ck('W-1', /secrets:\s*\[\.\.\.sokoniAt\.secrets, SOKONI_HMAC_KEY\]/.test(body), 'the trigger binds SOKONI_HMAC_KEY (a v2 function only receives the secrets it declares)');
const blk = (body.match(/if \(\(toStatus === "paid" && before\.status !== "paid"\)[\s\S]{0,1800}?\n    \}\n/) || [''])[0];
ck('W-2', /CP\.eligibility\(after\)/.test(blk) && /!after\.deliveryPinHash/.test(blk) && /CP\.issueOrResend\(\{[^}]*mode: "auto"/.test(blk),
  'on the transition INTO paid, an eligible order WITHOUT a PIN gets one from the engine (auto = never a replacement)');
ck('W-3', /CP\.deliverPin\(\{[^}]*sendSms: sokoniAt\.atSendSMS/.test(blk), '...and the buyer gets it by SMS at issue, through the existing AT authority');
ck('W-4', /catch \(e\) \{[\s\S]{0,200}recoverable/.test(blk), '...and a failure never blocks the trigger');
ck('W-5', !/collection\("deliveryPins"\)/.test(body), 'the trigger NEVER reads the PIN back (no post-delivery SMS of the secret)');
ck('W-6', /const _deliveryPin = null;/.test(body) && /smsTemplates\(after, _deliveryPin\)/.test(body), 'the delivered message carries no PIN');
const eng = process.env.BASE ? '' : fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'completion-pin.js'), 'utf8');
ck('W-7', !!eng && eng === fs.readFileSync('C:/temp/sok-pinB/functions/shared/completion-pin.js', 'utf8'), 'the engine copy is byte-identical to lineage B\'s');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
