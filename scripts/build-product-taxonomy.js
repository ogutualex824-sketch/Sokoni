'use strict';
/* GENERATE sokoni-product-taxonomy.js from seller.html.
 *
 * The vocabularies and the conditional rules are LIFTED, never retyped: 99 categories in 20
 * groups, 47 locations, the ownership matrix, and the KEBS / food-licence / service / digital
 * / adult category sets. A hand-copied second table is how this repo ended up with nine
 * commission tables that disagreed; scripts/test-product-taxonomy-parity.js keeps the
 * generated module and the legacy form honest until seller.html is retired.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(ROOT + '/seller.html', 'utf8');
const gate = fs.readFileSync(ROOT + '/adult-gate.js', 'utf8');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").trim();

/* ── select options, by element id ───────────────────────────────────────── */
function selectBlock(id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) throw new Error('select not found: ' + id);
  const end = html.indexOf('</select>', at);
  return html.slice(at, end);
}
function optionsOf(id, { keepBlank = false } = {}) {
  const block = selectBlock(id);
  const out = [];
  const re = /<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = re.exec(block))) {
    const value = m[1];
    if (!value && !keepBlank) continue;
    const text = dec(m[2].replace(/<[^>]*>/g, ''));
    const g = /^([\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D\p{Extended_Pictographic}]*)\s+(.*)$/u.exec(text);
    out.push({ value, emoji: g ? g[1] : '', label: g ? g[2] : text });
  }
  return out;
}

/* ── grouped categories ──────────────────────────────────────────────────── */
const catBlock = selectBlock('productCategory');
const GROUPS = [];
const gre = /<optgroup label="([^"]+)">([\s\S]*?)<\/optgroup>/g;
let g;
while ((g = gre.exec(catBlock))) {
  const raw = dec(g[1]);
  const gm = /^([\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D\p{Extended_Pictographic}]*)\s+(.*)$/u.exec(raw);
  const options = [];
  const ore = /<option value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g;
  let o;
  while ((o = ore.exec(g[2]))) {
    const text = dec(o[2].replace(/<[^>]*>/g, ''));
    const om = /^([\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D\p{Extended_Pictographic}]*)\s+(.*)$/u.exec(text);
    options.push({ value: o[1], emoji: om ? om[1] : '', label: om ? om[2] : text });
  }
  GROUPS.push({ emoji: gm ? gm[1] : '', label: gm ? gm[2] : raw, options });
}

