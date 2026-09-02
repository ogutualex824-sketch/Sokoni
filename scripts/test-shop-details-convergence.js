#!/usr/bin/env node
/* SHOP DETAILS CONVERGENCE — Slice A: every schema-backed field, one persistence path.
 *
 * merchant-v2's Shop Details exposed 9 of the server schema's fields while the storefront
 * already accepted far more, so a merchant could not set their own logo, cover, delivery
 * areas, payment methods, policies or branding from the shell at all.
 *
 * THE INVARIANT THAT MATTERS MOST: every field here is backed by
 * functions/minishop-config-schema.js, and saves go through the existing
 * changedFields -> saveMinishopConfig -> configForWrite() path. A control that persists
 * nowhere is worse than a missing control — the merchant believes they configured
 * something. That is why the eight social handles seller.html collects are deliberately
 * ABSENT: they are not in the schema.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

/* Load the client module the way a browser would. */
global.window = global.window || globalThis;
delete require.cache[require.resolve(path.join(ROOT, 'sokoni-merchant-store.js'))];
require(path.join(ROOT, 'sokoni-merchant-store.js'));
const MS = globalThis.SokoniMerchantStore;

const SCHEMA = read('functions/minishop-config-schema.js');
const UI = read('sokoni-merchant-store-ui.js');

/* Parse the server's own field tables — the client must not disagree with them. */
function block (name) {
  const i = SCHEMA.indexOf('const ' + name + ' = {');
  if (i < 0) return null;
  return SCHEMA.slice(i, SCHEMA.indexOf('};', i));
}
const STRING_BLOCK = block('STRING_FIELDS');
const ARRAY_BLOCK = block('ARRAY_FIELDS');

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — the module and the schema both loaded');
ck('the client field model loaded', !!MS && Array.isArray(MS.TEXT_FIELDS) && MS.TEXT_FIELDS.length > 0);
ck('CONTROL the server schema tables were parsed', !!STRING_BLOCK && !!ARRAY_BLOCK,
   'a null table would make every comparison below vacuous');

/* ── 2 · EVERY FIELD IS SCHEMA-BACKED ───────────────────────────────────────── */
head('2 · no control persists nowhere');
{
  const unbacked = MS.TEXT_FIELDS.filter((f) => {
    const inStr = new RegExp('(^|\\s)' + f.id + ':').test(STRING_BLOCK || '');
    const inArr = new RegExp('(^|\\s)' + f.id + ':').test(ARRAY_BLOCK || '');
    return !inStr && !inArr;
  }).map((f) => f.id);
  ck('every exposed field exists in the server schema', unbacked.length === 0,
     unbacked.length ? 'NOT PERSISTED: ' + unbacked.join(', ') : MS.TEXT_FIELDS.length + ' fields');

  const SOCIAL = ['storeInstagram', 'instagram', 'tiktok', 'whatsapp', 'facebook',
                  'twitter', 'youtube', 'linkedin', 'snapchat'];
  const leaked = MS.TEXT_FIELDS.filter((f) => SOCIAL.indexOf(f.id) > -1).map((f) => f.id);
  ck('NEGATIVE the un-schema-backed social handles are NOT exposed', leaked.length === 0,
     leaked.length ? 'would silently discard: ' + leaked.join(', ') : 'absent, pending a schema slice');
}

/* ── 3 · THE NINE ORIGINALS SURVIVE ─────────────────────────────────────────── */
head('3 · nothing was removed to make room');
{
  const ORIGINAL = ['tagline', 'description', 'location', 'category', 'contactPhone',
                    'contactEmail', 'responseTime', 'deliveryPolicy', 'announcement'];
  const ids = MS.TEXT_FIELDS.map((f) => f.id);
  const lost = ORIGINAL.filter((id) => ids.indexOf(id) === -1);
  ck('all nine original fields are still present', lost.length === 0, lost.join(', '));
  ck('the field set actually grew', MS.TEXT_FIELDS.length > ORIGINAL.length,
     ORIGINAL.length + ' -> ' + MS.TEXT_FIELDS.length);
}

/* ── 4 · CANONICAL NAMES, NOT ALIASES ───────────────────────────────────────── */
head('4 · one value per setting');
{
  const ids = MS.TEXT_FIELDS.map((f) => f.id);
  ['logoImage', 'coverImage', 'accentColor'].forEach((alias) => {
    ck('NEGATIVE the alias ' + alias + ' is not exposed', ids.indexOf(alias) === -1,
       'the schema aliases it; sending both is how two competing values appear');
  });
  ck('the canonical names are the ones exposed',
     ids.indexOf('logoUrl') > -1 && ids.indexOf('coverUrl') > -1 && ids.indexOf('brandColor') > -1);
}

