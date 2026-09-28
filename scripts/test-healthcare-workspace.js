/* test-healthcare-workspace.js — the category-aware Healthcare workspace (CHANGELOG 233). Transactional fake
 * Firestore + the REAL functions/healthcare-workspace.js, provider-shop.js, provider-dispatch.js and
 * capability-authority.js. subscription-core's resolver is stubbed (the plan is its own authority, proven by
 * test-healthcare-subscription-foundation.js); the merchant provisioning calls are stubbed so the GATE is what
 * is measured. No network.
 *
 * PROVES
 *   matrix      the six categories + unclassified: what each kind of practice is offered; POS/Till only for a
 *               facility, pharmacy or laboratory AND only on a live plan; Quick Charge and calls BLOCKED with a reason
 *   patients    EVERY category (pharmacy and unclassified included) keeps its patient roster, labelled "Patients"
 *   identity    a provider is Healthcare only by the server-written `healthcare` attribute — a free-text "Clinic" is not
 *   sections    no Entertainment-only section is ever listed; an offered operation's section appears only once its
 *               surface is wired; every listed operation names a server check
 *   gate        providerRequestShop refuses a clinician / telemedicine / home-care / unclassified practice even on a
 *               paid plan (hiding the button is not the gate); a facility / pharmacy / laboratory on a plan passes
 *   dispatch    healthcareWorkspace is routed, refuses the signed-out, and answers only for the CALLER
 *   routing     no page links to the non-existent healthcare-/pharmacy-dashboard.html; the dashboard loads the
 *               workspace and tags every navigation item with a section key
 *
 *   node scripts/test-healthcare-workspace.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hc-workspace';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });

/* The plan authority: uid -> { tier, status }. */
const PLANS = {};
stub('./subscription-core', { resolveSubscription: async (uid) => (PLANS[uid] ? Object.assign({ found: true }, PLANS[uid]) : { found: false }) });
/* The merchant provisioning calls — stubbed so the category GATE is what is measured. */
const PROVISIONED = [];
stub('./application-lifecycle', { _internal: { projectSeller: async (_db, _app, uid) => { PROVISIONED.push(uid); return { id: uid }; } } });
stub('./sokoni-till', { _internal: { mintSokoniTillCore: async () => ({ sokoniTillId: 'T1', created: true }) } });
stub('./business-wallet', { ensureBusinessWallet: async () => ({ action: 'created' }) });
stub('./role-authority', { grantAccountRole: async () => ({ ok: true }) });

