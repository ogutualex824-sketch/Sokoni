/* ============================================================================
   Product-detail reviews — canonical identity, canonical source, honest states.

   Run:  node scripts/test-product-reviews.js       (no emulator, no network)

   WHAT WAS WRONG
   product.js rendered TWO HARDCODED review cards on EVERY product page:

       <div class="review-card">
         <div class="review-top">⭐⭐⭐⭐☆</div>
         <p>Premium hoodie quality. Sokoni is becoming elite 🔥</p>
         <span>— Brian</span>
       </div>

   Five stars and four stars, a body praising a "premium hoodie", and an invented
   reviewer called Brian — shown regardless of what the product was or whether
   anyone had ever reviewed it. Fabricated social proof on the page a buyer uses to
   decide, and the same defect class as the 21 invented reviews removed from
   reviews.html in 92c7536.

   THE CONTRACT NOW
     * content comes from the canonical getReviews Cloud Function, never markup
     * the review target is the canonical product id from ?id=, never the NAME
     * the client never queries reviews/{id} and never writes an aggregate
     * a FAILED read says so; it is never rendered as "no reviews" or as 0
============================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments quote the removed markup to explain it, so absence assertions must run
   against executable code only. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const prd = code('product.js');

console.log('\nNo fabricated review content survives');
ck('the invented reviewer "Brian" is gone', !/—\s*Brian/.test(prd));
ck('the invented "premium hoodie" body is gone', !/[Pp]remium hoodie/.test(prd));
ck('no hardcoded star run in markup', !/⭐⭐⭐⭐/.test(prd));
ck('no literal <div class="review-card"> in static markup',
   !/<div class="review-card">\s*\n?\s*<div class="review-top">\s*⭐/.test(prd));

console.log('\nContent comes from the canonical Cloud Function');
ck('reads through getReviews', /httpsCallable\(fns, 'getReviews'\)/.test(prd));
ck('client never queries the reviews collection directly',
   !/collection\(['"]reviews['"]\)/.test(prd));
ck('client never writes ratingsSummary',
   !/ratingsSummary/.test(prd) || !/set\(|update\(|add\(/.test(
     (prd.match(/ratingsSummary[^\n]*/g) || []).join('\n')));
ck('client never calls the retired SokoniDB.saveReview bypass',
   !/saveReview\s*\(/.test(prd));

console.log('\nTarget identity is the canonical product id, never a name');
ck('a target-id helper exists', /_prdReviewTargetId/.test(prd));
ck('the target is derived from the ?id= url parameter', /var id = _urlId/.test(prd));
ck('the review target is never the product name',
   !/targetId:\s*(product\.)?name|targetId:\s*[^,\n]*\.name/.test(prd));
ck('getReviews is called with the derived target id',
   /call\(\{ targetId: targetId/.test(prd));

console.log('\nUnknown is never rendered as zero');
{
  const fnBody = (prd.match(/async function _prdLoadReviews\(\)[\s\S]*?\n\}/) || [''])[0];
  ck('a failed read reports unavailability, not "no reviews"',
     /Reviews are unavailable right now/.test(fnBody));
  ck('the catch block does NOT claim zero reviews',
     !/No reviews yet/.test(fnBody));
  ck('"No reviews yet" is only used on a SUCCESSFUL empty result',
     /_prdRenderReviews[\s\S]*?No reviews yet/.test(prd));
  ck('a slow review read cannot block the product render (not awaited)',
     /try \{ _prdLoadReviews\(\); \}/.test(prd));
}

console.log('\nRendered review content is escaped');
{
  const r = (prd.match(/function _prdRenderReviews[\s\S]*?\n\}/) || [''])[0];
  ck('an escape helper is applied', /esc\(/.test(r));
  ck('the body is escaped',        /esc\(r\.body/.test(r));
  ck('the author name is escaped', /esc\(r\.authorName/.test(r));
  ck('the title is escaped',       /esc\(r\.title\)/.test(r));
  ck('the rating is clamped to 0..5 before building stars',
     /Math\.max\(0, Math\.min\(5, Number\(r\.rating\)/.test(r));
}

console.log('\nThe server contract this depends on');
{
  const rv = read('functions/reviews.js');
  ck('getReviews returns only approved reviews',
     /\.where\("status", "==", "approved"\)/.test(rv));
  ck('the author uid is stripped before returning', /delete r\.authorUid/.test(rv));
  ck('authorName is the field the client renders', /r\.authorName = nameMap/.test(rv));
  ck('one review per user per target is enforced',
     /already reviewed this/.test(rv));
  ck('the daily submit limit is 3', /_checkReviewRateLimit\(uid, "submit", 3\)/.test(rv));
  ck('ratingsSummary is keyed by the bare targetId',
     /collection\("ratingsSummary"\)\.doc\(targetId\)/.test(rv));

  /* The stale-format drift trap: the header documented "{type}_{entityId}" while
     every caller passes a bare id, so anyone following it would key a summary no
     surface reads. */
  ck('the stale "{type}_{entityId}" format claim is gone',
     !/targetId format: "\{type\}_\{entityId\}"/.test(rv));
  ck('the bare-id convention is documented instead',
     /the BARE canonical entity id/.test(rv));
  ck('names are documented as never being identity', /NEVER a product or business NAME/.test(rv));
}

console.log('\nThe Shop grid and the detail page agree on target identity');
{
  const cat = code('category.js');
  ck('the grid hydrates ratingsSummary by bare product id',
     /collection\('ratingsSummary'\)/.test(cat) && /data-rating-pid/.test(cat));
  ck('the grid does not prefix the id with a type',
     !/['"]product_['"]\s*\+/.test(cat));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
