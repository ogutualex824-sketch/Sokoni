#!/usr/bin/env node
/* MARKETING HUB MK5c (Super Admin) — super-admin.html SA.loadMarketing executed in a VM with stubbed DOM + callables.
 * Proves: read-only over the SAME marketingDispatch admin reads AdminOS uses (no applicationDecide, no write); escaped;
 * coverage COUNTED from the active services the server returned (a real 0 shows as 0, an inactive service never counts);
 * a failed read says "not an empty hub" instead of rendering zeros; no editable money field on the panel.
 *   node scripts/test-sa-marketing.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nSuper Admin › Marketing Hub (MK5c)\n');
const html = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
const start = html.indexOf('  async loadMarketing(){'), end = html.indexOf('  // Sign Out', start);
const method = start > 0 && end > start ? html.slice(start, end).trim().replace(/,\s*$/, '') : '';
const panelStart = html.indexOf('<section class="sa-panel" id="panel-marketing"'), panel = html.slice(panelStart, html.indexOf('</section>', panelStart));

const els = {}; ['saMktPipeline', 'saMktMarketers', 'saMktCoverage', 'saMktBookings'].forEach((i) => { els[i] = { innerHTML: '' }; });
const calls = []; let mode = 'ok';
const DATA = {
  marketingAdminOverview: { counts: { listed: 1, byStatus: { pending: 2, approved: 1 }, byType: { agency: 1 } } },
  marketingAdminProviders: { items: [{ uid: 'u1', name: 'Achieng <b>X</b>', marketingType: 'agency', marketingStatus: 'active', listed: true, categories: ['branding'], reviewCount: 0, rating: null }] },
  marketingAdminServices: { items: [{ id: 's1', category: 'branding', active: true }, { id: 's2', category: 'branding', active: true }, { id: 's3', category: 'seo', active: false }] },
  marketingAdminBookings: { items: [{ id: 'bk1', service: 'Logo', serviceCategory: 'logo-design', priceCents: 1500000, status: 'confirmed', paymentStatus: 'paid_held', commissionCents: null }] },
};
const G = { document: { getElementById: (i) => els[i] || null }, Promise, Object, String, Number, Math, JSON, Array };
G.window = G;
const ctx = vm.createContext(G);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-marketing-taxonomy.js'), 'utf8'), ctx);
vm.runInContext('var SA = { _fns: null, ' + method + ' };', ctx);
G.SA = vm.runInContext('SA', ctx);
G.SA._fns = { httpsCallable: (name) => async (data) => { calls.push(Object.assign({ fn: name }, data)); if (mode === 'err') throw new Error('permission-denied'); return { data: DATA[data.op] }; } };

(async () => {
  ck('A0', method.length > 100, 'super-admin.html defines SA.loadMarketing');
  await G.SA.loadMarketing();
  ck('A1', calls.length === 4 && calls.every((c) => c.fn === 'marketingDispatch') && ['marketingAdminOverview', 'marketingAdminProviders', 'marketingAdminServices', 'marketingAdminBookings'].every((op) => calls.some((c) => c.op === op))
    && !/applicationDecide|\.set\(|\.update\(|collection\(/.test(method),
    'reads ONLY the marketingDispatch admin reads AdminOS uses; never decides, never writes', calls.map((c) => c.fn + ':' + c.op));
  ck('A2', /Achieng &lt;b&gt;X&lt;\/b&gt;/.test(els.saMktMarketers.innerHTML) && /No reviews yet/.test(els.saMktMarketers.innerHTML) && /Branding/.test(els.saMktMarketers.innerHTML),
    'marketers table escapes names, labels approved services, never invents a rating', els.saMktMarketers.innerHTML.slice(0, 200));
  ck('A3', /Branding · 2/.test(els.saMktCoverage.innerHTML) && /Search Engine Optimization \(SEO\) · 0/.test(els.saMktCoverage.innerHTML),
    'coverage is COUNTED from active services (2 branding; the inactive SEO service does not count → 0)', els.saMktCoverage.innerHTML.slice(0, 400));
  ck('A4', /paid_held/.test(els.saMktBookings.innerHTML) && /On completion/.test(els.saMktBookings.innerHTML) && /KES 15,000/.test(els.saMktBookings.innerHTML),
    'bookings show the server money state; commission is "On completion" until settlement, never a guess');
  mode = 'err'; await G.SA.loadMarketing();
  ck('A5', /not an empty hub/.test(els.saMktPipeline.innerHTML) && els.saMktMarketers.innerHTML === '' && !/· 0/.test(els.saMktCoverage.innerHTML),
    'a failed read says so ("not an empty hub") — no zeros rendered', els.saMktPipeline.innerHTML);
  ck('A6', panelStart > 0 && !/<input|<select|<textarea|contenteditable/i.test(panel) && /admin-os\.html#marketing/.test(panel) && /data-section="marketing"/.test(html) && /sokoni-marketing-taxonomy\.js/.test(html)
    && /else if\(section==='marketing'\)this\.loadMarketing\(\);/.test(html),
    'the panel has NO editable field; decisions link to AdminOS › Marketing; nav + taxonomy + loader wired');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