const HW = require(Path.join(FN, 'healthcare-workspace.js'));
const HC = require(Path.join(FN, 'healthcare-category.js'));
const SHOP = require(Path.join(FN, 'provider-shop.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const codeOf = async (p) => { const e = await errOf(p); return e ? ((e.details && e.details.code) || e.code || e.message) : null; };
const PLAN = { shopRequestable: true };
const NOPLAN = { shopRequestable: false };

(async () => {
  say('\n── the category matrix ──');
  const counter = ['facility', 'pharmacy', 'laboratory'];
  ck('POS/Till is offered to a facility, a pharmacy and a laboratory on a live plan', counter.every((c) => HW.allows(c, PLAN, 'posTill')));
  ck('…and to none of them without a plan', counter.every((c) => !HW.allows(c, NOPLAN, 'posTill')));
  ck('POS/Till is NEVER offered to a clinician, telemedicine or home-care practice, or an unclassified one — even on a plan',
    ['clinician', 'telemedicine', 'home_care', null, 'free text'].every((c) => !HW.allows(c, PLAN, 'posTill')));
  ck('products AND inventory are offered exactly where a counter is (facility, pharmacy, laboratory) on a plan',
    HC.CATEGORIES.filter((c) => HW.allows(c, PLAN, 'products')).join() === 'facility,pharmacy,laboratory'
    && HC.CATEGORIES.filter((c) => HW.allows(c, PLAN, 'inventory')).join() === 'facility,pharmacy,laboratory');
  ck('…never to a clinician, telemedicine, home-care or unclassified practice, even on a plan',
    ['clinician', 'telemedicine', 'home_care', null].every((c) => !HW.allows(c, PLAN, 'products') && !HW.allows(c, PLAN, 'inventory')));
  ck('delivery is a pharmacy operation only', HC.CATEGORIES.filter((c) => HW.allows(c, PLAN, 'delivery')).join() === 'pharmacy');
  ck('a pharmacy keeps no clinical records and issues no prescriptions', !HW.allows('pharmacy', PLAN, 'clinicalRecords') && !HW.allows('pharmacy', PLAN, 'prescriptions'));
  ck('an unknown operation (e.g. quickCharge) is refused for every category', [...HC.CATEGORIES, null].every((c) => !HW.allows(c, PLAN, 'quickCharge') && !HW.allows(c, PLAN, 'calls')));
  ck('every category in healthcare-category has a matrix row (no category falls through to a default)', HC.CATEGORIES.every((c) => HW.MATRIX[c]) && Object.keys(HW.MATRIX).length === HC.CATEGORIES.length);

  say('\n── patients: every practice keeps its roster ──');
  ck('the patient roster is offered to all six categories AND to an unclassified practice', [...HC.CATEGORIES, null].every((c) => HW.allows(c, NOPLAN, 'patients')));
  ck('…and it is never plan-gated (an expired plan does not take a practice\'s patients away)', !HW.PLAN_GATED.patients);

  say('\n── the workspace, per account ──');
  const seed = async (uid, doc) => db.doc('providers/' + uid).set(Object.assign({ name: uid, status: 'active' }, doc));
  for (const c of HC.CATEGORIES) { await seed('p_' + c, { healthcare: { category: c, source: 'application' } }); PLANS['p_' + c] = { tier: 'clinic', status: 'active' }; }
  await seed('p_unc', { healthcare: { category: null, source: 'application' } }); PLANS.p_unc = { tier: 'clinic', status: 'active' };
  await seed('p_fake', { category: 'Clinic' });   /* free-text claim, no server attribute */
  await seed('p_lapsed', { healthcare: { category: 'pharmacy', source: 'admin' } }); PLANS.p_lapsed = { tier: 'clinic', status: 'expired' };
  const W = {};
  for (const u of [...HC.CATEGORIES.map((c) => 'p_' + c), 'p_unc', 'p_fake', 'p_lapsed', 'nobody']) W[u] = await HW.workspaceFor(db, u);

  ck('a free-text "Clinic" is NOT a Healthcare workspace; an absent provider is not found', W.p_fake.found && W.p_fake.healthcare === false && W.nobody.found === false);
  ck('every classified practice gets its category and its label', HC.CATEGORIES.every((c) => W['p_' + c].healthcare && W['p_' + c].category === c && W['p_' + c].label === HC.LABELS[c]));
  ck('the roster is labelled "Patients" for EVERY category — pharmacy and unclassified included',
    [...HC.CATEGORIES.map((c) => 'p_' + c), 'p_unc', 'p_lapsed'].every((u) => W[u].customersLabel === 'Patients' && W[u].sections.includes('customers')));
  ck('an unclassified practice: appointments + patients only, with the reason stated', W.p_unc.classified === false
    && Object.keys(W.p_unc.operations).filter((k) => W.p_unc.operations[k]).sort().join() === 'appointments,patients'
    && /awaiting/i.test(W.p_unc.reasons.posTill || ''), W.p_unc.operations);
  ck('a lapsed plan: a pharmacy loses the Till REQUEST (plan-gated) but keeps its patients and delivery', W.p_lapsed.operations.posTill === false
    && /plan/i.test(W.p_lapsed.reasons.posTill) && W.p_lapsed.operations.patients && W.p_lapsed.operations.delivery);
  /* SHOP SURVIVAL: the plan gates the REQUEST, never an existing Shop (provider-shop.js). */
  await seed('p_kept', { healthcare: { category: 'pharmacy', source: 'admin' } }); PLANS.p_kept = { tier: 'clinic', status: 'expired' };
  await db.doc('shops/p_kept').set({ ownerId: 'p_kept', status: 'active' });
  await seed('p_forged', { healthcare: { category: 'pharmacy', source: 'admin' }, shopId: 'someone_elses' }); PLANS.p_forged = { tier: 'clinic', status: 'expired' };
  await db.doc('shops/someone_elses').set({ ownerId: 'victim', status: 'active' });
  await seed('p_theirs', { healthcare: { category: 'pharmacy', source: 'admin' } }); PLANS.p_theirs = { tier: 'clinic', status: 'expired' };
  await db.doc('shops/p_theirs').set({ ownerId: 'victim', status: 'active' });
  await seed('p_clin_shop', { healthcare: { category: 'clinician', source: 'admin' } }); PLANS.p_clin_shop = { tier: 'clinic', status: 'active' };
  await db.doc('shops/p_clin_shop').set({ ownerId: 'p_clin_shop', status: 'active' });
  const kept = await HW.workspaceFor(db, 'p_kept');
  ck('a pharmacy WITH a Shop keeps its Till, products and inventory after its plan lapses', kept.hasShop && HW.SHOP_OPS.every((o) => kept.operations[o] === true), kept.operations);
  ck('a provider-written shopId pointer at someone else\'s shop confers nothing', (await HW.workspaceFor(db, 'p_forged')).operations.posTill === false);
  ck('a shops/{uid} doc owned by someone else confers nothing', (await HW.workspaceFor(db, 'p_theirs')).hasShop === false);
  const cs = await HW.workspaceFor(db, 'p_clin_shop');
  ck('an existing Shop never overrides the CATEGORY (a clinician with a shop doc still gets no Till/products/inventory)', HW.SHOP_OPS.every((o) => cs.operations[o] === false), cs.operations);

  ck('Quick Charge and calls are returned BLOCKED, with a reason, for every practice',
    Object.values(W).filter((w) => w.healthcare).every((w) => /Quick Charge/.test(w.blocked.quickCharge) && /Calls/.test(w.blocked.calls) && !('quickCharge' in w.operations)));
  ck('the plan is reported as the plan authority resolved it (no invented tier)', W.p_facility.plan.tier === 'clinic' && W.p_facility.plan.status === 'active' && W.p_lapsed.plan.found === true);

  say('\n── sections ──');
  const all = Object.values(W).filter((w) => w.healthcare);
  ck('no Entertainment-only section is ever listed', all.every((w) => !w.sections.includes('ent')));
  /* No dead ends: every section the server lists must be a REAL screen on the dashboard (an element carrying
     that data-hc-section key). A later commit that wires POS adds both the key and the screen — or this fails. */
  const dashKeys = new Set((fs.readFileSync(Path.join(ROOT, 'provider-dashboard.html'), 'utf8').match(/data-hc-section="([a-z]+)"/g) || []).map((m) => m.slice(17, -1)));
  const listed = [...new Set(all.flatMap((w) => w.sections))];
  ck('every section the server lists exists on the dashboard — an unwired surface is never offered (no dead ends)',
    listed.every((k) => dashKeys.has(k)) && all.some((w) => w.operations.posTill), listed.filter((k) => !dashKeys.has(k)));
  ck('every operation a category can be offered names a server check, or states why not', Object.keys(HW.UNCLASSIFIED).every((op) => HW.ENFORCED_BY[op] || HW.PENDING[op]));
  ck('posTill\'s named check is the one this suite proves (provider-shop.js)', /provider-shop\.js/.test(HW.ENFORCED_BY.posTill));

  say('\n── the server gate: providerRequestShop ──');
  const req = (uid) => SHOP.providerRequestShop({ auth: { uid }, data: {} });
  for (const c of ['clinician', 'telemedicine', 'home_care']) {
    ck(`a ${c} on a paid plan is REFUSED a Shop/Till`, await codeOf(req('p_' + c)) === 'HC_OPERATION_NOT_OFFERED');
  }
  ck('an unclassified practice on a paid plan is REFUSED (awaiting classification)', /classification/i.test(((await errOf(req('p_unc'))) || {}).message || ''));
  PROVISIONED.length = 0;
  for (const c of counter) {
    const r = await req('p_' + c).catch((e) => ({ error: e.message }));
    ck(`a ${c} on a paid plan passes the gate and is provisioned`, r && r.success === true && PROVISIONED.includes('p_' + c), r);
  }
  ck('nothing was provisioned for a refused category', !PROVISIONED.some((u) => ['p_clinician', 'p_telemedicine', 'p_home_care', 'p_unc'].includes(u)), PROVISIONED);
  ck('(plan still first) a pharmacy on a lapsed plan is refused for the PLAN', /subscription/i.test(((await errOf(req('p_lapsed'))) || {}).message || ''));

  say('\n── dispatch ──');
  const PD = fs.readFileSync(Path.join(FN, 'provider-dispatch.js'), 'utf8');
  ck('healthcareWorkspace is a providerDispatch route backed by healthcare-workspace._h', /'healthcareWorkspace',/.test(PD) && /require\('\.\/healthcare-workspace'\)\._h/.test(PD));
  ck('the signed-out are refused', await codeOf(HW._h.healthcareWorkspace({ auth: null, data: {} })) === 'unauthenticated');
  const mine = await HW._h.healthcareWorkspace({ auth: { uid: 'p_clinician' }, data: { uid: 'p_pharmacy' } });
  ck('it answers for the CALLER only — a data.uid naming another practice is ignored', mine.category === 'clinician');

  say('\n── routing + the dashboard ──');
  const pages = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'docs', 'functions', 'scripts', '.git'].includes(e.name) || e.name.startsWith('.')) continue; const p = Path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(html|js)$/.test(e.name)) pages.push(p); } };
  walk(ROOT);
  const dead = pages.filter((p) => /(healthcare|pharmacy)-dashboard\.html/.test(fs.readFileSync(p, 'utf8'))).map((p) => Path.relative(ROOT, p));
  ck('no page links to the non-existent healthcare-/pharmacy-dashboard.html', dead.length === 0 && !fs.existsSync(Path.join(ROOT, 'healthcare-dashboard.html')), dead);
  /* CHANGELOG 240 (C2c): every business role now opens the ONE resolver, workspace.html, which the server answers
     (business-workspace.homeFor → provider-dashboard.html for Healthcare; proven in test-workspace-routing.js). */
  ck('profile.js sends a Healthcare provider to its workspace (the resolver), not to the patient directory',
    /healthcare: \{[^}]*dash: "workspace\.html"/.test(fs.readFileSync(Path.join(ROOT, 'profile.js'), 'utf8'))
    && !/healthcare: \{[^}]*dash: "healthcare\.html"/.test(fs.readFileSync(Path.join(ROOT, 'profile.js'), 'utf8')));
  const html = fs.readFileSync(Path.join(ROOT, 'provider-dashboard.html'), 'utf8');
  ck('the dashboard loads sokoni-health-workspace.js and has the workspace banner slot', /<script src="sokoni-health-workspace\.js" defer><\/script>/.test(html) && /id="hcWorkspace"/.test(html));
  const items = (html.match(/<(div|a|button)[^>]*>/g) || []).filter((t) => /class="(sb-item[^"]*|more-item)"/.test(t));
  /* CHANGELOG 235: the partial mobile "More" sheet is gone — on a phone the whole sidebar is the drawer — so every
     control is a sidebar item (20 + Plan & Subscription). */
  ck('every sidebar item carries a section key (none can escape the workspace)', items.length >= 21 && items.every((t) => /data-hc-section="[a-z]+"/.test(t)), items.filter((t) => !/data-hc-section/.test(t)));
  ck('the sidebar brand is the SOKONI mark (assets/logosokoni.png) with the provider / facility name slot', html.includes('<img class="sb-mark" src="assets/logosokoni.png"') && html.includes('id="sbName"') && html.includes('id="sbKind"') && fs.existsSync(Path.join(ROOT, 'assets', 'logosokoni.png')));
  const groups = (html.match(/<div class="sb-group" role="group" aria-label="([A-Za-z]+)">/g) || []).map((m) => m.match(/aria-label="([A-Za-z]+)"/)[1]);
  ck('the sidebar is grouped: Overview · Storefront · Bookings · Business · Communication · Growth · Finance · Plan', groups.join() === 'Overview,Storefront,Bookings,Business,Communication,Growth,Finance,Plan', groups);
  ck('Plan & Subscription is reachable from the sidebar (not only a settings tab)', items.some((t) => t.includes('data-hc-section="subscription"') && t.includes("P.show('settings',this,'sub')")));
  ck('on a phone the SAME sidebar is a drawer: the bottom bar Menu opens it (aria-controls/expanded), the old sheet is gone', (() => { const m = (html.match(/<div class="bn-item" id="bnMenu"[^>]*>/) || [''])[0]; return m.includes('aria-controls="sidebar"') && m.includes('aria-expanded="false"') && m.includes('onclick="Nav.open()"'); })()
    && !html.includes('id="moreSheet"') && html.includes('body.nav-open .sidebar{transform:none}'));
  const entTagged = items.filter((t) => /data-hc-section="ent"/.test(t));
  ck('rate cards, the booking-PIN page, call requests and booked-hours are tagged Entertainment-only',
    entTagged.length === 4 && ['ratecards', 'entertainment.html', "'calls'", "'stats'"].every((k) => entTagged.some((t) => t.includes(k))), entTagged);
  ck('every roster label is swappable to "Patients" (sidebar, page title)', (html.match(/data-hc-label="customers"/g) || []).length === 2);

  say('\n── the client applies only the server\'s answer ──');
  /* A minimal DOM: enough to run apply() against the tagged markup. */
  const els = items.map((t) => ({ key: (t.match(/data-hc-section="([a-z]+)"/) || [])[1], hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-hc-section' ? this.key : null; } }));
  const labels = [0, 1].map(() => ({ textContent: 'Customers' }));
  const box = { hidden: true, innerHTML: '' };
  global.window = {}; global.document = { readyState: 'complete', documentElement: { setAttribute() {} }, head: { appendChild() {} }, createElement: () => ({}),
    querySelectorAll: (q) => (q === '[data-hc-section]' ? els : q === '[data-hc-label="customers"]' ? labels : []), getElementById: (id) => (id === 'hcWorkspace' ? box : null), addEventListener() {} };
  global.firebase = undefined;
  new Function(fs.readFileSync(Path.join(ROOT, 'sokoni-health-workspace.js'), 'utf8'))();
  const evil = Object.assign({}, W.p_pharmacy, { label: '<img src=x onerror=alert(1)>' });
  window.SokoniHealthWorkspace.apply(evil);
  const visible = els.filter((e) => !e.hidden).map((e) => e.key);
  ck('Entertainment-only items are hidden for a Healthcare practice', els.filter((e) => e.key === 'ent').every((e) => e.hidden));
  ck('the patient roster stays visible', visible.includes('customers') && labels.every((l) => l.textContent === 'Patients'));
  ck('the banner states the category, plan and blocked items — escaped', !box.hidden && /&lt;img/.test(box.innerHTML) && !/<img/.test(box.innerHTML) && /Quick Charge/.test(box.innerHTML));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
