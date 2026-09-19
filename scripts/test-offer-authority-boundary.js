/* ══════════════════════════════════════════════════════════════════════════════
   GATE P1–P4 — THE OFFER AUTHORITY BOUNDARY, made observable
   scripts/test-offer-authority-boundary.js    node scripts/test-offer-authority-boundary.js

   The four owner decisions are not implementable yet, but they ARE testable now — as
   predicates over the code that exists. Each section below encodes one decision so that a
   future implementation either satisfies it or fails loudly, and so that the boundary
   cannot erode while nobody is looking.

   This suite asserts NOTHING about a merchant offer store, because none exists. What it
   pins is everything around the hole: which authority owns what, which collection means
   what, where money is decided, and the containment that currently keeps a known collision
   from reaching customers.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, note = 0;
function ok (n, c, d) {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
}
function observed (n, d) { note++; console.log('  NOTE  ' + n + (d ? '   [' + d + ']' : '')); }
function head (t) { console.log('\n' + t); }

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PROMOS = read('functions/promotions.js');
const FINOS = read('functions/finos.js');
const FINOSU = read('functions/finos-utils.js');
const EMPLOY = read('functions/shop-employees.js');
const INDEX = read('functions/index.js');
const RULES = read('firestore.rules');
const RECORD = read('sokoni-offer-record.js');

console.log('══════════════════════════════════════════════════════════════════');
console.log('  GATE P1-P4 — offer authority boundary');
console.log('══════════════════════════════════════════════════════════════════');

/* ── P1 · COLLECTION AUTHORITY ──────────────────────────────────────────────── */
head('P1 - three concepts, three collections, no aliasing');
{
  /* offers — admin product price drop, governed by rules. */
  const ob = RULES.slice(RULES.indexOf('match /offers/{offerId}'),
                         RULES.indexOf('match /offers/{offerId}') + 700);
  ok('`offers` is admin-write and product-anchored',
     /allow create: if isAdmin\(\)/.test(ob) && /productId/.test(ob));

  /* promotions — admin content, and admin promo codes. Both admin, neither merchant. */
  ok('`promotions` banner writes are admin-only',
     /exports\.promotionUpsert[\s\S]{0,200}_assertAdmin/.test(PROMOS));
  ok('`promotions` promo-code writes are admin-only',
     /exports\.createPromotion[\s\S]{0,400}_assertAdmin/.test(FINOS));

  /* THE RULE THE OWNER SET: no aliasing these three to save a collection. A merchant offer
     store must be its OWN name, and the record module must not quietly adopt an existing
     one. Today it names none at all, which is the strongest form of this. */
  const rec = strip(RECORD);
  ok('the record module names no collection at all',
     !/['"](offers|promotions|promotionUsage|shopOffers)['"]/.test(rec));
  ok('and it opens no datastore connection',
     !/collection\(|firestore|firebaseDB|setDoc|addDoc|httpsCallable/.test(rec));

  /* The candidate name must remain a PROPOSAL until the contract is settled — so it must
     not yet appear as a live identifier anywhere in shipped code. */
  const liveCode = ['sokoni-offer-record.js', 'sokoni-merchant-offers.js', 'merchant-v2.html']
    .map(read).join('\n');
  ok('`shopOffers` is still only a proposal, not a live identifier',
     !/['"]shopOffers['"]/.test(liveCode));
}

/* ── P2 · WRITE AUTHORIZATION ───────────────────────────────────────────────── */
head('P2 - the authorization boundary to reuse');
{
  ok('assertShopAccess exists and resolves through resolveShopAccess',
     /async function assertShopAccess\(uid, shopId\)/.test(EMPLOY) &&
     /resolveShopAccess\(uid, shopId\)/.test(EMPLOY));

  /* The three ways in are explicit, so "admin behaviour" is defined rather than inferred. */
  ok('owner is a defined path', /return \{ role: 'owner', via: 'owner'/.test(EMPLOY));
  ok('employee is a defined path', /via: 'employee'/.test(EMPLOY));
  ok('admin is a defined path, not an accident', /via: 'admin'/.test(EMPLOY));
  ok('anything else is refused',
     /throw new HttpsError\('permission-denied', 'You do not have access to this shop\.'\)/.test(EMPLOY));

  /* The role vocabulary a decision must choose from. posRole is minted by nothing and must
     never become an offer permission. */
  const roles = (EMPLOY.match(/const SHOP_ROLES = Object\.freeze\(\[([^\]]+)\]/) || [])[1] || '';
  ok('the shop role vocabulary is closed and known', roles.length > 0, roles.replace(/'/g, ''));
  ok('no posRole is used as an access role', !/posRole/.test(EMPLOY));

  /* The reference write pattern the offer callable must follow. */
  const INV = read('functions/merchant-inventory.js');
  ok('the reference callable enforces App Check', /enforceAppCheck: true/.test(INV));
  ok('it authorises against the SHOP, not a claim', /await assertShopAccess\(uid, shopId\)/.test(INV));
  ok('it is idempotent by a caller-supplied id', /adjustmentId is required/.test(INV));
  ok('and applies inside a transaction', /runTransaction/.test(INV));
}

/* ── P3 · REDEMPTION ACCOUNTING ─────────────────────────────────────────────── */
head('P3 - promotionUsage is FinOS money accounting, not a generic counter');
{
  ok('promotionUsage is written only by the FinOS money layer',
     /collection\('promotionUsage'\)/.test(FINOSU) &&
     !/promotionUsage/.test(PROMOS));

  /* THE REASON IT MUST NOT BE REUSED. Redemption here carries FUNDING ATTRIBUTION — who
     paid for the discount, platform or seller, and in what proportion. A merchant's own
     bundle discount is funded by the merchant by definition; writing it into this ledger
     would file merchant-funded money against a platform funding split. */
  ok('promo codes carry funding attribution',
     /fundedBy/.test(FINOS) && /platformFundingPct/.test(FINOS) && /sellerFundingPct/.test(FINOS));
  ok('redemption increments the promo document transactionally',
     /runTransaction[\s\S]{0,400}usageCount: admin\.firestore\.FieldValue\.increment\(1\)/.test(FINOSU));
  ok('and records the buyer and order it was spent on',
     /buyerUid: buyerUid \|\| null, orderId: orderId \|\| null/.test(FINOSU));

  /* So the decision is a SEPARATE counter. Observable today as: nothing in the merchant
     offer path references promotionUsage. */
  const merchantSide = [read('sokoni-merchant-offers.js'), read('sokoni-promotion-model.js'),
                        RECORD].join('\n');
  ok('no merchant offer surface touches promotionUsage', !/promotionUsage/.test(merchantSide));
  ok('nor writes usageCount', !/usageCount/.test(merchantSide));
}

/* ── P4 · CHECKOUT RESOLUTION BOUNDARY ──────────────────────────────────────── */
head('P4 - where the authoritative money decision happens');
{
  /* The precedent is already set, in the one place that charges. */
  ok('the charge path decides the discount server-side',
     /const \{ validatePromoCode \} = require\('\.\/finos-utils'\)/.test(INDEX));
  /* ASSERTED ON BEHAVIOUR, NOT ON A COMMENT. The first version of this check matched the
     prose above the code — which proves only that someone wrote the sentence, and this
     codebase has been bitten by exactly that. What matters is where the number comes from:
     the discount is computed from the VALIDATOR's result, and the client's contribution is
     a code string and nothing else. */
  const promoBlock = strip(INDEX).slice(
    strip(INDEX).indexOf('let promoDiscount = 0;'),
    strip(INDEX).indexOf('Loyalty point redemption') > -1
      ? strip(INDEX).indexOf('let loyaltyDiscount') : undefined);
  ok('the discount is derived from the validator result only',
     /promoDiscount = Math\.min\(\s*Math\.round\(\(_res\.discountCents/.test(promoBlock));
  ok('the client contributes a code string and nothing else',
     /const _promoCode = String\(promoCode \|\| ""\)\.trim\(\)\.toUpperCase\(\)/.test(strip(INDEX)));
  ok('no client-supplied discount amount is ever read',
     !/\b(data|request\.data)\.(discount|promoDiscount|discountCents|amountOff)\b/.test(strip(INDEX)));
  ok('the discount is capped against the server subtotal',
     /Math\.min\(\s*Math\.round\(\(_res\.discountCents \|\| 0\) \/ 100\),/.test(INDEX));
  ok('an invalid code is ignored rather than fatal',
     /ignored rather than fatal/.test(INDEX));
  ok('the delivery fee is also resolved server-side',
     /resolveQuoteForCheckout\(deliveryQuoteId, request\.auth\.uid\)/.test(INDEX));

  /* THE CUSTOMER-FACING RESOLVER STAYS A DISPLAY QUOTE. Every surface already says so; if
     one ever stops saying it, that is the moment a client-side figure starts reading as a
     promise. */
  const view = read('sokoni-offer-view.js');
  ok('the offer panel still tells the customer the price is confirmed at checkout',
     /confirmed at checkout/.test(view));
  ok('the promotion model still declares itself a display quote',
     /display quote/.test(read('sokoni-promotion-model.js')));
  /* And it must not have acquired a charge path of its own. */
  ok('the client resolver charges nothing',
     !/createCheckoutSession|createPaymentIntent|charge\(/.test(read('sokoni-promotion-model.js')));
}

/* ── OBSERVED: a pre-existing collision, pinned at its containment ──────────── */
head('OBSERVED - `promotions` already carries two incompatible shapes');
{
  /* Not a Gate P defect and not repaired here — but it is the concrete demonstration of
     what aliasing two concepts onto one collection costs, which is exactly the rule P1
     exists to hold. Reported, and its CONTAINMENT pinned. */
  observed('promotionUpsert writes a banner', 'placement · title · body · ctaUrl · status');
  observed('createPromotion writes a promo code',
           'code · discountType · fundedBy · usageCount · isActive');
  observed('both write the same collection', "functions/promotions.js COL='promotions'" +
           " and functions/finos.js collection('promotions')");

  /* THE CONTAINMENT THAT KEEPS IT OFF CUSTOMER SURFACES: the public banner read filters on
     status == 'published', and a promo code has no `status` field at all — it has
     `isActive`. If that filter is ever removed, promo codes surface as banners. */
  ok('the PUBLIC banner read filters on published status',
     /where\('status', '==', 'published'\)/.test(PROMOS));
  ok('promo codes carry isActive, not status, so the filter excludes them',
     /isActive:\s*true/.test(FINOS) && !/^\s*status:/m.test(
       FINOS.slice(FINOS.indexOf('exports.createPromotion'), FINOS.indexOf('writeAuditLog'))));

  /* The admin listing does NOT filter, so it renders promo codes as fieldless banners.
     Admin-only, display-only — recorded so it is not rediscovered as new. */
  const listFn = PROMOS.slice(PROMOS.indexOf('exports.promotionList'),
                              PROMOS.indexOf('exports.promotionArchive'));
  observed('promotionList does not filter by shape',
           /collection\(COL\)\.limit\(300\)\.get\(\)/.test(listFn)
             ? 'admin listing shows promo codes with undefined title/placement'
             : 'filter present — re-check this note');
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  P2 authorisation refusal at runtime   [needs the callable to exist]');
console.log('  UNPROVEN  P2 cross-shop isolation at rest       [needs stored documents]');
console.log('  UNPROVEN  P3 the chosen counter                 [decision, then implementation]');
console.log('  UNPROVEN  P4 merchant offers applied at charge  [needs the server-side resolver]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + note + ' observed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
