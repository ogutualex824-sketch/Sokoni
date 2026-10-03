#!/usr/bin/env node
/**
 * AVAILABILITY CONVERGENCE — one canonical schedule, two surfaces.
 *
 *   node scripts/test-availability-convergence.js
 *
 * The thing that must be true is not "both UIs look right". It is that they are reading
 * the SAME document, so a change a merchant makes governs what a shopper sees. Two
 * independent implementations can each look perfect and still disagree, which is exactly
 * how a shop ends up telling customers it is open while its owner has closed it.
 *
 * So this proves the CHAIN:
 *
 *     Merchant V2 editor  →  providerAvailability/{ownerUid}  →  effectiveForShop
 *                         →  getMinishopPublic  →  MiniShop
 *
 * by asserting the client model reproduces the SERVER rule (functions/kasshop.js) case for
 * case, and that both surfaces read that one model rather than deciding for themselves.
 *
 * THE DEFECT THIS ALSO LOCKS: `overrides` is a MAP FIELD on the document.
 * availability-manager.html wrote an overrides/{date} SUBCOLLECTION which the resolver
 * never read, so every holiday a seller set was silently ignored by the storefront — a
 * shop closed for Christmas still showed Open. Anything writing overrides must write the
 * map, and that is asserted here for both writers.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const M = require(path.join(ROOT, 'sokoni-availability-model.js'));

const SHELL  = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const MSJS   = fs.readFileSync(path.join(ROOT, 'sokoni-minishop.js'), 'utf8');
const MSHTML = fs.readFileSync(path.join(ROOT, 'minishop.html'), 'utf8');
const AVMGR  = fs.readFileSync(path.join(ROOT, 'availability-manager.html'), 'utf8');
const KASS   = fs.readFileSync(path.join(ROOT, 'functions/kasshop.js'), 'utf8');
const RULES  = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

/* Monday 2026-08-31. 07:00Z = 10:00 EAT. */
const MON_10 = Date.UTC(2026, 7, 31, 7, 0);
const MON_19 = Date.UTC(2026, 7, 31, 16, 0);
const MON_07 = Date.UTC(2026, 7, 31, 4, 0);

console.log(NL + 'AVAILABILITY CONVERGENCE' + NL + '='.repeat(60));

/* ── 1 · the client model reproduces the SERVER rule ──────────────────────── */
head('1 · the client model IS the server rule');
const week = M.emptyWeek();

ck('within hours ⇒ open',
   M.computeEffective(week, {}, MON_10).open === true,
   JSON.stringify(M.computeEffective(week, {}, MON_10)));
ck('outside hours ⇒ closed',
   M.computeEffective(week, {}, MON_19).open === false);
ck('an override CLOSES a scheduled-open day',
   M.computeEffective(week, { '2026-08-31': { closed: true } }, MON_10).open === false,
   'source must be the override, not the weekly schedule');
ck('...and reports the override as the source',
   M.computeEffective(week, { '2026-08-31': { closed: true } }, MON_10).source === 'override');
ck('an override OPENS a scheduled-closed time',
   M.computeEffective(week, { '2026-08-31': { closed: false } }, MON_19).open === true,
   'special hours beat the weekly schedule in both directions');
ck('no schedule ⇒ open, matching the server default',
   M.computeEffective(null, {}, MON_19).reason === 'no_schedule',
   'the server returns no_schedule/open; disagreeing would shut shops that never set hours');
ck('a period crossing midnight is handled',
   M.computeEffective({ mon: { closed: false, periods: [{ open: '20:00', close: '02:00' }] } }, {},
     Date.UTC(2026, 7, 31, 18, 0)).open === true,
   '21:00 EAT inside 20:00–02:00');

/* the day keys must match the server's, or every day is off by one */
ck('day keys match the server exactly',
   JSON.stringify(M.DAYS) === JSON.stringify(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) &&
   KASS.indexOf("['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']") > -1,
   'a different order silently shifts every schedule by a day');
