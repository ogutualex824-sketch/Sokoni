#!/usr/bin/env node
/* WORK/JOB ENGINE WE1 — the category-neutral core with the Marketing skin. Executes the REAL work-engine.js ops and
 * messages.js (work_project) in-process on an in-memory Firestore.
 *   node scripts/test-work-engine.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['W2', 'shared/work-engine.js', "  'proposed>accepted': ['customer'],", "  'proposed>accepted': ['customer', 'provider'],"],
    ['W3', 'work-engine.js', "      if (p.origin && p.origin.type === 'service_lead' && _total(lines) !== p.origin.acceptedQuote.amountCents) {", "      if (false) {"],
    ['W4', 'work-engine.js', "    if (!W.scopeEditable(p.status)) throw", "    if (false) throw"],
    ['W5', 'work-engine.js', "    if (actor !== 'customer') throw new HttpsError('permission-denied', 'Only the customer decides a change request.'", "    if (false) throw new HttpsError('permission-denied', 'Only the customer decides a change request.'"],
    ['W6', 'work-engine.js', "qty, rateCents: rate, amountCents: Math.round(qty * rate) };", "qty, rateCents: rate, amountCents: Number(l.amountCents) || Math.round(qty * rate) };"],
    ['W7', 'work-engine.js', "    const okRef = !raw || /^https:\\/\\/[^\\s]+$/i.test(raw) || raw.indexOf('workProjects/' + ref.id + '/') === 0;", '    const okRef = true;'],
    ['W1', 'work-engine.js', "      if (!(p && p.marketingStatus === 'active' && p.marketingListed === true)) throw", '      if (false) throw'],
    ['W8', 'messages.js', "      if (wp.customerUid !== req.auth.uid && wp.providerUid !== req.auth.uid) throw new HttpsError('permission-denied', 'Not a party to this project');", ''],
    ['W9', 'work-engine.js', "  'active>cancelled': ['admin'],", "  'active>cancelled': ['admin', 'provider'],"],
  ];
  /* W9 lives in shared/work-engine.js */
  M[M.length - 1][1] = 'shared/work-engine.js';
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wke-'));
    const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor in ' + file); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row + '  (' + file + ')'); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const done = () => { console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); };
const { DOCS } = H;
const ADM = { admin: true };
console.log('\nWork/Job Engine WE1 — core + Marketing skin\n');

