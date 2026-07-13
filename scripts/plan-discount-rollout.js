#!/usr/bin/env node
'use strict';
/**
 * PLAN DISCOUNT ROLLOUT — operator control for subscription commission discounts.
 *
 * Engineering delivers capability. Business decides when capability becomes policy.
 *
 * The Commission Engine can apply subscription-plan discounts. Whether it DOES is decided here,
 * by writing revenueConfig/plan_adjustments. Enabling, disabling, increasing, decreasing or
 * suspending a discount NEVER requires a deployment.
 *
 * The switch fails closed: if this document is absent, unreadable, or `enabled` is not exactly
 * true, no discount is applied to anyone. Phase 1 is therefore the do-nothing state.
 *
 *   node scripts/plan-discount-rollout.js status
 *   node scripts/plan-discount-rollout.js disable                     # PHASE 1 / instant rollback
 *   node scripts/plan-discount-rollout.js enable                      # master switch on
 *   node scripts/plan-discount-rollout.js add-plan seller_pro --label "Pro Plan Discount"
 *   node scripts/plan-discount-rollout.js add-plan business --delta -1 --label "Business Discount"
 *   node scripts/plan-discount-rollout.js add-plan seller_enterprise --discount 10
 *   node scripts/plan-discount-rollout.js remove-plan seller_pro
 *
 * Adjustment precedence per plan: --delta (points off) > --discount (relative %) >
 * the Subscription Engine's own features.commission_discount_pct (relative).
 *
 * SAFETY (enforced in the engine, not here — config cannot loosen it):
 *   never negative · never above the base · capped at maxDiscountPct (<=50) ·
 *   floored at minEffectivePct (never zero unless allowZero:true) ·
 *   expired/inactive subscriptions get nothing · unlisted plans get nothing.
 */
const https = require('https');
const fs = require('fs');

const PROJECT = 'sokoni-aeb26';
const DOC = 'plan_adjustments';
const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

function req(method, path, body, token) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      host: 'firestore.googleapis.com', path, method,
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, s => { let b = ''; s.on('data', c => b += c); s.on('end', () => res({ status: s.statusCode, body: b })); });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

async function token() {
  const cfgPath = process.env.USERPROFILE + '/.config/configstore/firebase-tools.json';
  const refresh = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).tokens.refresh_token;
  const post = (host, path, form) => new Promise((res, rej) => {
    const r = https.request({ host, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } },
      s => { let b = ''; s.on('data', c => b += c); s.on('end', () => res(b)); });
    r.on('error', rej); r.write(form); r.end();
  });
  const body = 'client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com'
    + '&client_secret=j9iVZfS8kkCEFUPaAeJV0sAi'
    + '&refresh_token=' + encodeURIComponent(refresh) + '&grant_type=refresh_token';
  return JSON.parse(await post('oauth2.googleapis.com', '/token', body)).access_token;
}

/* Firestore REST <-> plain JS */
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
function fromFs(f) {
  if (!f) return null;
  if ('booleanValue' in f) return f.booleanValue;
  if ('doubleValue' in f) return Number(f.doubleValue);
  if ('integerValue' in f) return Number(f.integerValue);
  if ('stringValue' in f) return f.stringValue;
  if ('nullValue' in f) return null;
  if ('mapValue' in f) return Object.fromEntries(
    Object.entries(f.mapValue.fields || {}).map(([k, v]) => [k, fromFs(v)]));
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(fromFs);
  return null;
}

const PATH = `/v1/projects/${PROJECT}/databases/(default)/documents/revenueConfig/${DOC}`;

async function load(tok) {
  const r = await req('GET', PATH, null, tok);
  if (r.status === 404) return null;
  const j = JSON.parse(r.body);
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, fromFs(v)]));
}

async function save(tok, cfg) {
  const fields = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, toFs(v)]));
  const r = await req('PATCH', PATH, { fields }, tok);
  if (r.status >= 300) { console.error('  write failed: ' + r.status + ' ' + r.body.slice(0, 200)); process.exit(1); }
}

function show(cfg) {
  if (!cfg) {
    console.log('  revenueConfig/plan_adjustments: ABSENT');
    console.log('  => plan discounts are OFF. No seller receives an adjustment. (Phase 1)');
    return;
  }
  const on = cfg.enabled === true;
  console.log('  master switch   : ' + (on ? 'ENABLED' : 'DISABLED') + (on ? '' : '  => no seller receives an adjustment'));
  console.log('  maxDiscountPct  : ' + (cfg.maxDiscountPct != null ? cfg.maxDiscountPct : '50 (default cap)'));
  console.log('  minEffectivePct : ' + (cfg.minEffectivePct != null ? cfg.minEffectivePct : '0.5 (default floor)'));
  console.log('  allowZero       : ' + (cfg.allowZero === true));
  const plans = cfg.plans || {};
  const keys = Object.keys(plans);
  console.log('  plans           : ' + (keys.length ? '' : '(none listed — nobody is discounted)'));
  keys.forEach(k => {
    const p = plans[k];
    const how = p.deltaPct != null ? p.deltaPct + ' points'
      : p.discountPct != null ? p.discountPct + '% relative'
      : 'subscription catalog (commission_discount_pct)';
    console.log('    ' + (p.enabled === true ? '[ON ] ' : '[off] ') + k.padEnd(20) + how
      + (p.label ? '  "' + p.label + '"' : ''));
  });
  if (on && keys.some(k => plans[k].enabled === true)) {
    console.log('\n  LIVE: the plans marked [ON] are receiving commission discounts.');
  }
}

(async () => {
  const tok = await token();
  let cfg = await load(tok);

  if (!cmd || cmd === 'status') {
    console.log('Plan discount rollout\n');
    show(cfg);
    return;
  }

  cfg = cfg || { enabled: false, maxDiscountPct: 50, minEffectivePct: 0.5, allowZero: false, plans: {} };
  cfg.plans = cfg.plans || {};

  if (cmd === 'enable')  { cfg.enabled = true; }
  else if (cmd === 'disable') { cfg.enabled = false; }
  else if (cmd === 'add-plan') {
    const tier = args[1];
    if (!tier) { console.error('  usage: add-plan <tier> [--delta N | --discount N] [--label "..."]'); process.exit(1); }
    const p = { enabled: true };
    const d = flag('delta'), disc = flag('discount'), label = flag('label');
    if (d !== undefined) p.deltaPct = Number(d);
    if (disc !== undefined) p.discountPct = Number(disc);
    if (label) p.label = label;
    cfg.plans[tier] = p;
  } else if (cmd === 'remove-plan') {
    const tier = args[1];
    if (!tier || !cfg.plans[tier]) { console.error('  no such plan: ' + tier); process.exit(1); }
    delete cfg.plans[tier];
  } else {
    console.error('  unknown command: ' + cmd);
    console.error('  commands: status | enable | disable | add-plan <tier> | remove-plan <tier>');
    process.exit(1);
  }

  await save(tok, cfg);
  console.log('Plan discount rollout — updated\n');
  show(cfg);
  console.log('\n  Takes effect within 60s (the engine caches this document for one minute).');
  console.log('  No deployment required.');
})();
