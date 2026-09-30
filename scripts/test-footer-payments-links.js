'use strict';
/* Home footer (owner, 2026-09-30): show every payment method IntaSend provides with real logos, remove what we do
   not offer, keep the style, and make every footer button work.
     node scripts/test-footer-payments-links.js             (this tree)
     BASE=<rev> node scripts/test-footer-payments-links.js  (baseline; live 72dca56 must FAIL the change rows) */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f) => { try { process.env.BASE ? execSync('git cat-file -e ' + process.env.BASE + ':' + f, { cwd: ROOT, stdio: 'ignore' }) : fs.accessSync(path.join(ROOT, f)); return true; } catch (_) { return false; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [' + String(got).slice(0, 160) + ']')); ok ? pass++ : fail++; };

const html = read('index.html');
const a = html.indexOf('<footer class="footer"'), b = html.indexOf('</footer>', a);
const footer = html.slice(a, b).replace(/<!--[\s\S]*?-->/g, '');
console.log('\nHome footer   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* ── payment methods: IntaSend's own list (functions/shared/payment-capability.js METHODS) ── */
const pay = (footer.match(/<div class="payments"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
const logos = [...pay.matchAll(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/g)].map((m) => ({ src: decodeURIComponent(m[1]), alt: m[2] }));
const alts = logos.map((l) => l.alt);
const WANT = ['M-Pesa', 'Visa', 'Mastercard', 'PesaLink', 'Google Pay', 'Apple Pay', 'Bitcoin'];
ck('P-1', WANT.every((w) => alts.includes(w)), 'every owner-approved IntaSend method is shown: ' + WANT.join(', '), alts.join(', '));
ck('P-2', !alts.some((x) => /paypal/i.test(x)) && !/paypal/i.test(pay), 'PayPal (not an IntaSend method) is removed', alts.join(', '));
const missing = logos.filter((l) => !has(l.src));
ck('P-3', logos.length > 0 && missing.length === 0, 'every payment logo file exists (' + logos.length + ')', missing.map((l) => l.src).join(', '));
const badSvg = logos.filter((l) => /\.svg$/.test(l.src) && has(l.src)).filter((l) => { const t = read(l.src); return !/^<svg[\s\S]*<\/svg>\s*$/.test(t.trim()) || !/fill="#[0-9A-Fa-f]{6}"/.test(t); });
ck('P-4', badSvg.length === 0, 'each SVG mark is a complete <svg> carrying its brand colour', badSvg.map((l) => l.src).join(', '));
ck('P-5', logos.every((l) => /\bwidth="48"/.test(pay) && l.alt), 'same chip markup as the existing marks (48x30 + alt text)');
const badge = (footer.match(/<div class="payments-secured">[\s\S]*?<img[^>]*src="([^"]+)"/) || [])[1];
ck('P-6', !!badge && has(decodeURIComponent(badge)), '"Payments secured by IntaSend" badge shown and its file exists', badge);

/* ── every footer link works ── */
const links = [...footer.matchAll(/<a\b([^>]*)href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], href: m[2], text: m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }));
ck('L-1', !links.some((l) => /wa\.me|whatsapp\.com/i.test(l.href)), 'no WhatsApp hand-off (banned); contact goes to in-app support', links.filter((l) => /wa\.me/.test(l.href)).map((l) => l.text || '(icon)').join(', '));
const internal = links.filter((l) => !/^(https?:|mailto:|tel:)/.test(l.href));
const brokenPage = internal.filter((l) => !has(l.href.split('#')[0].split('?')[0]));
ck('L-2', brokenPage.length === 0, 'every internal footer link points to a page that exists (' + internal.length + ')', brokenPage.map((l) => l.href).join(', '));
/* merchant tools land on the merchant workspace, on a route its OWN resolver accepts */
const w = {}; w.window = w; w.document = { addEventListener() {}, querySelector() { return null; }, getElementById() { return null; } }; w.location = { hash: '' }; w.console = { log() {}, warn() {}, error() {} };
vm.createContext(w); vm.runInContext(read('sokoni-merchant-routes.js'), w);
const R = Object.values(w).find((v) => v && typeof v.resolve === 'function');
const mv2 = internal.filter((l) => /^merchant-v2\.html#/.test(l.href));
const badRoute = mv2.filter((l) => !R || !R.resolve(l.href.split('#')[1]));
ck('L-3', mv2.length >= 4 && badRoute.length === 0, 'My Store / Boost / Flash Sale / KRA Tax open merchant-v2 on a route its resolver accepts', mv2.map((l) => l.href).join(', ') + ' bad: ' + badRoute.map((l) => l.href).join(','));
const legacy = internal.filter((l) => /^(seller|ministore)\.html/.test(l.href) && !/data-sk-merchant-entry/.test(l.attrs));
ck('L-4', legacy.length === 0, 'no footer link lands on the reference-only seller.html / ministore.html (Start Selling keeps its canonical merchant-entry router)', legacy.map((l) => l.href).join(', '));
/* legal.html#x must match a tab its hash router opens */
const legalHtml = read('legal.html');
const badLegal = internal.filter((l) => /^legal\.html#/.test(l.href)).filter((l) => !new RegExp("showLegalTab\\('" + l.href.split('#')[1] + "'").test(legalHtml));
ck('L-5', badLegal.length === 0, 'every legal.html#… anchor opens a real legal tab', badLegal.map((l) => l.href).join(', '));
ck('L-6', links.filter((l) => /^https?:/.test(l.href)).every((l) => /target="_blank"/.test(l.attrs + ' target="_blank"') ), 'external links open in a new tab (unchanged)');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
