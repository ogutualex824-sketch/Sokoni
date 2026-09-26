#!/usr/bin/env node
'use strict';
/**
 * RECOVERY MANIFEST ASSERTION 6 — trigger-contract equality, deterministic.
 * scripts/infra/compare-trigger-spec.js
 *
 * ── WHY THE OLD METHOD WAS WRONG ────────────────────────────────────────────────────────
 * Assertion 6 compared `eventTrigger` pre vs post "after deterministic key ordering only". But
 * the API itself returns `eventFilters` in varying order: on 2026-09-26, successive describes
 * of the SAME, UNCHANGED onOrderStatusChange returned its three filters in different orders
 * (one read passed, the next failed, the next passed). An order-sensitive comparison of that
 * array fails a correct rebuild at random — a control that is itself non-deterministic.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────
 *   eventTrigger.eventFilters   compared as a MULTISET: order ignored; every filter, every
 *                               field inside a filter, and every DUPLICATE still counts.
 *   everything else            EXACT. Keys may appear in any order (objects are canonicalised),
 *                               but no field may be added, removed or changed, and every OTHER
 *                               array keeps its order.
 *
 *   same filters, different order  -> PASS
 *   any filter added/removed/changed/duplicated, any other field changed -> FAIL
 *
 * Nothing is "selected away": the whole eventTrigger object is compared.
 *
 * Usage (read-only):
 *   node scripts/infra/compare-trigger-spec.js <functionName>
 *     compares recovery-baseline-20260921.json entry `raw.eventTrigger` with a fresh
 *     `gcloud functions describe`. Exit 0 = PASS, 1 = FAIL, 2 = could not compare.
 *   require(...).compareTriggerSpec(pre, post) -> { ok, diffs: [ 'path: reason', ... ] }
 */
const path = require('path');

/* Canonical form: object keys sorted recursively; arrays keep order. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k) => (a[k] = canon(v[k]), a), {});
  return v;
}
const key = (v) => JSON.stringify(canon(v));

/* Multiset comparison of filter objects: sorted canonical encodings must match element-for-element. */
function sameFilterMultiset(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return { ok: false, why: 'eventFilters is not an array on both sides' };
  const ka = a.map(key).sort(), kb = b.map(key).sort();
  if (ka.length !== kb.length) return { ok: false, why: `filter count ${ka.length} -> ${kb.length}` };
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) {
      const onlyPre = ka.filter((x) => !kb.includes(x)), onlyPost = kb.filter((x) => !ka.includes(x));
      return { ok: false, why: `filters differ; only before: ${onlyPre.join(' ') || '(duplicate count)'}; only after: ${onlyPost.join(' ') || '(duplicate count)'}` };
    }
  }
  return { ok: true };
}

/* Exact structural diff with canonical key order; reports every differing path. */
function diffExact(a, b, p, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${p}: array vs non-array`); return; }
    if (a.length !== b.length) { out.push(`${p}: length ${a.length} -> ${b.length}`); return; }
    a.forEach((x, i) => diffExact(x, b[i], `${p}[${i}]`, out));
    return;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) out.push(`${p}.${k}: added`);
      else if (!(k in b)) out.push(`${p}.${k}: removed`);
      else diffExact(a[k], b[k], `${p}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

function compareTriggerSpec(pre, post) {
  const diffs = [];
  const hasPre = pre !== undefined && pre !== null, hasPost = post !== undefined && post !== null;
  if (!hasPre && !hasPost) return { ok: true, diffs };                    /* HTTPS: no event trigger on either side */
  if (hasPre !== hasPost) return { ok: false, diffs: [`eventTrigger: ${hasPre ? 'removed' : 'added'}`] };
  const a = Object.assign({}, pre), b = Object.assign({}, post);
  if ('eventFilters' in a || 'eventFilters' in b) {
    if (!('eventFilters' in a) || !('eventFilters' in b)) diffs.push(`eventTrigger.eventFilters: ${'eventFilters' in a ? 'removed' : 'added'}`);
    else { const m = sameFilterMultiset(a.eventFilters, b.eventFilters); if (!m.ok) diffs.push(`eventTrigger.eventFilters: ${m.why}`); }
    delete a.eventFilters; delete b.eventFilters;
  }
  diffExact(a, b, 'eventTrigger', diffs);
  return { ok: diffs.length === 0, diffs };
}

module.exports = { compareTriggerSpec };

if (require.main === module) {
  const fn = process.argv[2];
  if (!fn) { console.error('usage: node scripts/infra/compare-trigger-spec.js <functionName>'); process.exit(2); }
  try {
    const base = require(path.join(__dirname, 'recovery-baseline-20260921.json'));
    const entry = (base.entries || []).find((e) => e.function === fn);
    if (!entry || !entry.raw) { console.error(`CANNOT COMPARE: no baseline entry with raw for ${fn}`); process.exit(2); }
    const { execSync } = require('child_process');
    const region = base.region || 'us-central1', project = base.project || 'sokoni-aeb26';
    const live = JSON.parse(execSync(`gcloud functions describe ${fn} --gen2 --region ${region} --project ${project} --format=json`, { encoding: 'utf8' }));
    const r = compareTriggerSpec(entry.raw.eventTrigger, live.eventTrigger);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} [assertion 6] ${fn} trigger contract ${r.ok ? 'identical (eventFilters as a multiset)' : 'DIFFERS'}`);
    r.diffs.forEach((d) => console.log('   ', d));
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.error('CANNOT COMPARE (not a verdict):', e.message.split('\n')[0]); process.exit(2); }
}
