/* Quick Charge + mixed basket — the UI wiring.

   The model is certified separately (scripts/test-pos-basket.js). This suite
   asserts the WIRING, and above all where it STOPS: this slice prepares a
   basket and totals it, and must not touch the live money path.
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/^\s*\/\/.*$/gm, '')
                      .replace(/<!--[\s\S]*?-->/g, '');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 76) + ']' : ''));
  ok ? pass++ : fail++;
};

const posHtml = read('pos.html');
const posJs   = read('pos.js');
const qcJs    = read('sokoni-pos-quick-charge.js');
const conJs   = read('sokoni-pos-pay-console.js');

console.log('\n── The till loads the pieces, in order ──');
{
  ck('basket model is loaded', /src="sokoni-pos-basket\.js"/.test(posHtml));
  ck('quick charge is loaded', /src="sokoni-pos-quick-charge\.js"/.test(posHtml));
  /* Compare SCRIPT TAG positions, not any mention of the filename: pos.html
     names sokoni-pos-pay-console.js in a comment 1,400 lines above its own
     <script> tag, and a bare indexOf read that comment as the load order. */
  const tagAt = (f) => posHtml.indexOf('src="' + f + '"');
  ck('…the model loads BEFORE the controller that uses it',
     tagAt('sokoni-pos-basket.js') < tagAt('sokoni-pos-quick-charge.js'),
     tagAt('sokoni-pos-basket.js') + ' < ' + tagAt('sokoni-pos-quick-charge.js'));
  ck('…and before the payment console that renders the groups',
     tagAt('sokoni-pos-basket.js') < tagAt('sokoni-pos-pay-console.js'),
     tagAt('sokoni-pos-basket.js') + ' < ' + tagAt('sokoni-pos-pay-console.js'));
  /* Positive control: the tag locator finds real tags, so an ordering that
     passed because both were -1 would fail here. */
  ck('…and the tag locator actually found them',
     tagAt('sokoni-pos-basket.js') > 0 && tagAt('sokoni-pos-pay-console.js') > 0);
  ck('a Quick Charge tile exists', /SPosQuickCharge\.open\(\)/.test(posHtml));
  ck('the quick-charge sheet exists', /id="qc-modal"/.test(posHtml));
}

console.log('\n── The form asks for what the server requires ──');
{
  for (const [id, what] of [['qc-desc', 'description'], ['qc-amount', 'amount'],
                            ['qc-qty', 'quantity'], ['qc-phone', 'customer phone']]) {
    ck(`the form has a ${what} field`, new RegExp('id="' + id + '"').test(posHtml));
  }
  ck('the description is length-capped in the markup', /id="qc-desc"[^>]*maxlength="140"/.test(posHtml));
  ck('it is labelled a CUSTOM SERVICE CHARGE', /CUSTOM SERVICE CHARGE/.test(posHtml));
  ck('…and says SOKONI confirms the amount before payment',
     /confirmed by SOKONI before any payment is taken/.test(posHtml));
}

console.log('\n── The ceiling is NOT duplicated in the frontend ──');
{
  const all = strip(posHtml) + strip(qcJs) + strip(read('sokoni-pos-basket.js'));
  ck('no 20,000 anywhere in the UI', !/20000|20,000|2000000/.test(all));
  ck('no ceiling constant is declared', !/CEILING\s*=|MAX_QUICK|QUICK_MAX/.test(all));
  ck('the merchant figure is only ADVISORY where present',
     /advisoryCeilingCents/.test(qcJs));
  ck('…and is never defaulted when absent',
     /Number\.isFinite\(Number\(v\)\) \? Number\(v\) : null/.test(qcJs));
}

console.log('\n── Attribution is mandatory ──');
{
  ck('the controller resolves a cashier', /_cashierUid/.test(qcJs));
  ck('opening is refused with no cashier',
     /Sign in to the till before adding a custom charge/.test(qcJs));
  ck('adding is refused with no cashier',
     /must be attributable/.test(qcJs));
  ck('pos.js refuses an unattributed line',
     /must be attributed to a cashier/.test(posJs));
}

console.log('\n── The cart gained ONE narrow method ──');
{
  ck('addCustomLine exists', /addCustomLine\s*\(line\)\s*\{/.test(posJs));
  ck('…it validates id and name', /needs an id and a name/.test(posJs));
  ck('…it validates a price', /needs a price/.test(posJs));
  ck('…it refuses a duplicate id', /already on this sale/.test(posJs));
  /* Two custom charges must not merge the way two scans of a product do. */
  ck('…and it does NOT merge by incrementing qty',
     !/addCustomLine[\s\S]{0,400}existing\.qty\+\+/.test(posJs));
  ck('addItem (the catalogue path) is untouched and still merges',
     /const existing = state\.cartItems\.find\(i => i\.id === productId\);[\s\S]{0,60}existing\.qty\+\+/.test(posJs));
}

console.log('\n── The mixed basket is shown before money is taken ──');
{
  ck('the console renders basket groups', /_renderBasket/.test(conJs));
  ck('…from SPosBasket, not its own arithmetic', /window\.SPosBasket/.test(conJs));
  ck('…and hides itself when the sale is one kind', /grouped\.length < 2/.test(conJs));
  ck('the host element exists', /id="paycon-basket"/.test(posHtml));
}

console.log('\n── THIS SLICE STOPS BEFORE THE MONEY ──');
{
  const mine = strip(qcJs) + strip(read('sokoni-pos-basket.js'));
  ck('no completeMultiTender implementation', !/completeMultiTender\s*[:=]\s*function|function completeMultiTender/.test(mine));
  ck('no createPaymentIntent call', !/createPaymentIntent/.test(mine));
  ck('no IntaSend call', !/intasend/i.test(mine));
  ck('no webhook reference', !/webhook/i.test(mine));
  ck('nothing is marked paid', !/paymentVerified|markPaid|\bpaid\s*=\s*true/.test(mine));
  ck('quick charge only ADDS A LINE', /SPos\.cart\.addCustomLine\(line\)/.test(qcJs));
  /* Positive control — the stripper left real code to scan. */
  ck('…and the scan saw real code', /function add\(\)/.test(mine), mine.length + ' chars');
}

console.log('\n── pos.js: the live sale path is otherwise untouched ──');
{
  const { execSync } = require('child_process');
  const stat = execSync('git diff HEAD --numstat -- pos.js', { cwd: root, encoding: 'utf8' }).trim();
  const [add, del] = stat ? stat.split(/\s+/).map(Number) : [0, 0];
  ck('pos.js gained lines and deleted NONE', del === 0, stat || '(no diff)');
  ck('…a small addition', add > 0 && add < 40, add + ' added');
  const changedPay = /payment\.complete|mpesa\.sendSTK|saveAndRedirect/.test(
    execSync('git diff HEAD -- pos.js', { cwd: root, encoding: 'utf8' })
      .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n'));
  ck('…and it touches no payment function', !changedPay);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOT asserted (needs a browser): that the sheet renders and the');
console.log('  line appears in the cart. Verify visually before deploy.\n');
process.exit(fail ? 1 : 0);
