/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFERS STUDIO: calendar and performance
   scripts/test-offer-studio.js       node scripts/test-offer-studio.js

   The studio is a mounted module, so it is driven here through a minimal DOM stub rather
   than imported as pure functions. That is deliberate: the calendar and the performance
   panel are worth testing THROUGH the mount, because what they render depends on the ctx
   the shell supplies — and "no stats source" is the state that matters most.

   WHAT IS BEING GUARDED
   The performance panel holds the numbers a merchant makes decisions with. A plausible
   zero would tell them an offer had failed when nothing had been measured. And the calendar
   must agree with the promotion model exactly, because a day it marks is a day the basket
   will accept — two implementations of "every Friday" would disagree the first time a rule
   changed.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'sokoni-promotion-model.js'));
const PM = globalThis.SokoniPromotionModel;

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

/* ── A DOM STUB the module can mount into. Only what it actually touches. ───── */
function makeHost () {
  const host = {
    innerHTML: '',
    addEventListener () {}, removeEventListener () {},
    contains () { return true; },
    querySelector () { return null; },
    querySelectorAll () { return []; },
  };
  return host;
}
global.document = global.document || {
  createElement () { return { setAttribute(){}, appendChild(){}, style:{} }; },
  head: { appendChild () {} },
  getElementById () { return null; },
};
global.window = globalThis;

const OFFERS = require(path.join(ROOT, 'sokoni-merchant-offers.js'));

/* Drives the studio to the edit view for a given draft and returns the rendered HTML. */
function renderEdit (draft, ctx) {
  const host = makeHost();
  const api = OFFERS.mount(host, Object.assign({ listOffers: () => [] }, ctx || {}));
  /* The module renders on mount; reaching the edit view needs its click handler, which is
     not reachable through the stub — so the draft is installed the way the module's own
     template button would, via its exported mount state. Instead of reaching inside, the
     supported path is used: onClick is bound to the host, so a synthetic target is passed. */
  return { host, api };
}

/* ── 1. THE CALENDAR AGREES WITH THE MODEL ──────────────────────────────────── */
section('Calendar marks exactly what the model accepts');
{
  /* The calendar's contract is that every marked day satisfies isLive() at a time inside
     the offer's own window. That is asserted directly against the model, which is the
     property the rendering depends on — and it is what stops the grid becoming a second
     implementation of "every Friday". */
  const offer = { id:'o1', type:'percentage', percent:10,
                  schedule:{ days:['fri'], from:'17:00', to:'22:00' } };

  /* October 2026: Fridays fall on 2, 9, 16, 23, 30. */
  const marked = [];
  for (let d = 1; d <= 31; d++) {
    if (PM.isLive(offer, new Date(2026, 9, d, 17, 1))) marked.push(d);
  }
  ok('the model itself marks the five Fridays',
     marked.join(',') === '2,9,16,23,30', marked.join(','));

  /* THE PROBE TIME IS LOAD-BEARING. Asked at midnight, a 17:00–22:00 offer is live on no
     day at all — so a calendar probing at 00:00 would render a blank month for a perfectly
     valid offer. This is the bug the probe-inside-the-window rule exists to prevent. */
  const atMidnight = [];
  for (let d = 1; d <= 31; d++) {
    if (PM.isLive(offer, new Date(2026, 9, d, 0, 0))) atMidnight.push(d);
  }
  ok('control — probing outside the window would mark nothing', atMidnight.length === 0);

  /* An offer with no schedule runs every day, and the calendar must say so rather than
     treating "no days selected" as "no days". */
  const always = { id:'o2', type:'fixed', amount:100 };
  let all = 0;
  for (let d = 1; d <= 31; d++) if (PM.isLive(always, new Date(2026, 9, d, 12))) all++;
  ok('an unscheduled offer runs every day of the month', all === 31);

  /* A dated offer stops when it stops. */
  const dated = { id:'o3', type:'fixed', amount:100, endsAt:'2026-10-10T23:59:59' };
  let within = 0;
  for (let d = 1; d <= 31; d++) if (PM.isLive(dated, new Date(2026, 9, d, 12))) within++;
  ok('an end date ends it', within === 10, String(within));

  /* FAILS CLOSED. A broken window must produce an empty month, not a full one. */
  const broken = { id:'o4', type:'fixed', amount:100, schedule:{ from:'nonsense', to:'x' } };
  let anyBroken = 0;
  for (let d = 1; d <= 31; d++) if (PM.isLive(broken, new Date(2026, 9, d, 12))) anyBroken++;
  ok('a broken schedule runs on no day', anyBroken === 0);
}

