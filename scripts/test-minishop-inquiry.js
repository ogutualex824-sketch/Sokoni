#!/usr/bin/env node
/* ============================================================================
   SOKONI MiniShop — contextual business communication
   ============================================================================
   The MiniShop is the canonical storefront: minishop.html + sokoni-minishop.js,
   served at /shop/{handle} and /@{handle} by the live minishopPage function.
   This gate holds the Communications integration added to it, and — just as
   importantly — holds everything the integration was NOT allowed to disturb.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const raw = read('sokoni-minishop.js');
const code = strip(raw);
ok('CONTROL: the stripped controller is readable', code.indexOf('_renderProductSections') !== -1);
ok('CONTROL: stripping removed prose', code.length < raw.length * 0.95);

/* ── 1. STILL ONE STOREFRONT ────────────────────────────────────────────── */
ok('minishop.html is still the storefront template', fs.existsSync(path.join(ROOT, 'minishop.html')));
ok('minishop-page.js is still the single prerender path',
  read('functions/minishop-page.js').indexOf('does NOT') !== -1);
ok('no second storefront controller was created',
  !fs.existsSync(path.join(ROOT, 'sokoni-minishop-comms.js')) &&
  !fs.existsSync(path.join(ROOT, 'minishop-comms.html')));
ok('store.html remains the merchant profile, not a second MiniShop',
  read('store.html').indexOf('content="merchant-profile"') !== -1);

/* ── 2. THE ANCHOR IS A PRODUCT; THE SERVER PICKS THE PERSON ────────────── */
ok('the inquiry anchor type is used', /anchorType:\s*'inquiry'/.test(code));
ok('the anchor is the PRODUCT id', /anchorId:\s*String\(productId\)/.test(code));
ok('availability is asked of the server', code.indexOf("op: 'connectAvailableActions'") !== -1);
ok('the session is requested from the server', code.indexOf("op: 'connectRequestSession'") !== -1);

/* The invariant the whole design rests on. */
['calleeUid', 'recipientUid', 'merchantUid'].forEach((n) => {
  ok('the storefront never sends ' + n, code.indexOf(n) === -1);
});
{
  /* sellerUid may be READ for the certification lookup, but must never be sent
     as a communication recipient. Bound the inquiry functions by brace matching
     and assert on those alone. */
  const names = ['async function _resolveInquiryOffer', 'async function askAboutProduct'];
  names.forEach((hdr) => {
    const i = code.indexOf(hdr);
    ok('CONTROL: ' + hdr.split(' ').pop() + ' located', i !== -1);
    if (i === -1) return;
    let d = 0; const open = code.indexOf('{', i); let k = open;
    for (; k < code.length; k++) {
      if (code[k] === '{') d++; else if (code[k] === '}') { d--; if (!d) break; }
    }
    const body = code.slice(open, k + 1);
    ok(hdr.split(' ').pop() + ' sends no merchant identity',
      !/sellerUid|ownerUid|shopId/.test(body), 'leaked an identity');
  });
}

/* ── 3. THE CONTROL IS SERVER-GATED, NOT DECORATIVE ─────────────────────── */
ok('the ask control ships HIDDEN', /data-ms-ask="\$\{_esc\(p\.id\)\}" hidden/.test(code));
ok('…and is revealed only when the server offers a chat channel',
  /indexOf\('chat'\) !== -1/.test(code) && /el\.hidden = false/.test(code));
ok('a refused availability call reveals nothing',
  /_state\.inquiryOffer = \[\]/.test(code));
ok('availability is resolved ONCE, not per card',
  /if \(_state\.inquiryOffer !== null\) return _state\.inquiryOffer/.test(code));
ok('the reveal runs after every section is drawn',
  code.indexOf('_revealInquiryControls();') > code.indexOf('_initCatalogFilter') - 400);

/* ── 4. SERVICES ARE NOT CONFLATED WITH PRODUCTS ────────────────────────── */
ok('services still route to the existing booking flow',
  /venue-booking\.html\?shopId=/.test(code));
ok('no service id is ever used as an inquiry anchor',
  !/anchorId:\s*String\(serviceId\)/.test(code) && !/serviceId[^\n]*anchorType/.test(code));
{
  /* The service card must not have gained an ask control. */
  const i = code.indexOf('ms-service-card');
  const seg = i === -1 ? '' : code.slice(i, i + 900);
  ok('CONTROL: the service card markup was located', i !== -1);
  ok('the service card offers no inquiry control', seg.indexOf('ms-ask-btn') === -1);
  ok('…and still offers Book', /ms-service-book/.test(seg));
}

/* ── 5. NOTHING THE MINISHOP ALREADY EARNED WAS DISTURBED ───────────────── */
ok('certification still reads sellerCertifications/{sellerUid}',
  raw.indexOf('sellerCertifications') !== -1);
ok('…and still states that a self-minted attestation is not an attestation',
  /* The phrase WRAPS in the source comment, so whitespace is normalised
     rather than the assertion narrowed — it is the sentence that matters. */
  raw.replace(/\s+/g, ' ')
    .indexOf('an attestation the badged party can mint is not an attestation') !== -1);
ok('availability honesty is intact — no invented schedule',
  raw.indexOf("no invented") !== -1);
ok('followers are unchanged', raw.indexOf('shopFollowers/') !== -1);
ok('the product card still offers Add to cart', /ms-add-btn/.test(code));
ok('the wishlist control survives', /ms-wishlist-btn/.test(code));

/* ── 6. PRESENTATION BELONGS TO THE MINISHOP ────────────────────────────── */
{
  const css = read('minishop.css');
  ok('the ask control is styled in the MiniShop stylesheet', css.indexOf('.ms-ask-btn') !== -1);
  ok('…matching the add button geometry', /\.ms-ask-btn[\s\S]{0,400}border-radius: 11px/.test(css));
  ok('…and quieter than it: outline, not solid accent',
    /\.ms-ask-btn[\s\S]{0,400}background: transparent/.test(css));
  ok('…with [hidden] honoured explicitly', css.indexOf('.ms-ask-btn[hidden]') !== -1);
  ok('…and reduced motion respected', /prefers-reduced-motion[\s\S]{0,120}ms-ask-btn/.test(css));
}

/* ── 7. NO SECOND MESSAGE STORE ─────────────────────────────────────────── */
ok('the storefront writes no conversation itself',
  !/collection\(['"]conversations['"]\)/.test(code));
ok('…and writes no message', !/collection\(['"]messages['"]\)/.test(code));
ok('everything goes through connectDispatch', /_callCF\('connectDispatch'/.test(code));

console.log('');
console.log('  SOKONI MiniShop — contextual business communication');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
