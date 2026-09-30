/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MEDIA STUDIO and LISTING LIFECYCLE
   scripts/test-media-lifecycle.js      node scripts/test-media-lifecycle.js

   TWO THINGS THAT COULD EASILY HAVE BEEN DECORATION

   The spec sketches a media panel reading "✓ Optimized ✓ Correct aspect ratio ✓ Ready for
   publishing". The tempting build is four ticks that are always green — and a merchant
   reads those as a check that ran. So the assertions here pin that every line is a fact
   this surface can establish, and that what it cannot measure it does not claim.

   The lifecycle buttons could equally have been a fixed row of Draft / Review / Live /
   Archived. They are built from the model's own transition table instead, so a button that
   appears is one canTransition() will accept.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'sokoni-listing-types.js'));
const LM = require(path.join(ROOT, 'sokoni-listing-model.js'));
const LS = require(path.join(ROOT, 'sokoni-listing-studio.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── 1. LIFECYCLE OFFERS ONLY LEGAL MOVES ───────────────────────────────────── */
section('Lifecycle transitions');
{
  const draft = LS.lifecycleHTML({ id: 'p1', status: 'draft' });
  ok('a draft may be published', draft.indexOf('data-to="live"') > -1);
  ok('a draft may be sent to review', draft.indexOf('data-to="review"') > -1);
  ok('a draft may be archived', draft.indexOf('data-to="archived"') > -1);
  /* A draft is not "paused" — there is nothing running to pause. */
  ok('a draft may NOT be paused', draft.indexOf('data-to="paused"') === -1);
  ok('control — a LIVE listing may be paused',
     LS.lifecycleHTML({ id: 'p1', status: 'active' }).indexOf('data-to="paused"') > -1);

  const archived = LS.lifecycleHTML({ id: 'p1', lifecycle: 'archived' });
  ok('an archived listing may only return to draft',
     archived.indexOf('data-to="draft"') > -1 && archived.indexOf('data-to="live"') === -1);

  /* EVERY BUTTON MUST BE A MOVE THE MODEL ACCEPTS. Built from the table rather than by
     hand, so this cannot drift. */
  ['draft', 'review', 'live', 'paused', 'archived'].forEach(function (from) {
    const html = LS.lifecycleHTML({ id: 'p1', lifecycle: from });
    const offered = (html.match(/data-to="(\w+)"/g) || [])
      .map(function (m) { return m.slice(9, -1); });
    const legal = offered.every(function (to) { return LM.canTransition(from, to); });
    ok('from ' + from + ': every offered move is legal (' + (offered.join(',') || 'none') + ')', legal);
  });

  /* NOTHING MOVES UNTIL IT EXISTS. */
  ok('an unsaved listing is offered no transitions',
     LS.lifecycleHTML({ status: 'draft' }).indexOf('data-ls="life"') === -1);
  ok('control — a saved one is', draft.indexOf('data-ls="life"') > -1);
}

/* ── 2. PUBLISHING IS GATED, AND SAYS WHY ───────────────────────────────────── */
section('Publish gate');
{
  ok('the handler validates before going live', /to === 'live' && LM && LS2/.test(code));
  ok('and refuses with the missing fields NAMED',
     /Not published — still needed: /.test(src));
  /* THE DEFECT THE BROWSER CAUGHT. Visibility is active-or-draft; the lifecycle has five
     states. Writing 'paused' into `status` set a value with no matching <option>, so the
     select silently showed "active" while the chain read "Paused" — two states disagreeing
     on screen. Each state now maps to the visibility it implies, with the precise state
     kept in its own field. */
  ok('a state maps to a visibility the select can actually show',
     /S\.editor\.values\.status = \(to === 'live'\) \? 'active' : 'draft';/.test(code));
  ok('and the precise state is kept separately',
     /S\.editor\.values\.lifecycle = to;/.test(code));
  /* The point is what is ASSIGNED, not what is tested — `to` appears in the ternary's
     condition, so a line-wide search for it flagged a correct assignment. Both branches
     must be quoted literals from the visibility vocabulary. */
  const assigned = (code.match(/values\.status = [^;]+;/g) || [])
    /* Drop the parenthesised condition — `to === 'live'` is a TEST, not an assigned value,
       and counting its literal was the second time this matcher read the wrong half. */
    .map(function (s) { return s.replace(/\([^)]*\)/g, ''); })
    .join(' ').match(/'([a-z]+)'/g) || [];
  ok('only visibility values are ever assigned to status',
     assigned.length > 0 && assigned.every(function (v) {
       return v === "'active'" || v === "'draft'";
     }), assigned.join(','));
  ok('a hidden state says it is hidden from buyers',
     src.indexOf('hidden from buyers') > -1);
  /* And the chain must read the precise field, not infer from visibility. */
  ok('the chain prefers the explicit lifecycle',
     LS.lifecycleHTML({ id: 'p1', status: 'draft', lifecycle: 'paused' })
       .indexOf('ls-life-s on">Paused') > -1);
  ok('control — with no lifecycle it falls back to visibility',
     LS.lifecycleHTML({ id: 'p1', status: 'draft' }).indexOf('ls-life-s on">Draft') > -1);
  /* THE WRITE IS STILL THE MERCHANT'S. This button changes what will be saved; it must not
     save anything by itself, or the certified writer has been bypassed. */
  ok('it does not write — the merchant still presses Save',
     src.indexOf('Press Save to apply it.') > -1);
  const lifeBlock = code.slice(code.indexOf("lsKind === 'life'"), code.indexOf("lsKind === 'device'"));
  ok('and the handler calls no writer', !/createProduct|updateProduct|md\(\)/.test(lifeBlock));
}

/* ── 3. MEDIA CHECKS ARE MEASURED, NOT ASSERTED ─────────────────────────────── */
section('Media checks');
{
  const fn = code.slice(code.indexOf('function mediaChecksHTML'), code.indexOf('function shotListHTML'));
  ok('the panel exists', fn.length > 200);

  /* THE ASPECT-RATIO TRAP. It cannot be measured synchronously from a URL, so it must not
     be claimed. A green "correct aspect ratio" that ran no check is the exact decoration
     this suite exists to prevent. */
  ok('no aspect-ratio claim is made', !/aspect/i.test(fn));
  ok('no blanket "ready for publishing" tick', !/ready for publishing/i.test(fn));

  /* What IS claimed must come from something countable or held. */
  ok('the photo count comes from the listing', /have\.length/.test(fn));
  ok('the pending count comes from the picked files', /_picked\.length/.test(fn));
  ok('file size is read from the File, never estimated', /typeof f\.size === 'number'/.test(fn));
  ok('an unknown size is not printed as a number', /known = false/.test(fn));

  ok('no photos is a warning, not a tick', /line\('warn', 'No photos/.test(fn));
  ok('and it explains the consequence', /rarely opened/.test(src));
  ok('fewer than three photos is a warning', /have\.length >= 3 \? 'ok' : 'warn'/.test(fn));
}

/* ── 4. REORDER MOVES WHAT IT CAN, AND ONLY THAT ────────────────────────────── */
section('Photo order');
{
  ok('pending photos can be reordered', /data-pr="pmove"/.test(code));
  ok('the first is labelled Main, since it becomes the main image',
     /i === 0 \? 'Main'/.test(code));
  ok('the ends are disabled rather than wrapping',
     /i === 0 \? ' disabled'/.test(code) && /i === _picked\.length - 1 \? ' disabled'/.test(code));

  /* _originals MUST move with _picked, or Undo restores the wrong picture to the wrong
     slot — a silent corruption the merchant would only notice in the published listing. */
  const mv = code.slice(code.indexOf("k === 'pmove'"), code.indexOf("k === 'printtag'"));
  ok('the undo originals move with the photos',
     /swap\(_picked\); swap\(_originals\);/.test(mv));
  ok('an out-of-range move is refused', /mj < 0 \|\| mi >= _picked\.length/.test(mv));

  /* STORED photos cannot be reordered without the product writer, so no control pretends
     to. Only the pending list is touched. */
  ok('it reorders only the pending list, never stored images',
     mv.indexOf('p.images') === -1 && mv.indexOf('E.product') === -1);
}

/* ── 5. THE SHOT LIST IS METADATA, NOT A SECOND UPLOADER ────────────────────── */
section('Shot list');
{
  const fn = code.slice(code.indexOf('function shotListHTML'), code.indexOf('function pickedHTML'));
  ok('it reads the groups from the listing model', /mediaGroupsFor/.test(fn));
  ok('it renders no file input', fn.indexOf('type="file"') === -1);
  ok('and no upload control', fn.indexOf('data-pf="photos"') === -1);
  ok('it is absent when the model has not loaded', /if \(!M\) return '';/.test(fn));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