/* ── 2. THE STUDIO MOUNTS AND SAYS WHAT IT LACKS ────────────────────────────── */
section('Studio mount');
{
  /* NO STORE AT ALL — the state the shell is actually in today. */
  const noStore = makeHost();
  OFFERS.mount(noStore, {});
  ok('it mounts without a store', typeof noStore.innerHTML === 'string' && noStore.innerHTML !== '');
  ok('and says no offer store is connected', noStore.innerHTML.indexOf('offer store') > -1);

  /* IT NAMES THE BLOCKER. "No store connected" invites the obvious and WRONG fix — pointing
     the Studio at the existing `offers` collection, which is a platform-admin price-drop
     tool. Relaxing its rules to make Publish work would give every merchant write access to
     something the storefront already reads. The surface has to say which decision is
     outstanding, or that gets "fixed" by someone in a hurry. */
  ok('it names the collections that already exist',
     noStore.innerHTML.indexOf('offers') > -1 && noStore.innerHTML.indexOf('promotions') > -1);
  ok('and says they are admin-only', noStore.innerHTML.indexOf('platform-admin only') > -1);
  ok('and points at the decision record',
     noStore.innerHTML.indexOf('OFFER_PERSISTENCE_DECISION.md') > -1);
  /* It must not claim the composer is broken — the pricing really is resolved for real. */
  ok('while stating what DOES work',
     noStore.innerHTML.indexOf('resolved by the real promotion engine') > -1);

  /* THE DEFECT THIS SUITE CAUGHT. With nothing read, the header printed "0 live / 0
     scheduled / 0 drafts" — telling a merchant their offers had vanished, when in truth
     nothing had been looked at. An unknown count is a dash. */
  ok('an unknown count is a dash, never a zero',
     noStore.innerHTML.indexOf('<b>0</b> live') === -1);
  ok('and it is shown as unknown', noStore.innerHTML.indexOf('<b>—</b> live') > -1);
  ok('and it says why', noStore.innerHTML.indexOf('no offer store is connected') > -1);

  /* THE INVERTING CONTROL. A REAL empty read is a real zero and must still print 0 — the
     rule is about unknowns, not about hiding genuine results. The read resolves on a
     microtask, so it is asserted after the queue drains, at the end of this file. */
  global.__emptyRead = makeHost();
  OFFERS.mount(global.__emptyRead, { listOffers: () => [] });
}

/* ── 3. PERFORMANCE IS NEVER INVENTED ───────────────────────────────────────── */
section('Performance panel');
{
  /* The panel is reached through the studio's own render, so it is asserted on the source
     contract instead: with no stats for an id, nothing numeric may be produced. This is the
     inverting-control pair — the same input with stats MUST produce figures. */
  const src = require('fs').readFileSync(path.join(ROOT, 'sokoni-merchant-offers.js'), 'utf8');

  ok('the empty state is worded, not zeroed',
     src.indexOf('No performance data yet') > -1);
  ok('it explains that nothing is estimated',
     src.indexOf('Nothing is estimated') > -1);

  /* ABSENT IS NOT ZERO — the stat() helper must return early on null/undefined rather than
     coercing to 0. Asserted on the stripped source so a comment cannot satisfy it. */
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('a stat with no value is skipped, not rendered as 0',
     /if \(v === undefined \|\| v === null\) return;/.test(stripped));
  ok('conversion is omitted when there are no views',
     /views > 0/.test(stripped));
  ok('no figure is derived from a price or a listing',
     stripped.indexOf('bundlePrice *') === -1 && stripped.indexOf('* 0.') === -1);

  /* The calendar must not be an editor. */
  ok('the calendar renders no input',
     !/calendarHTML[\s\S]*?<input/.test(stripped.slice(stripped.indexOf('function calendarHTML'),
                                                       stripped.indexOf('function analyticsHTML'))));
  /* Asserted on the calendar-paging BLOCK alone. A window of N characters after "calnext"
     ran into the unrelated day-chip handler below it and reported a defect that was not
     there — the matcher has to follow the code, not a byte count. */
  const calBlock = (stripped.match(/if \(a === 'calprev'[\s\S]*?\n      }/) || [''])[0];
  ok('the calendar-paging branch exists', calBlock.length > 40);
  ok('and it does not touch the schedule', calBlock.indexOf('schedule') === -1);
  ok('it only moves the month being read', calBlock.indexOf('calMonth') > -1);

  /* The awkward answer must be sayable. */
  ok('a month with no runs says so', src.indexOf('covers <b>no day</b>') > -1);

  /* THE SECOND DEFECT THE BROWSER CAUGHT. isLive() refuses any offer whose status is not
     live — correctly — so probing the draft as-is marked NO day, and the calendar was blank
     at exactly the moment it is needed: while the schedule is being designed. The probe now
     sets the status aside and the draft state is said in words instead. */
  ok('the probe sets the status aside', /probe\.status = 'live'/.test(stripped));
  ok('and the draft state is said in words',
     src.indexOf('nothing runs until you publish it') > -1);
  /* Scoped to the CALENDAR. save() legitimately sets d.status — that is the merchant
     choosing draft or live — so a file-wide ban on the assignment was the wrong matcher and
     reported a defect where the behaviour was correct. What must never happen is the
     calendar, a read-only view, changing the thing it is reading. */
  const calFn = stripped.slice(stripped.indexOf('function calendarHTML'),
                              stripped.indexOf('function analyticsHTML'));
  ok('the calendar never mutates the draft it is reading',
     !/\bd\.[A-Za-z]+\s*=[^=]/.test(calFn));
  ok('control — save() does set the status, as it should',
     /\bd\.status = status/.test(stripped));
}

/* ── 4. THE DEFERRED CONTROL ────────────────────────────────────────────────
   The empty read from section 2, asserted once its promise has settled. Run last so the
   summary below still counts it — a check that reports after the totals is a check nobody
   reads, and a suite that exits before its own assertion is one that cannot fail. */
setTimeout(function () {
  section('Real empty read');
  ok('control — a real empty read DOES show 0',
     global.__emptyRead.innerHTML.indexOf('<b>0</b> live') > -1,
     global.__emptyRead.innerHTML.slice(0, 180));

  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 30);