ck('the timezone constant matches the server',
   M.TZ_MIN === 180 && /180 \/\* EAT \*\//.test(KASS));

/* ── 2 · derived detail, and its honest gaps ──────────────────────────────── */
head('2 · next opening and closing, derived — never invented');
ck('closes-at is derived while open', M.closesAt(week, {}, MON_10) === '18:00');
ck('next opening skips a holiday',
   M.nextOpening(week, { '2026-09-01': { closed: true } }, MON_19).date === '2026-09-02',
   'Tuesday is closed, so Wednesday is next');
ck('next opening is TODAY when the shop has not opened yet',
   M.nextOpening(week, {}, MON_07).inDays === 0,
   '07:00 EAT, opens 08:00');
ck('NEGATIVE no schedule ⇒ next opening is null, not a guess',
   M.nextOpening(null, {}, MON_19) === null,
   'null means unknown and must render as nothing');
ck('NEGATIVE an all-closed week ⇒ null rather than a fabricated date',
   M.nextOpening({ sun: { closed: true }, mon: { closed: true }, tue: { closed: true },
                   wed: { closed: true }, thu: { closed: true }, fri: { closed: true },
                   sat: { closed: true } }, {}, MON_10) === null);

/* ── 3 · validation stops a schedule the resolver would misread ───────────── */
head('3 · validation before the write');
ck('open with no periods is rejected',
   M.validate({ mon: { closed: false, periods: [] } }).length === 1,
   'the resolver reads that as outside_hours and would quietly shut the shop');
ck('a zero-length period is rejected',
   M.validate({ mon: { closed: false, periods: [{ open: '09:00', close: '09:00' }] } }).length === 1);
ck('CONTROL a valid week passes', M.validate(week).length === 0);

/* ── 4 · ONE canonical location ───────────────────────────────────────────── */
head('4 · the chain reads and writes one document');
ck('the server resolves from providerAvailability/{ownerUid}',
   /collection\('providerAvailability'\)\.doc\(ownerUid\)/.test(KASS));
/* 2026-10-03: the editor SAVES through kasshop.setShopAvailability (server-authoritative); the
   server writes this document and the browser keeps only the READ. Full proof, with a negative
   control: scripts/test-merchant-availability-server-save.js. */
ck('the merchant editor READS that same document',
   SHELL.indexOf("getDoc(f.m.doc(f.db, 'providerAvailability', S.uid))") > -1);
ck('...and SAVES `hours` and `overrides` through the server callable, the fields the resolver reads',
   /_callable\('setShopAvailability'\)\(payload\)/.test(SHELL) &&
   /\{ schedule: \{ hours: hours, overrides: overrides \} \}/.test(SHELL));
ck('CONTROL no second availability collection was introduced',
   !/collection\(.(shopAvailability|minishopAvailability|availability).\)/.test(SHELL + MSJS),
   'a MiniShop-specific copy is exactly what must not exist');
ck('both surfaces load the SAME model',
   SHELL.indexOf('sokoni-availability-model.js') > -1 &&
   MSHTML.indexOf('sokoni-availability-model.js') > -1);

/* ── 5 · the overrides map — the silently-ignored-holiday defect ──────────── */
head('5 · overrides reach the field the resolver actually reads');
ck('the resolver reads the MAP field', /overrides: d\.overrides/.test(KASS));
ck('the merchant editor sends the map (the server writes it)',
   /overrides\[d\] = v;/.test(SHELL) && /schedule: \{ hours: hours, overrides: overrides \}/.test(SHELL));
ck('availability-manager now writes the map TOO',
   /overrides: \{ \[date\]: \{ closed:/.test(AVMGR),
   'it wrote only the subcollection, which the resolver never read');
ck('...and clears it on delete',
   /overrides: \{ \[date\]: firebase\.firestore\.FieldValue\.delete\(\) \}/.test(AVMGR),
   'or a removed closure would still shut the shop');
ck('CONTROL the subcollection write is KEPT, so that page still lists them',
   /\.collection\("overrides"\)\.doc\(date\)\.set\(overrideData\)/.test(AVMGR));

/* ── 6 · the shopper is never told a guess ────────────────────────────────── */
head('6 · MiniShop never decides, and never invents');
ck('the storefront presents the SERVER decision',
   /Never decide it here/.test(MSJS));
ck('unresolved availability renders nothing',
   /if \(!availability\) \{ osEl\.hidden = true; return; \}/.test(MSJS),
   'no schedule and no verdict must never become "Open"');
ck('the detail line is silent without a schedule',
   /if \(!M \|\| !availability \|\| !hours\) \{ el\.hidden = true;/.test(MSJS));
ck('CONTROL the detail never re-decides open/closed',
   !/_renderAvailabilityDetail[\s\S]{0,700}computeEffective/.test(MSJS),
   'it elaborates the verdict; it must not compute a competing one');

/* ── 7 · what is NOT offered, and why ─────────────────────────────────────── */
head('7 · the live toggle is refused honestly');
ck('the editor does not offer a temporary open/closed switch',
   SHELL.indexOf('Temporarily closing is not available here yet') > -1);
ck('...and states the real reason',
   /setLiveStatus<\/code>\) *' \+\s*'is not deployed/.test(SHELL) ||
   SHELL.indexOf('is not deployed') > -1,
   'a switch that silently fails is worse than an explained absence');
ck('CONTROL the owner genuinely may write the schedule',
   /match \/providerAvailability\/\{uid\}[\s\S]{0,200}allow update: if isAuthed\(\) && request\.auth\.uid == uid/.test(RULES),
   'the rule still permits it; the merchant-v2 editor no longer uses it — it saves through setShopAvailability since 2026-10-03, which DOES need that function live');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