/* ── 5 · CLIENT LIMITS MATCH THE SERVER'S ───────────────────────────────────── */
head('5 · the client does not invent its own caps');
{
  const bad = [];
  MS.TEXT_FIELDS.forEach((f) => {
    const m = (STRING_BLOCK || '').match(new RegExp('(^|\\s)' + f.id + ':\\s*(\\d+)'));
    if (m && Number(m[2]) !== f.max) bad.push(f.id + ' client=' + f.max + ' server=' + m[2]);
    const a = (ARRAY_BLOCK || '').match(new RegExp('(^|\\s)' + f.id + ':\\s*\\{[^}]*max:\\s*(\\d+)[^}]*itemMax:\\s*(\\d+)'));
    if (a && (Number(a[2]) !== f.max || Number(a[3]) !== f.itemMax))
      bad.push(f.id + ' client=' + f.max + '/' + f.itemMax + ' server=' + a[2] + '/' + a[3]);
  });
  ck('every cap matches the server', bad.length === 0, bad.join(' | '));
}

/* ── 6 · CHANGE DETECTION IS ARRAY-AWARE ────────────────────────────────────── */
head('6 · a save sends changes, and only changes');
{
  const ch = MS.changedFields({ tagline: 'a', tags: ['x', 'y'] },
                              { tagline: 'a', tags: ['x', 'y', 'z'] });
  ck('an untouched field is not sent', !('tagline' in ch),
     'sending unchanged keys is how one edit overwrites another setting');
  ck('an array field is sent AS AN ARRAY', Array.isArray(ch.tags));
  ck('identical arrays are not a change',
     Object.keys(MS.changedFields({ tags: ['x'] }, { tags: ['x'] })).length === 0);
  ck('NEGATIVE a comma inside one entry is not read as two',
     Object.keys(MS.changedFields({ tags: ['a', 'b'] }, { tags: ['a,b'] })).length === 1,
     'String() comparison would have collapsed these to equal');
}

/* ── 7 · VALIDATION MIRRORS THE SCHEMA ──────────────────────────────────────── */
head('7 · invalid values are refused before they are sent');
{
  const f = (id) => MS.TEXT_FIELDS.filter((x) => x.id === id)[0];
  ck('a non-URL logo is refused', !!MS.validateField(f('logoUrl'), 'not a url'));
  ck('a real URL is accepted', !MS.validateField(f('logoUrl'), 'https://cdn.example/l.png'));
  ck('a non-hex brand colour is refused', !!MS.validateField(f('brandColor'), 'green'));
  ck('a hex colour is accepted', !MS.validateField(f('brandColor'), '#71ff00'));
  ck('an off-list theme is refused', !!MS.validateField(f('theme'), 'neon'));
  ck('too many tags is refused', !!MS.validateField(f('tags'), new Array(11).fill('x')));
  ck('an over-long chip is refused',
     !!MS.validateField(f('deliveryAreas'), ['x'.repeat(101)]));
  ck('NEGATIVE an empty value is allowed, so a field can be cleared',
     !MS.validateField(f('logoUrl'), ''));
}

/* ── 8 · ONE PERSISTENCE PATH ───────────────────────────────────────────────── */
head('8 · the surface did not grow a second way to save');
{
  ck('saves still go through saveMinishopConfig',
     MS.CALLABLES && MS.CALLABLES.saveConfig === 'saveMinishopConfig');
  ck('NEGATIVE the UI writes no Firestore directly',
     UI.indexOf('firebaseDB') === -1 && UI.indexOf('setDoc(') === -1 && UI.indexOf('collection(') === -1,
     'every read and write on this surface is a callable, by design');
  ck('NEGATIVE the UI does not persist to localStorage',
     UI.indexOf('localStorage.setItem') === -1);
}

/* ── 9 · THE FORM IS GROUPED, NOT A LONG LIST ───────────────────────────────── */
head('9 · presentation');
{
  ck('groups are declared', Array.isArray(MS.FIELD_GROUPS) && MS.FIELD_GROUPS.length >= 5);
  const known = {}; (MS.FIELD_GROUPS || []).forEach((g) => { known[g.id] = true; });
  ck('every field names a declared group',
     MS.TEXT_FIELDS.every((f) => !!f.group && known[f.group]),
     MS.TEXT_FIELDS.filter((f) => !f.group || !known[f.group]).map((f) => f.id).join(', '));
  ck('the renderer groups the fields', UI.indexOf('mst-group') > -1 && UI.indexOf('FIELD_GROUPS') > -1);
  ck('logo and cover preview their value', UI.indexOf('mst-pv') > -1 &&
     MS.TEXT_FIELDS.some((f) => f.id === 'logoUrl' && f.preview) &&
     MS.TEXT_FIELDS.some((f) => f.id === 'coverUrl' && f.preview));
  ck('chips can be added and removed', UI.indexOf('data-chip-add') > -1 && UI.indexOf('data-chip-del') > -1);
  ck('tap targets are at least 44px', /min-height:44px|min-height:48px|min-height:52px/.test(UI));
}

/* ── 10 · BOUNDARIES ────────────────────────────────────────────────────────── */
head('10 · what this slice cannot prove');
unk('a saved value round-trips through the server',
    'needs an authenticated merchant session; Slice C');
unk('the saved configuration renders on /shop/{handle}',
    'customer-surface evidence; Slice C');

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);