(async () => {
  const WE = require(path.join(FN, 'work-engine.js'));
  const M = require(path.join(FN, 'messages.js'))._h;
  const D = (op, uid, data, token) => call((r) => WE.workDispatch.run(r), uid, Object.assign({ op }, data || {}), token);
  H.reset();
  DOCS.set('providers/mk', { uid: 'mk', status: 'active', marketingStatus: 'active', marketingListed: true, marketingCategories: ['branding'] });
  DOCS.set('providers/plain', { uid: 'plain', status: 'active' });
  ['mk', 'plain', 'cust', 'x'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('serviceLeads/L1', { providerId: 'mk', customerUid: 'cust', status: 'quote_accepted', quote: { version: 2, amountCents: 9000000, serviceId: 's1', description: '3-month brand campaign' } });
  DOCS.set('serviceLeads/L2', { providerId: 'mk', customerUid: 'cust', status: 'quote_sent', quote: { version: 1, amountCents: 100 } });
  const P = (id) => DOCS.get('workProjects/' + id);

  /* ── W1: who may create ── */
  let r = await D('workCreate', 'plain', { skin: 'marketing', kind: 'campaign', originType: 'direct', customerUid: 'cust', scope: { title: 'x' } });
  const r2 = await D('workCreate', 'mk', { skin: 'marketing', kind: 'campaign', originType: 'service_lead', leadId: 'L2' });
  const r3 = await D('workCreate', 'mk', { skin: 'marketing', kind: 'campaign', originType: 'rfq', rfqId: 'R1' });
  ck('W1', r.det && r.det.code === 'WORK_NOT_APPROVED' && r2.det && r2.det.code === 'WORK_QUOTE_NOT_ACCEPTED' && r3.det && r3.det.code === 'WORK_ORIGIN_UNSUPPORTED',
    'a non-marketer cannot create a marketing campaign; an UNaccepted quote cannot seed one; rfq origin is refused until Construction wires it', [r, r2, r3]);

  /* ── W0: from an accepted quote — idempotent, parties from the lead, scope seeded from the quote ── */
  r = await D('workCreate', 'mk', { skin: 'marketing', kind: 'campaign', originType: 'service_lead', leadId: 'L1', customerUid: 'x', scope: { title: 'Brand campaign' } });
  const again = await D('workCreate', 'mk', { skin: 'marketing', kind: 'campaign', originType: 'service_lead', leadId: 'L1' });
  const id = r.ok && r.ok.projectId, p0 = P(id) || {};
  ck('W0', r.ok && again.ok && again.ok.existing === true && again.ok.projectId === id && p0.customerUid === 'cust' && p0.providerUid === 'mk' && p0.status === 'draft'
    && p0.totalCents === 9000000 && p0.origin.acceptedQuote.amountCents === 9000000 && p0.commercial && p0.commercial.charged === false && p0.commercial.fee.enabled === false,
    'from an accepted quote: idempotent per lead+quote version; the customer comes from the LEAD (request ignored); scope seeded at the quote total; fee read as NOT enabled, never charged', p0);

  /* ── W6 + W3: scope lines are priced by the server; proposing must equal the accepted quote ── */
  r = await D('workUpdateScope', 'mk', { projectId: id, scope: { title: 'Brand campaign', lines: [{ kind: 'labour', description: 'Strategy', unit: 'day', qty: 2, rateCents: 1500000, amountCents: 1 }, { kind: 'other', description: 'Content', qty: 1, rateCents: 6000000 }],
    milestones: [{ title: 'Month 1', amountCents: 3000000 }, { title: 'Months 2-3', amountCents: 6000000 }] } });
  ck('W6', r.ok && P(id).totalCents === 9000000 && P(id).scope.lines[0].amountCents === 3000000, 'line amounts = qty × rate on the SERVER (a client amount is ignored); total recomputed', P(id).scope.lines);
  await D('workUpdateScope', 'mk', { projectId: id, scope: { lines: [{ description: 'Content', qty: 1, rateCents: 9500000 }], milestones: [{ title: 'All', amountCents: 9500000 }] } });
  r = await D('workTransition', 'mk', { projectId: id, to: 'proposed' });
  ck('W3', r.det && r.det.code === 'WORK_TOTAL_NOT_QUOTE' && P(id).status === 'draft', 'the proposal total must equal the quote the customer accepted (KES 95,000 ≠ 90,000 refused)', r);
  await D('workUpdateScope', 'mk', { projectId: id, scope: { lines: [{ kind: 'labour', description: 'Strategy', unit: 'day', qty: 2, rateCents: 1500000 }, { description: 'Content', qty: 1, rateCents: 6000000 }],
    milestones: [{ title: 'Month 1', amountCents: 3000000 }, { title: 'Months 2-3', amountCents: 6000000 }] } });
  r = await D('workTransition', 'mk', { projectId: id, to: 'proposed' });

  /* ── W2 + W4: the customer accepts; the scope locks ── */
  const pa = await D('workTransition', 'mk', { projectId: id, to: 'accepted' });
  const xa = await D('workTransition', 'x', { projectId: id, to: 'accepted' });
  const ca = await D('workTransition', 'cust', { projectId: id, to: 'accepted' });
  ck('W2', r.ok && pa.code === 'permission-denied' && xa.code === 'permission-denied' && ca.ok && P(id).status === 'accepted' && P(id).acceptedScope.totalCents === 9000000,
    'only the CUSTOMER accepts (not the provider, not a stranger); acceptance records the locked total', { pa, xa, ca });
  r = await D('workUpdateScope', 'mk', { projectId: id, scope: { lines: [{ description: 'Extra', qty: 1, rateCents: 1 }] } });
  ck('W4', r.det && r.det.code === 'WORK_SCOPE_LOCKED' && P(id).totalCents === 9000000, 'after proposing, the scope cannot be edited — changes go through a change request', r);

  /* ── W5: change request — provider proposes, ONLY the customer approves; delta becomes a milestone ── */
  await D('workTransition', 'mk', { projectId: id, to: 'active' });
  r = await D('workProposeChange', 'mk', { projectId: id, addLines: [{ kind: 'other', description: 'Extra influencer push', qty: 1, rateCents: 2000000 }], reason: 'Customer asked for TikTok', milestoneTitle: 'TikTok push' });
  const crId = r.ok && r.ok.crId;
  const selfApprove = await D('workDecideChange', 'mk', { projectId: id, crId, decision: 'approve' });
  const custApprove = await D('workDecideChange', 'cust', { projectId: id, crId, decision: 'approve' });
  const twice = await D('workDecideChange', 'cust', { projectId: id, crId, decision: 'approve' });
  const pc = P(id);
  ck('W5', r.ok && r.ok.deltaCents === 2000000 && selfApprove.code === 'permission-denied' && custApprove.ok && twice.det && twice.det.code === 'WORK_CR_DECIDED'
    && pc.totalCents === 11000000 && pc.scope.milestones.length === 3 && pc.scope.milestones.reduce((s, m) => s + m.amountCents, 0) === 11000000,
    'nothing above the accepted scope without the CUSTOMER: provider cannot self-approve; approval adds the lines + a delta milestone (milestones still sum to the total); no double approval', { selfApprove, custApprove, twice, total: pc.totalCents });

  /* ── W7: evidence refs ── */
  const e1 = await D('workAddEvidence', 'mk', { projectId: id, milestoneId: 'm1', type: 'photo', ref: 'workProjects/' + id + '/m1/proof.jpg' });
  const e2 = await D('workAddEvidence', 'mk', { projectId: id, milestoneId: 'm1', type: 'photo', ref: 'workProjects/OTHER/x.jpg' });
  const e3 = await D('workAddEvidence', 'x', { projectId: id, type: 'note', note: 'hi' });
  ck('W7', e1.ok && e2.det && e2.det.code === 'WORK_EVIDENCE_REF' && e3.code === 'permission-denied' && P(id).evidence.length === 1 && P(id).evidence[0].by === 'mk',
    'evidence: a file under THIS project or https only; another project\'s path refused; a stranger cannot add; author stamped by the server', [e1, e2, e3]);

  /* ── W9: cancellation once active is SOKONI's; completion is the customer's, typed ── */
  const pcx = await D('workTransition', 'mk', { projectId: id, to: 'cancelled' });
  const pcomp = await D('workTransition', 'mk', { projectId: id, to: 'completed' });
  const ccomp = await D('workTransition', 'cust', { projectId: id, to: 'completed', completionKind: 'delivered' });
  const arch = await D('workTransition', 'cust', { projectId: id, to: 'archived' });
  const after = await D('workTransition', 'cust', { projectId: id, to: 'active' });
  ck('W9', pcx.code === 'permission-denied' && pcomp.code === 'permission-denied' && ccomp.ok && P(id).completion.kind === 'delivered' && P(id).completion.acceptedBy === 'cust'
    && arch.ok && after.det && after.det.code === 'WORK_TERMINAL',
    'a provider cannot cancel active work or self-complete; the customer completes (typed); archived is terminal', { pcx, pcomp, ccomp, after });

  /* ── W8: Messages — parties from the PROJECT, re-derived every send ── */
  const o1 = await call(M.createConversation, 'cust', { transactionType: 'work_project', transactionId: id, participantUids: ['cust', 'x'] });
  const conv = DOCS.get('conversations/work_project_' + id) || {};
  DOCS.set('conversations/work_project_' + id, Object.assign({}, conv, { participants: (conv.participants || []).concat(['x']) }));
  const s1 = await call(M.sendMessage, 'x', { conversationId: 'work_project_' + id, type: 'text', text: 'hi' });
  const s2 = await call(M.sendMessage, 'mk', { conversationId: 'work_project_' + id, type: 'text', text: 'Update on month 1' });
  ck('W8', o1.ok && JSON.stringify((conv.participants || []).slice().sort()) === JSON.stringify(['cust', 'mk']) && s1.code === 'permission-denied' && s2.ok,
    'the project conversation seats exactly customer + provider (request list ignored); a forged stored participant cannot send', { conv: conv.participants, s1, s2 });

  /* ── W10: reads ── */
  const lm = await D('workListMine', 'cust'), lx = await D('workGet', 'x', { projectId: id }), la = await D('workAdminList', 'admin1', { skin: 'marketing' }, ADM), ln = await D('workAdminList', 'mk', {}, {});
  ck('W10', lm.ok && lm.ok.items.length === 1 && lm.ok.items[0].role === 'customer' && lx.code === 'permission-denied' && la.ok && la.ok.items.length === 1 && ln.code === 'permission-denied',
    'my projects (by party); a stranger cannot read one; AdminOS list is admin-only', { lm: lm.ok, lx, ln });
  done();
})().catch((e) => { console.error(e); ck('CRASH', false, e.message); done(); });
