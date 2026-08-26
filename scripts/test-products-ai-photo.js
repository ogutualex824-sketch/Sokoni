/* AI photo editing in the product photos sheet.
 *
 *   node scripts/test-products-ai-photo.js
 *
 * PROVENANCE, because it matters for what this test is claiming. seller.html labelled its
 * product-image input "✨ AI enhanced" and nothing behind it did anything: addProductImages()
 * only made a blob URL, and sokoni-creative.js — which holds the real removeBackground — was
 * never loaded on that page (0 references). So this is the first time product photos are
 * actually edited. A build, not a restore.
 *
 * The two rules this guards:
 *   1. AI changes the IMAGE, never the product record.
 *   2. Entitlement belongs to SokoniAISubs, and a refusal is a refusal.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const V2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. IT REUSES THE EXISTING TOOLS ──────────────────────────────────────── */
console.log('\n1. The existing creative tools, not a second image pipeline');
const CREATIVE = fs.readFileSync(path.join(ROOT, 'sokoni-creative.js'), 'utf8');
['removeBackground', 'enhanceProduct', 'smartCrop'].forEach((fn) => {
  ok(new RegExp('async function ' + fn + '\\(').test(CREATIVE),
     'CONTROL: sokoni-creative.js implements ' + fn);
  ok(SRC.indexOf("fn: '" + fn + "'") > -1, 'Products routes a tool to ' + fn);
});
ok(/window\.SokoniCreative/.test(CODE), 'it calls through the SokoniCreative global');
/* The converse: no image processing of its own. */
ok(!/getImageData|putImageData|drawImage/.test(CODE),
   'Products does NO pixel work itself — the tools own that');

/* ── 2. LOADED, IN THE RIGHT ORDER ────────────────────────────────────────── */
console.log('\n2. The shell loads them before Products');
ok(/<script src="sokoni-creative\.js"><\/script>/.test(V2), 'sokoni-creative.js is loaded');
ok(/<script src="sokoni-ai-subscriptions\.js"><\/script>/.test(V2), 'the quota authority is loaded');
ok(V2.indexOf('sokoni-creative.js') < V2.indexOf('sokoni-merchant-products.js'),
   'both load BEFORE the module that consults them');

/* ── 3. ENTITLEMENT IS NOT OURS TO DECIDE ─────────────────────────────────── */
console.log('\n3. The quota authority owns entitlement');
ok(/checkAndGate\(/.test(CODE), 'it gates through SokoniAISubs.checkAndGate()');
const applyFn = SRC.slice(SRC.indexOf('async function applyAiTool'), SRC.indexOf('function undoAiTool'));
ok(applyFn.length > 400, 'CONTROL: applyAiTool located (' + applyFn.length + ' chars)');
/* Gate BEFORE work: a merchant must not watch a photo process and then be refused. */
ok(applyFn.indexOf('checkAndGate') < applyFn.indexOf('C[tool.fn](file)'),
   'the gate is checked BEFORE the tool runs, not after');
ok(/if \(!allowed\) return;/.test(applyFn),
   'a refusal RETURNS — it never falls through to running the tool anyway');
/* And Products defines no entitlement of its own. */
ok(!/plan\s*===|isPremium|entitled\s*=|quota\s*=/.test(applyFn),
   'Products holds no plan logic of its own');

/* ── 4. IT EDITS THE IMAGE, NOT THE PRODUCT ───────────────────────────────── */
console.log('\n4. AI changes the image; product data is untouched');
ok(/_picked\[index\] = edited;/.test(applyFn), 'the edit replaces the pending FILE');
['name', 'price', 'stock', 'sku', 'specs', 'variants'].forEach((f) => {
  ok(!new RegExp('\\b' + f + '\\s*=(?!=)').test(applyFn),
     'applyAiTool never assigns product.' + f);
});
/* The upload path is unchanged — same media module, same Storage convention. */
ok(/submitPhotos/.test(CODE) && !/putImage\(/.test(applyFn),
   'it does not upload — submitPhotos still owns that through the media module');

/* ── 5. FAILURE AND UNDO ──────────────────────────────────────────────────── */
console.log('\n5. A failed edit costs the merchant nothing');
ok(/The original photo is unchanged/.test(SRC),
   'a failed edit says the original is intact, rather than a bare error');
ok(/_originals\[index\] = _originals\[index\] \|\| file;/.test(SRC),
   'the pre-edit file is kept so an edit can be undone');
ok(/function undoAiTool/.test(CODE) && /data-pr="aiundo"/.test(CODE),
   'undo is reachable');
ok(/_originals = \[\];/.test(SRC),
   'a NEW selection clears the undo copies — there is nothing to undo back to');

/* ── 6. A CUT-OUT MUST NOT BE RE-ENCODED AS JPEG ──────────────────────────── */
console.log('\n6. Transparency survives');
const conv = SRC.slice(SRC.indexOf('function canvasToFile'), SRC.indexOf('async function applyAiTool'));
ok(/png = \(tool === 'rmbg'\)/.test(conv),
   'a removed background is written as PNG');
ok(/image\/png/.test(conv) && /image\/jpeg/.test(conv),
   'both encodings exist, chosen by tool',
   'JPEG has no alpha — re-encoding a cut-out silently paints the transparency black');

/* ── 7. THE MERCHANT CAN SEE WHAT THEY ARE EDITING ───────────────────────── */
console.log('\n7. Previews, and no leaked object URLs');
ok(/function pickedHTML/.test(CODE), 'chosen photos are previewed, not just counted');
ok(/pickedHTML\(\) \+/.test(SRC), 'the previews are MOUNTED in the photos sheet');
ok(/revokeObjectURL/.test(CODE),
   'object URLs are revoked — a repaint per edit would otherwise leak one each time');
ok(/aiBusy/.test(CODE), 'a working state is shown while a tool runs');
/* Absent tools = an honest message, not dead buttons. */
ok(/Photo editing is unavailable on this device/.test(SRC),
   'with the tools absent it says so, rather than rendering buttons that do nothing');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
