#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   CERTIFICATION — the warranty surfaces
   scripts/test-warranty-surfaces.js

   The seller's policy builder in Merchant V2 and the buyer's protection panel with its
   return sheet. Three properties carry this file:

     1. ONE VOCABULARY. Every remedy and reason the seller can offer, and every option the
        buyer can pick, must be one the SERVER accepts. A remedy offered here that the
        server drops is a promise no buyer can ever claim.

     2. THE SURFACES DECIDE NOTHING. No window arithmetic, no fault attribution, no
        liability, and — the one that matters most — no refund amount anywhere.

     3. THE STATE SHOWN IS THE SERVER'S. Never "Refunded" because somebody pressed Submit.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
                      .replace(/<!--[\s\S]*?-->/g, ' ')
                      .replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

const WP = require(path.join(ROOT, 'functions/warranty-policy.js'));
const UISRC = read('sokoni-warranty-ui.js');
const win = {};
vm.runInNewContext(UISRC, { window: win, globalThis: win, console });
const U = win.SokoniWarrantyUI;
const UICODE = strip(UISRC);

/* ══ A. ONE VOCABULARY ═════════════════════════════════════════════════════ */
head('A. the seller can only offer what the server accepts');
{
  const srvRemedies = Object.values(WP.REMEDY);
  const uiRemedies = U.REMEDIES.map((r) => r.key);
  const srvReasons = Object.keys(WP.REASON);
  const uiReasons = U.REASONS.map((r) => r.key);

  /* SUBSET, not equality, and deliberately. Offering FEWER options than the server accepts
     is safe — the server simply never sees them. Offering MORE is the danger: a seller
     would configure a promise the authority drops on validation, and would never find out
     until a buyer tried to claim it. */
  ck('A1  every remedy tile is a remedy the server accepts',
     uiRemedies.every((k) => srvRemedies.indexOf(k) > -1),
     uiRemedies.filter((k) => srvRemedies.indexOf(k) === -1).join(', ') || uiRemedies.length + ' offered');

  ck('A2  every reason tile is a reason the server accepts',
     uiReasons.every((k) => srvReasons.indexOf(k) > -1),
     uiReasons.filter((k) => srvReasons.indexOf(k) === -1).join(', ') || uiReasons.length + ' offered');

  /* Recorded rather than hidden: the builder deliberately omits one reason the server
     supports, so a seller cannot offer change-of-mind returns from Merchant V2. That is a
     product limitation, not an accident, and it belongs in a check somebody will read. */
  const missing = srvReasons.filter((k) => uiReasons.indexOf(k) === -1);
  ck('A3  the reasons the builder does NOT offer are known and few',
     missing.length === 1 && missing[0] === 'changed_mind',
     'server supports [' + missing.join(', ') + '] and the builder does not expose it');

  ck('A4  control: an invented key would fail A1',
     !srvRemedies.includes('free_pony'),
     'so A1 measures the server list rather than agreeing with itself');

  ck('A5  no duration exceeds what the server will accept',
     U.DURATIONS.every((d) => WP.normalisePolicy(
       { durationDays: d.days, remedies: ['refund'], reasons: ['damaged'] }).ok || d.days === 0),
     U.DURATIONS.map((d) => d.days).join(', '));

  ck('A6  "no warranty" is offered as a real answer',
     U.DURATIONS.some((d) => d.days === 0),
     'a seller must be able to state it, not leave the section blank and mean nothing');
}

