'use strict';
/* pos-checkout.html payment modals (owner, 2026-10-01): the cash / M-Pesa modals list the sale's items above the
   amount, and a modal taller than the phone scrolls. Runs the REAL openModal/_renderPayItems with a DOM stub.
     node scripts/test-pos-checkout-pay-items.js              (this tree)
     BASE=<rev> node scripts/test-pos-checkout-pay-items.js   (baseline; live 72dca56 must FAIL) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const src = process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':pos-checkout.html', { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(__dirname, '..', 'pos-checkout.html'), 'utf8');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(got).slice(0, 140) + ']')); ok ? pass++ : fail++; };
console.log('\npos-checkout pay modals   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const css = (src.match(/\n\.modal \{[\s\S]*?\n\}/) || [''])[0];
ck('M-1', /max-height:\s*90d?vh/.test(css) && /overflow-y:\s*auto/.test(css) && /-webkit-overflow-scrolling:\s*touch/.test(css), 'a payment modal taller than the phone scrolls (max-height + overflow + iOS momentum)', css);

/* pull the helpers out of the page and run them against a tiny DOM */
const pick = (name) => { const a = src.indexOf('function ' + name); if (a < 0) return ''; let d = 0, e = -1; for (let i = src.indexOf('{', a); i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { e = i + 1; break; } } } return src.slice(a, e); };
const code = ['_payItemsEsc', '_renderPayItems', 'openModal', '_kes'].map(pick).join('\n');
const mkEl = () => { const el = { children: [], className: '', attrs: {}, innerHTML: '', classList: { add() {} }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: (sel) => sel === '.pay-items' ? (el.children.find((c) => c.className === 'pay-items') || null) : (sel === '.modal-title' ? title : null), insertBefore(n) { el.children.unshift(n); }, prepend(n) { el.children.unshift(n); } }; return el; };
const title = { nextSibling: {} };
const modal = mkEl(); const overlay = { classList: { add() { overlay.open = true; } } };
const document = { querySelector: (sel) => /#(cash|mpesa)-overlay \.modal/.test(sel) ? modal : null, getElementById: () => overlay, createElement: () => mkEl() };
const ctx = { document, _s: { items: [{ name: 'Grape <b>Ice</b> Pod', qty: 2, unitPrice: 2000 }, { name: 'Raspberry Pod', qty: 1, unitPrice: 2000 }] }, String, Number, Object };
vm.createContext(ctx);
let ran = true; try { vm.runInContext(code + '\n;openModal("cash-overlay");', ctx); } catch (e) { ran = false; ck('M-0', false, 'helpers run', e.message); }
const box = modal.children.find((c) => c.className === 'pay-items');
ck('M-2', ran && !!box && /Grape &lt;b&gt;Ice&lt;\/b&gt; Pod/.test(box.innerHTML) && /2 × KES 2000\.00/.test(box.innerHTML) && /KES 4000\.00/.test(box.innerHTML) && /Raspberry Pod/.test(box.innerHTML),
  'opening the cash modal lists every item (escaped name, qty × price, line total)', box && box.innerHTML);
ck('M-3', overlay.open === true, 'the modal still opens');
ck('M-4', /if \(id === 'cash-overlay' \|\| id === 'mpesa-overlay'\) _renderPayItems\(id\);/.test(src), 'both the cash and the M-Pesa modals list the items');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