/* ── the category sets that drive conditional sections ───────────────────── */
function setOf(name, src) {
  const re = new RegExp('const ' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)');
  const m = re.exec(src);
  if (!m) throw new Error('set not found: ' + name);
  return (m[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, ''));
}
const KEBS = setOf('KEBS_CATEGORIES', html);
const FOOD_LICENCE = setOf('FOOD_LICENSE_CATS', html);
const SERVICE = setOf('SERVICE_CATEGORIES', html);
const DIGITAL = setOf('DIGITAL_CATEGORIES', html);
const ADULT = (/(?:const|var)\s+ADULT_CATS\s*=\s*\[([\s\S]*?)\]/.exec(gate)[1].match(/"([^"]+)"/g) || [])
  .map((s) => s.replace(/"/g, ''));

/* ── the ownership matrix ────────────────────────────────────────────────── */
const ownStart = html.indexOf('const OWNERSHIP_CATS = {');
const ownEnd = html.indexOf('};', ownStart);
const ownSrc = html.slice(ownStart + 'const OWNERSHIP_CATS = {'.length, ownEnd);
const OWNERSHIP = {};
const ore2 = /"?([a-zA-Z-]+)"?\s*:\s*\{\s*serial:\s*"([^"]*)"\s*,\s*hint:\s*"([^"]*)"\s*,\s*doc:\s*"([^"]*)"\s*,\s*sub:\s*"([^"]*)"/g;
let o2;
while ((o2 = ore2.exec(ownSrc))) {
  OWNERSHIP[o2[1]] = { serial: o2[2], hint: o2[3], doc: o2[4], sub: o2[5] };
}

const LOCATIONS = optionsOf('productLocation');
const OWNER_SOURCES = optionsOf('ownerSource');
const FOOD_STORAGE = optionsOf('foodStorage');
const FOOD_SLAUGHTER = optionsOf('foodSlaughter');

const totalCats = GROUPS.reduce((a, x) => a + x.options.length, 0);
console.log('groups ' + GROUPS.length + ', categories ' + totalCats +
  ', locations ' + LOCATIONS.length + ', ownership ' + Object.keys(OWNERSHIP).length +
  ', kebs ' + KEBS.length + ', food ' + FOOD_LICENCE.length +
  ', service ' + SERVICE.length + ', digital ' + DIGITAL.length + ', adult ' + ADULT.length);

const J = (v) => JSON.stringify(v, null, 2).replace(/\n/g, '\n  ');

const out = `/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PRODUCT TAXONOMY
   ══════════════════════════════════════════════════════════════════════════════
   Every vocabulary a merchant picks from when listing something for sale, and the
   rules that decide which parts of the form apply to what they are selling.

   ── GENERATED, NOT RETYPED ──────────────────────────────────────────────────
   Lifted from seller.html — the legacy upload form — by
   scripts/build-product-taxonomy.js. ${totalCats} categories in ${GROUPS.length} groups,
   ${LOCATIONS.length} locations, the ownership matrix and the five category sets that drive
   the conditional sections.

   Retyping them would have created a second table that drifts. This repo has
   been there: "The platform once had NINE commission tables that disagreed"
   (commission-config.js). scripts/test-product-taxonomy-parity.js asserts this
   module and seller.html still agree, so the day someone edits one and not the
   other is the day a test fails rather than the day a merchant picks a category
   that no longer exists.

   ── WHY A MERCHANT CANNOT BE SHOWN EVERY FIELD ──────────────────────────────
   A phone needs an IMEI. A goat needs a slaughter record. An e-book needs a
   download URL and none of the above. Showing all of it at once is how an
   upload form becomes something merchants abandon, so the SHAPE of the form is
   derived from the category rather than fixed:

       kindOf(cat)            physical | service | digital
       needsOwnership(cat)    high-theft goods: serial/IMEI + proof of purchase
       needsFoodLicence(cat)  county permit, KEBS, KMC, halal, cold chain
       showsKebs(cat)         standards mark applies to this class of goods
       isAdult(cat)           18+ — the buyer is age-gated at checkout

   These are the LEGACY form's own rules, carried over unchanged. They are
   commercial and regulatory decisions, not UI preferences, and this module is
   not the place to revise them.

   ── EMOJI ARE PART OF THE DATA ──────────────────────────────────────────────
   Every option carries its own emoji, so a <select> built from this module is
   legible at a glance on a phone. They are stored beside the label rather than
   baked into it, so a caller can render "📱 Phones" or just "Phones" without
   string surgery.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniProductTaxonomy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── Categories, grouped exactly as a merchant sees them ─────────────────── */
  var GROUPS = ${J(GROUPS)};

  /* ── Where the item is ───────────────────────────────────────────────────── */
  var LOCATIONS = ${J(LOCATIONS)};

  /* ── How the seller came by a high-value item ────────────────────────────── */
  var OWNER_SOURCES = ${J(OWNER_SOURCES)};

  /* ── Food handling ───────────────────────────────────────────────────────── */
  var FOOD_STORAGE = ${J(FOOD_STORAGE)};
  var FOOD_SLAUGHTER = ${J(FOOD_SLAUGHTER)};

  /* ── Condition. NOT in the legacy form — added here because a marketplace
        that cannot say "used" makes every listing look new, and a buyer who
        finds out later disputes the order. ─────────────────────────────────── */
  var CONDITIONS = [
    { value: 'new',        emoji: '\\u2728', label: 'Brand new' },
    { value: 'like-new',   emoji: '\\uD83D\\uDC8E', label: 'Like new — barely used' },
    { value: 'used-good',  emoji: '\\uD83D\\uDC4D', label: 'Used — good condition' },
    { value: 'used-fair',  emoji: '\\uD83D\\uDD27', label: 'Used — fair, works fine' },
    { value: 'refurbished',emoji: '\\u267B\\uFE0F', label: 'Refurbished' },
    { value: 'for-parts',  emoji: '\\uD83E\\uDDE9', label: 'For parts / not working' }
  ];

  /* ── UNITS AND STATES ────────────────────────────────────────────────────
     Every dropdown in the upload form carries emoji, and these are the ones the
     product-specs model supplies as bare words ("kg", "pieces", "mm"). They are
     decorated HERE rather than in the model, because the model is arithmetic —
     it converts and compares measurements — and an emoji in a unit key would
     end up in a stored value.

     A whole DIMENSION shares one glyph (📏 for every length, ⚖️ for every
     weight): the emoji says what KIND of thing is being measured, and reading
     "📏 mm / 📏 cm / 📏 m" is faster than three unrelated pictures. */
  var UNIT_EMOJI = {
    length: '\\uD83D\\uDCCF', weight: '\\u2696\\uFE0F', volume: '\\uD83E\\uDDF4',
    area: '\\uD83D\\uDCD0', power: '\\u26A1', storage: '\\uD83D\\uDCBE',
    time: '\\u23F1\\uFE0F', screen: '\\uD83D\\uDCF1'
  };
  var STOCK_UNIT_EMOJI = {
    pieces: '\\uD83D\\uDD22', kg: '\\u2696\\uFE0F', g: '\\u2696\\uFE0F',
    litres: '\\uD83E\\uDDF4', ml: '\\uD83E\\uDDF4', metres: '\\uD83D\\uDCCF',
    boxes: '\\uD83D\\uDCE6', packs: '\\uD83C\\uDF81', cartons: '\\uD83D\\uDCE6',
    crates: '\\uD83E\\uDDFA', bags: '\\uD83D\\uDECD\\uFE0F', bundles: '\\uD83E\\uDeA2',
    pairs: '\\uD83D\\uDC5F', sets: '\\uD83C\\uDF9B\\uFE0F', dozens: '\\uD83E\\uDD5A',
    hours: '\\u23F1\\uFE0F'
  };
  /* Whether a listing is on sale or put away. Two states, both said plainly. */
  var VISIBILITY = [
    { value: 'active', emoji: '\\u2705', label: 'Active \\u2014 on sale' },
    { value: 'draft',  emoji: '\\uD83D\\uDCDD', label: 'Draft \\u2014 hidden' }
  ];

  /** The glyph for a stock unit, or a neutral one so a select is never bare. */
  function stockUnitEmoji (u) { return STOCK_UNIT_EMOJI[String(u || '').toLowerCase()] || '\\uD83D\\uDCE6'; }
  /** The glyph for a measurement dimension (length, weight, volume\\u2026). */
  function dimensionEmoji (d) { return UNIT_EMOJI[String(d || '').toLowerCase()] || '\\uD83D\\uDCCF'; }

  /* ── The high-theft goods that need proof of ownership, and what to ask for ── */
  var OWNERSHIP = ${J(OWNERSHIP)};

  /* ── Category sets, carried over from the legacy form unchanged ──────────── */
  var KEBS = ${J(KEBS)};
  var FOOD_LICENCE = ${J(FOOD_LICENCE)};
  var SERVICE = ${J(SERVICE)};
  var DIGITAL = ${J(DIGITAL)};
  var ADULT = ${J(ADULT)};

  var _set = function (a) { var s = {}; a.forEach(function (k) { s[k] = true; }); return s; };
  var KEBS_S = _set(KEBS), FOOD_S = _set(FOOD_LICENCE),
      SVC_S = _set(SERVICE), DIG_S = _set(DIGITAL), ADULT_S = _set(ADULT);

  var BY_VALUE = {};
  GROUPS.forEach(function (grp) {
    grp.options.forEach(function (o) {
      BY_VALUE[o.value] = { value: o.value, emoji: o.emoji, label: o.label,
                            group: grp.label, groupEmoji: grp.emoji };
    });
  });

  var c = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };

  /* physical | service | digital — the three shapes an upload form takes. */
  function kindOf (cat) {
    var k = c(cat);
    if (DIG_S[k]) return 'digital';
    if (SVC_S[k]) return 'service';
    return 'physical';
  }
  function needsOwnership (cat) { return !!OWNERSHIP[c(cat)]; }
  function ownershipFor (cat)   { return OWNERSHIP[c(cat)] || null; }
  function needsFoodLicence (cat) { return !!FOOD_S[c(cat)]; }
  function showsKebs (cat)      { return kindOf(cat) === 'physical' && !!KEBS_S[c(cat)]; }
  function isAdult (cat)        { return !!ADULT_S[c(cat)]; }
  function isKnown (cat)        { return !!BY_VALUE[c(cat)]; }
  function infoFor (cat)        { return BY_VALUE[c(cat)] || null; }

  /* A vehicle or motorcycle needs a logbook; everything else needs a receipt. */
  function needsOwnerDoc (cat) { var k = c(cat); return k === 'cars' || k === 'motorcycles'; }

  function labelFor (cat) {
    var i = BY_VALUE[c(cat)];
    return i ? (i.emoji ? i.emoji + ' ' + i.label : i.label) : '';
  }

  /* ── HTML helpers ────────────────────────────────────────────────────────
     The caller supplies its own escaper so this module does not become a second
     opinion on escaping. Values here are generated and known-safe, but a label
     still goes through it: a taxonomy that escapes nothing teaches the next
     caller the wrong habit. */
  function optionRow (o, selected, esc) {
    var e = esc || function (s) { return String(s); };
    var text = (o.emoji ? o.emoji + ' ' : '') + o.label;
    return '<option value="' + e(o.value) + '"' +
      (c(selected) === c(o.value) ? ' selected' : '') + '>' + e(text) + '</option>';
  }

  /** The full grouped category list, ready to drop inside a <select>. */
  function categoryOptionsHtml (selected, esc, placeholder) {
    var e = esc || function (s) { return String(s); };
    var head = placeholder === false ? ''
      : '<option value="">' + e(placeholder || '\\uD83C\\uDFF7\\uFE0F Choose a category') + '</option>';
    return head + GROUPS.map(function (grp) {
      return '<optgroup label="' + e((grp.emoji ? grp.emoji + ' ' : '') + grp.label) + '">' +
        grp.options.map(function (o) { return optionRow(o, selected, e); }).join('') +
        '</optgroup>';
    }).join('');
  }

  /** Any flat vocabulary (locations, conditions, storage…) as <option> rows. */
  function optionsHtml (list, selected, esc, placeholder) {
    var e = esc || function (s) { return String(s); };
    var head = placeholder === false ? ''
      : '<option value="">' + e(placeholder || 'Select\\u2026') + '</option>';
    return head + (list || []).map(function (o) { return optionRow(o, selected, e); }).join('');
  }

  return {
    GROUPS: GROUPS, LOCATIONS: LOCATIONS, OWNER_SOURCES: OWNER_SOURCES,
    VISIBILITY: VISIBILITY, UNIT_EMOJI: UNIT_EMOJI, STOCK_UNIT_EMOJI: STOCK_UNIT_EMOJI,
    stockUnitEmoji: stockUnitEmoji, dimensionEmoji: dimensionEmoji,
    FOOD_STORAGE: FOOD_STORAGE, FOOD_SLAUGHTER: FOOD_SLAUGHTER, CONDITIONS: CONDITIONS,
    OWNERSHIP: OWNERSHIP,
    KEBS: KEBS, FOOD_LICENCE: FOOD_LICENCE, SERVICE: SERVICE, DIGITAL: DIGITAL, ADULT: ADULT,
    kindOf: kindOf, needsOwnership: needsOwnership, ownershipFor: ownershipFor,
    needsOwnerDoc: needsOwnerDoc, needsFoodLicence: needsFoodLicence,
    showsKebs: showsKebs, isAdult: isAdult, isKnown: isKnown, infoFor: infoFor,
    labelFor: labelFor,
    categoryOptionsHtml: categoryOptionsHtml, optionsHtml: optionsHtml
  };
}));
`;

fs.writeFileSync(ROOT + '/sokoni-product-taxonomy.js', out);
console.log('wrote sokoni-product-taxonomy.js (' + out.length + ' bytes)');