/* ══ B. THE SURFACES DECIDE NOTHING ════════════════════════════════════════ */
head('B. no decision the server already made is repeated in the browser');
{
  const FORBIDDEN = [
    ['B1  no refund amount is computed',
     /amountMinor|refundAmount|\*\s*100\b|priceMinor|totalMinor/,
     'what a refund is worth is the order\'s'],
    ['B2  no window arithmetic',
     /daysRemaining\s*=[^=]|expiresAt\s*=[^=]|86400000|Date\.now\(\)\s*[-+]/,
     'a clock-skewed phone would tell a buyer their protection ended a day early'],
    ['B3  no fault attribution',
     /SELLER_FAULT\s*=|BUYER_CHOICE\s*=|faultOf\s*\(/,
     'liability is the server\'s answer, rendered'],
    ['B4  no Firestore write',
     /\.set\(|\.update\(|addDoc\(|setDoc\(|updateDoc\(|deleteDoc\(/,
     'every mutation goes through a callable'],
    ['B5  no direct collection read',
     /collection\(['"](orders|products|returnRequests)['"]\)/,
     'the panel renders what warrantyForOrder returned'],
  ];

  for (const [label, re, why] of FORBIDDEN) {
    const m = UICODE.match(re);
    ck(label, !m, m ? 'MATCHED: ' + JSON.stringify(m[0]) : why);
  }

  ck('B6  control: the amount detector fires on a real computation',
     /amountMinor|\*\s*100\b/.test('var minor = Math.round(price * 100);'),
     'so B1 is a measurement, not an empty match');
}

/* ══ C. THE SELLER'S BUILDER ═══════════════════════════════════════════════ */
head('C. a policy built from tiles, with the promise shown back');
{
  const html = U.policyBuilderHTML({ durationDays: 7, remedies: ['refund'], reasons: ['damaged'] });

  ck('C1  every duration, remedy and reason has a tile',
     (html.match(/data-wty="duration"/g) || []).length === U.DURATIONS.length + 1 &&
     (html.match(/data-wty="remedy"/g) || []).length === U.REMEDIES.length &&
     (html.match(/data-wty="reason"/g) || []).length === U.REASONS.length,
     'plus a Custom duration tile');

  ck('C2  the stored policy comes back selected',
     /data-wty="duration" data-key="7" aria-pressed="true"/.test(html) &&
     /data-key="refund" aria-pressed="true"/.test(html) &&
     /data-key="damaged" aria-pressed="true"/.test(html));

  ck('C3  they are buttons with a pressed state, not checkboxes',
     !/type="checkbox"/.test(html) && /aria-pressed=/.test(html),
     'a row of grey checkboxes reads like a settings screen nobody finishes');

  ck('C4  the live preview shows what the BUYER will see',
     /wty-pv/.test(html) && /Protected for 7 days/.test(html) &&
     /starts when the order is delivered/i.test(html),
     'a seller reading a form cannot tell whether they promised anything useful');

  ck('C5  an incomplete policy warns instead of saving quietly',
     /Choose at least one request and one reason/.test(
       U.previewHTML({ durationDays: 7, remedies: [], reasons: [] })),
     'the server refuses a policy that offers nothing');

  ck('C6  "no warranty" previews as sold-as-seen, not as blank',
     /sold as seen/i.test(U.previewHTML({ durationDays: 0 })));

  ck('C7  nothing chosen previews as nothing chosen',
     /choose how long/i.test(U.previewHTML({})),
     'a blank section that looks configured is how a seller ships no protection by accident');

  /* THE ANCHOR IS NOT THE SELLER'S TO CHOOSE. */
  ck('C8  the builder always writes startsAt: delivery',
     /startsAt: 'delivery'/.test(UICODE) &&
     !/startsAt:\s*['"]purchase/.test(UICODE),
     'a purchase anchor would let a slow dispatch shorten what was promised');
}

/* ══ D. THE MERCHANT V2 WIRING ═════════════════════════════════════════════ */
head('D. it is in the real product editor, and it saves');
{
  const prod = strip(read('sokoni-merchant-products.js'));
  const shell = read('merchant-v2.html');

  ck('D1  merchant-v2 loads the module and its stylesheet',
     /<script[^>]+src="sokoni-warranty-ui\.js"/.test(shell) &&
     /<link[^>]+href="sokoni-warranty-ui\.css"/.test(shell));

  ck('D2  the editor renders the section',
     /warrantyHTML\(p\)/.test(prod) && /policyBuilderHTML/.test(prod));

  ck('D3  the tiles are handled in the editor\'s OWN click handler',
     /closest\('\[data-wty\]'\)/.test(prod) && !/mountPolicyBuilder/.test(prod),
     'two handlers on one host is how a repaint leaves one bound to a dead node');

  ck('D4  one duration at a time',
     /data-wty="duration"\][\s\S]{0,400}aria-pressed', 'false'/.test(prod),
     'a policy with two lengths is not a policy');

  ck('D5  the policy is read from the DOM on capture',
     /readBuilder\(host\)/.test(prod) && /_warranty/.test(prod),
     'what is on screen is what gets saved');

  ck('D6  ...and travels as ONE object on save',
     /if \(v\._warranty\) out\.warranty = v\._warranty;/.test(prod),
     'sending its parts separately is how changing the duration loses the remedies');

  ck('D7  an unset policy writes nothing',
     /if \(v\._warranty\)/.test(prod),
     'an absent warranty is a real answer and must not be overwritten on every save');

  ck('D8  a tile tap repaints the PREVIEW, not the whole sheet',
     /function repaintWarranty/.test(prod) && /wty-preview/.test(prod) &&
     !/repaintWarranty[\s\S]{0,200}render\(\)/.test(prod),
     're-rendering the editor would discard whatever the merchant had typed above');

  ck('D9  the section is absent when the module has not loaded',
     /if \(!W\) return '';/.test(prod),
     'a half-rendered policy builder is how a seller saves a promise they did not mean');
}

/* ══ E. THE BUYER'S PANEL ══════════════════════════════════════════════════ */
head('E. the buyer sees the policy pinned to THEIR order');
{
  const view = {
    ok: true, delivered: true,
    warranty: { pinned: true, lines: [{
      line: 0, protected: true, productName: 'Kettle', durationDays: 7, startsAt: 'delivery',
      remedies: ['refund', 'replacement', 'repair'],
      reasons: [{ key: 'damaged', label: 'Damaged' }, { key: 'wrong_product', label: 'Wrong product' }],
      window: { state: 'ACTIVE', daysRemaining: 5, expiresAt: '2026-09-17T00:00:00Z' },
    }] },
  };
  const html = U.warrantyPanelHTML(view);

  ck('E1  the duration and the start basis are shown',
     /Protected for 7 days/.test(html) && /starts when your order is delivered/i.test(html));

  ck('E2  the remaining time is the SERVER\'s figure',
     /5 days remaining/.test(html) && !/daysRemaining\s*=[^=]/.test(UICODE),
     'rendered from the response; a clock-skewed phone must not shorten a warranty');

  ck('E3  only the pinned resolutions and reasons appear',
     /Refund/.test(html) && /Replacement/.test(html) && /Repair/.test(html) &&
     !/Store credit/.test(html) && !/Exchange/.test(html),
     'this seller offered three');

  ck('E4  an ACTIVE window offers the request',
     /wty-request/.test(html));

  const expired = U.warrantyPanelHTML({ ok: true, warranty: { pinned: true, lines: [
    Object.assign({}, view.warranty.lines[0],
      { window: { state: 'EXPIRED', daysRemaining: 0, expiresAt: '2026-08-01T00:00:00Z' } })] } });
  ck('E5  an EXPIRED window EXPLAINS itself instead of hiding the button',
     !/wty-request/.test(expired) && /protection on this item has ended/i.test(expired),
     'a control that vanishes reads as a platform that lost the feature');

  const waiting = U.warrantyPanelHTML({ ok: true, warranty: { pinned: true, lines: [
    Object.assign({}, view.warranty.lines[0], { window: { state: 'NOT_STARTED' } })] } });
  ck('E6  a NOT_STARTED window says the clock has not begun',
     /once this order has been delivered/i.test(waiting),
     'not that the protection ran out');

  const unpinned = U.warrantyPanelHTML({ ok: true, warranty: { pinned: false } });
  ck('E7  an order with nothing pinned says so',
     /has not been recorded yet/i.test(unpinned));

  const noPolicy = U.warrantyPanelHTML({ ok: true, warranty: { pinned: true, lines: [
    { line: 1, protected: false, productName: 'Mug' }] } });
  ck('E8  a line with no policy states it plainly',
     /offers no returns on this item/i.test(noPolicy));

  ck('E9  NOTHING financial appears anywhere in the panel',
     !/riderGross|sokoniCommission|riderEarning|KES/.test(html),
     'a protection panel has no business carrying a figure');
}

/* ══ F. THE RETURN SHEET ═══════════════════════════════════════════════════ */
head('F. only what the pinned policy permits');
{
  const line = {
    line: 0, productName: 'Kettle',
    remedies: ['refund', 'repair'],
    reasons: [{ key: 'damaged', label: 'Damaged' }, { key: 'defective', label: 'Defective' }],
  };

  const step1 = U.refundSheetHTML({ step: 'reason', line: line });
  ck('F1  only the pinned reasons are offered',
     /data-key="damaged"/.test(step1) && /data-key="defective"/.test(step1) &&
     !/data-key="changed_mind"/.test(step1) && !/data-key="missing_item"/.test(step1),
     'an option shown and then refused teaches a buyer the platform is unreliable');

  const step2 = U.refundSheetHTML({ step: 'remedy', line: line, reason: 'damaged' });
  ck('F2  only the pinned resolutions are offered',
     /data-key="refund"/.test(step2) && /data-key="repair"/.test(step2) &&
     !/data-key="store_credit"/.test(step2) && !/data-key="exchange"/.test(step2));

  ck('F3  Continue is disabled until a choice is made',
     /disabled/.test(U.refundSheetHTML({ step: 'reason', line: line })) &&
     !/wty-next" data-wty="next" disabled/.test(
       U.refundSheetHTML({ step: 'reason', line: line, reason: 'damaged' })));

  ck('F4  it reads as help, not as a dispute',
     /here to help make it right/i.test(step1),
     'a buyer opening this has already had a bad experience');

  const review = U.refundSheetHTML({ step: 'review', line: line, reason: 'damaged',
                                     remedies: ['refund'], media: [], note: '' });
  ck('F5  the review states what was chosen',
     /Damaged/.test(review) && /Refund/.test(review));

  /* THE ASSERTION THIS SHEET EXISTS UNDER. */
  ck('F6  NO amount is shown at review, and none is offered',
     !/KES|amount|minor/i.test(review.replace(/SOKONI will confirm[^<]*/g, '')),
     'printing a figure would be this browser promising something it cannot keep');

  ck('F7  ...and it says who will decide it',
     /SOKONI will confirm what you are owed from your order/.test(review));

  ck('F8  evidence is optional and says so',
     /optional/i.test(U.refundSheetHTML({ step: 'evidence', line: line })));
}

/* ══ G. THE OUTCOME IS THE SERVER'S ════════════════════════════════════════ */
head('G. never "Refunded" because somebody pressed Submit');
{
  const requested = U.refundOutcomeHTML({ state: 'REQUESTED' });
  ck('G1  a fresh request shows REQUESTED',
     (() => {
       /* Measured on the HEADLINE. The tracker below it names all three steps by design,
          with only the reached ones lit, so searching the whole block for the word
          'Refunded' asks the wrong question. */
       const h = (requested.match(/wty-out-h">([^<]*)</) || [])[1] || '';
       return /Refund requested/.test(h) && !/^✓ Refunded/.test(h);
     })(),
     'the headline is the claim; the tracker is the map');

  const processing = U.refundOutcomeHTML({ state: 'PROCESSING' });
  ck('G2  PROCESSING is shown as processing',
     /Processing with your payment provider/.test(processing));

  const done = U.refundOutcomeHTML({ state: 'REFUNDED' });
  ck('G3  only a REFUNDED state reads as refunded',
     /✓ Refunded/.test(done));

  ck('G4  the tracker only lights the steps actually reached',
     (requested.match(/is-done/g) || []).length === 1 &&
     (done.match(/is-done/g) || []).length === 3);

  const failed = U.refundOutcomeHTML({ state: 'FAILED' });
  ck('G5  a failed provider call says it is being retried',
     /retrying/i.test(failed), 'an outage is not a refusal');

  /* SELLER FAULT IS RENDERED, NOT DERIVED. */
  const sellerFault = U.refundOutcomeHTML({ state: 'REQUESTED',
    returnDelivery: { payer: 'SELLER', settled: 'automatic' } });
  ck('G6  seller-fault return delivery is stated to the buyer',
     /seller-fault return delivery/i.test(sellerFault) &&
     /will not pay to send it back/i.test(sellerFault));

  const buyerPays = U.refundOutcomeHTML({ state: 'REQUESTED',
    returnDelivery: { payer: 'BUYER', settled: 'automatic' } });
  ck('G7  a buyer-liable return says that too',
     /return delivery for this request is the buyer/i.test(buyerPays));

  const review = U.refundOutcomeHTML({ state: 'REQUESTED',
    returnDelivery: { payer: null, settled: 'requires_review' } });
  ck('G8  an undetermined fault is held, not guessed',
     /confirmed on review/i.test(review),
     'defaulting an unknown to the party with less power is how a policy becomes unfair');
}

/* ══ H. THE BUYER PAGE WIRING ══════════════════════════════════════════════ */
head('H. it is on the real order page, and submits only what the buyer chose');
{
  const page = read('delivery-tracking.html');
  const slice = strip(page);

  ck('H1  the page loads the module and its stylesheet',
     /<script[^>]+src="sokoni-warranty-ui\.js"/.test(page) &&
     /<link[^>]+href="sokoni-warranty-ui\.css"/.test(page));

  ck('H2  it renders the panel from warrantyForOrder',
     /warrantyForOrder/.test(slice) && /warrantyPanelHTML/.test(slice));

  ck('H3  it submits through requestReturn',
     /requestReturn/.test(slice));

  /* WHAT IS SENT — the whole safety property of this surface. */
  ck('H4  the submission carries ONLY the buyer\'s choices',
     (() => {
       /* Anchored to the SUBMIT function. Taking the first `fn({` in the file caught the
          loader's own call, which carries no remedy at all — a slice that measures the
          wrong call is a check that proves nothing about the one that matters. */
       const at = slice.indexOf('function submit');
       const from = slice.indexOf('fn({', at);
       const call = slice.slice(from, slice.indexOf('}).then', from));
       return /orderId/.test(call) && /lineIndex/.test(call) && /reason/.test(call) &&
              /remedies/.test(call) && /note/.test(call) && /media/.test(call) &&
              !/amount/i.test(call) && !/fault/i.test(call) &&
              !/policy/i.test(call) && !/liab/i.test(call);
     })(),
     'no amount, no fault, no liability, no policy');

  ck('H5  the outcome is rendered from the SERVER response',
     /refundOutcomeHTML\(d\)/.test(slice),
     'never from what the buyer pressed');

  ck('H6  a refusal shows the server\'s own wording',
     /e\.message \|\| e\.code/.test(slice),
     'WINDOW_EXPIRED is actionable; "something went wrong" is not');

  ck('H7  the page writes nothing to Firestore',
     !/\.set\(|setDoc\(|updateDoc\(|addDoc\(/.test(
       slice.slice(slice.indexOf('BUYER WARRANTY'), slice.length)),
     'every mutation goes through a callable');

  ck('H8  the PIN handbook is untouched',
     /pinProtectionHTML|showPinProtection/.test(page) &&
     /pinProtectionBadgeHTML/.test(page),
     'd4de4b8 is preserved, not replaced');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
