#!/usr/bin/env node
/* Merchant Disputes — the client layer and the boundary rules (2D-2 step 4).
 *
 *   node scripts/test-merchant-disputes.js
 *
 * FIXTURE: SELLER_A (account) !== SHOP_B; SHOP_C belongs to somebody else.
 *
 * The three properties this suite holds:
 *
 *   1. Responding is NOT resolving. sellerRespondToDispute sets status
 *      `seller_responded`, which means SOKONI has not decided. Nothing in the
 *      layer or the surface may render that as settled.
 *   2. A merchant cannot open, cancel or resolve a dispute — the server refuses
 *      all three — and the surface must EXPLAIN rather than silently omit.
 *   3. Scope is ACCOUNT-level and declared. A dispute carries no shopId, so a
 *      client-side shop filter would invent a boundary the server never applied.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const DP = require(path.join(ROOT, 'sokoni-merchant-disputes.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SRC = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const CODE = (f) => code(SRC(f));

const OPEN = { id: 'dp_o1', orderId: 'o1', reason: 'not_received', description: 'Never arrived',
  status: 'open', amount: 2400, evidence: [], timeline: [] };
const RESPONDED = Object.assign({}, OPEN, { id: 'dp_o2', status: 'seller_responded', sellerResponse: 'Delivered on the 14th' });
const RESOLVED = Object.assign({}, OPEN, { id: 'dp_o3', status: 'resolved' });

(async () => {

/* ═══ A — responding is not resolving ═══ */
console.log('\nPART A — a response is not a resolution\n');
{
  ck('A1  seller_responded is still an OPEN status', DP.isOpen('seller_responded') === true);
  ck('A2  ...and its label says SOKONI has not decided',
    /Awaiting SOKONI review/i.test(DP.statusInfo('seller_responded').label), DP.statusInfo('seller_responded').label);
  ck('A3  no open status is labelled as resolved',
    DP.OPEN_STATUSES.every((s) => !/resolved|settled|closed|won|lost/i.test(DP.statusInfo(s).label)),
    DP.OPEN_STATUSES.map((s) => DP.statusInfo(s).label).join(' | '));
  ck('A4  only SOKONI resolves, and the label says so',
    /Resolved by SOKONI/i.test(DP.statusInfo('resolved').label));
  ck('A5  a resolved dispute is not open', DP.isOpen('resolved') === false);

  const ui = CODE('sokoni-merchant-disputes-ui.js');
  /* Asserted POSITIVELY. The first version banned words like "settled" near the
     response-sent state and failed on the sentence "nothing is settled yet" —
     the very disclaimer that makes the screen honest. What matters is not which
     words are absent but that the state SAYS it is unresolved. */
  const sent = (ui.match(/Response sent[\s\S]{0,700}/) || [''])[0];
  ck('A6  the response-sent state is headlined "Awaiting SOKONI review"',
    /Awaiting SOKONI review/.test(sent));
  ck('A7  ...and states explicitly that nothing is settled yet',
    /nothing is settled yet/i.test(sent) && /stays open/i.test(sent));
  ck('A8  the evidence-added state says the same',
    /Evidence added[\s\S]{0,600}Awaiting SOKONI review/.test(ui));
}

/* ═══ B — what a merchant cannot do, and that it is EXPLAINED ═══ */
console.log('\nPART B — open, cancel and resolve are not the merchant\'s\n');
{
  const p = DP.permissions(OPEN);
  ck('B1  canOpen is false', p.canOpen === false);
  ck('B2  canCancel is false', p.canCancel === false);
  ck('B3  canResolve is false', p.canResolve === false);
  ck('B4  ...but responding and evidence ARE allowed while open',
    p.canRespond === true && p.canAddEvidence === true);

  const done = DP.permissions(RESOLVED);
  ck('B5  a closed dispute allows neither response nor evidence',
    done.canRespond === false && done.canAddEvidence === false);

  const already = DP.permissions(RESPONDED);
  ck('B6  a dispute already responded to does not offer a second response',
    already.canRespond === false);
  ck('B7  ...but evidence may still be added while it is open', already.canAddEvidence === true);

  /* The refused calls must not be bound anywhere in the merchant path. */
  const FORBIDDEN = ['createDispute', 'cancelDispute', 'adminResolveDispute', 'adminGetAllDisputes'];
  const merchantPath = CODE('merchant.html') + CODE('sokoni-merchant-disputes.js') + CODE('sokoni-merchant-disputes-ui.js');
  const leaked = FORBIDDEN.filter((n) => new RegExp("['\"]" + n + "['\"]").test(merchantPath));
  ck('B8  no buyer-only or admin-only dispute call is bound in the merchant path',
    leaked.length === 0, leaked.join(','));
  ck('B9  the client layer names only the four party-scoped authorities',
    Object.values(DP.CALLABLES).sort().join(',') ===
    'addDisputeEvidence,getDisputeDetail,getSellerDisputes,sellerRespondToDispute',
    Object.values(DP.CALLABLES).join(','));

  const ui = SRC('sokoni-merchant-disputes-ui.js');
  ck('B10 the surface EXPLAINS that a merchant cannot open one',
    /You cannot open a dispute here/i.test(ui));
  ck('B11 ...and says where disputes come from', /raised by the buyer/i.test(ui));
}

/* ═══ C — scope is account-level and declared ═══ */
console.log('\nPART C — account scope, stated rather than faked\n');
{
  const sc = DP.scopeNote();
  ck('C1  the scope is declared account-level', sc.level === 'account');
  ck('C2  ...and explained', /not against one shop/i.test(sc.note), sc.note);

  /* The list payload must not carry a shopId: the server does not filter by it. */
  const calls = [];
  await DP.listDisputes({ callList: async (p) => { calls.push(p); return { data: { disputes: [OPEN] } } } });
  ck('C3  the list call sends NO shopId', calls[0] && calls[0].shopId === undefined, JSON.stringify(calls[0]));

  const layer = CODE('sokoni-merchant-disputes.js');
  ck('C4  the layer never filters disputes by a shop', !/activeShopId|shopId ===/.test(layer));
}

/* ═══ D — payloads ═══ */
console.log('\nPART D — what the server is asked to do\n');
{
  const r = DP.buildResponse({ disputeId: 'dp_o1', response: 'The order was collected and signed for.' });
  ck('D1  a response carries the dispute and the text', r.disputeId === 'dp_o1' && /collected/.test(r.response));

  const e = DP.buildEvidence({ disputeId: 'dp_o1', evidenceType: 'proof_of_delivery',
    description: 'Signed note from the rider', fileUrl: 'https://x/y.jpg' });
  ck('D2  evidence carries type, description and file', e.evidenceType === 'proof_of_delivery' && !!e.fileUrl);

  const noFile = DP.buildEvidence({ disputeId: 'dp_o1', evidenceType: 'photo', description: 'Item as sent' });
  ck('D3  a missing attachment is OMITTED, not sent empty', noFile.fileUrl === undefined, JSON.stringify(noFile));

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('D4  an empty response is refused', bad(() => DP.buildResponse({ disputeId: 'd', response: '   ' })));
  ck('D5  a one-word response is refused', bad(() => DP.buildResponse({ disputeId: 'd', response: 'no' })));
  ck('D6  evidence with no type is refused', bad(() => DP.buildEvidence({ disputeId: 'd', description: 'x y z' })));
  ck('D7  evidence with no description is refused', bad(() => DP.buildEvidence({ disputeId: 'd', evidenceType: 'photo' })));
  ck('D8  a missing disputeId is refused', bad(() => DP.buildResponse({ response: 'a full sentence here' })));
}

/* ═══ E — the authority decides ═══ */
console.log('\nPART E — failure is failure\n');
{
  const listed = await DP.listDisputes({ callList: async () => ({ data: { disputes: [RESOLVED, OPEN] } }) });
  ck('E1  the list loads', listed.ok && listed.count === 2);
  ck('E2  open disputes sort FIRST — they are the ones with a clock on them',
    listed.disputes[0].status === 'open', listed.disputes.map((d) => d.status).join(','));
  ck('E3  the open count is reported', listed.openCount === 1);

  const denied = await DP.respond({ disputeId: 'dp_x', response: 'a full sentence of response',
    callRespond: async () => { const e = new Error('Not the seller'); e.code = 'permission-denied'; throw e; } });
  ck('E4  a refusal carries the server\'s words', denied.ok === false && /Not the seller/.test(denied.error));
  ck('E5  ...and the code', denied.code === 'permission-denied');

  const closed = await DP.addEvidence({ disputeId: 'dp_x', evidenceType: 'photo', description: 'a photo',
    callEvidence: async () => { const e = new Error('Dispute is no longer open'); e.code = 'failed-precondition'; throw e; } });
  ck('E6  a closed dispute refusal is surfaced', closed.ok === false && /no longer open/.test(closed.error));

  const down = await DP.listDisputes({ callList: async () => { throw new Error('offline'); } });
  ck('E7  a failed read is a failure, not an empty list', down.ok === false && down.disputes === undefined);
}

/* ═══ F — money and unknowns ═══ */
console.log('\nPART F — no invented figures\n');
{
  ck('F1  an unknown amount is a dash', DP.formatKES(null) === '—');
  ck('F2  a real zero is zero', DP.formatKES(0) === 'KES 0');
  ck('F3  a value formats as currency', /^KES\s?2[,  ]?400$/.test(DP.formatKES(2400)), DP.formatKES(2400));
  const p = DP.projectDispute({ id: 'x', status: 'open' });
  ck('F4  a dispute with no amount projects null, not 0', p.amount === null);
  ck('F5  missing evidence projects as an empty list, not undefined', Array.isArray(p.evidence));
}

/* ═══ G — merchant-path invariants and routing ═══ */
console.log('\nPART G — nothing local, nothing removed\n');
{
  const layer = CODE('sokoni-merchant-disputes.js');
  const ui = CODE('sokoni-merchant-disputes-ui.js');
  ck('G1  no localStorage in either module', !/localStorage/.test(layer + ui));
  ck('G2  no Firestore access at all',
    !/\b(deleteDoc|setDoc|updateDoc|addDoc|writeBatch|collection\()/.test(layer + ui));
  ck('G3  no inline on* handler built from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(layer + ui));

  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('G4  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('G5  Disputes is a NATIVE route', C.get('disputes').kind === 'native');
  ck('G6  ...so no seller.html iframe is required', !C.get('disputes').sec && !C.get('disputes').src);

  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings','marketing'];
  ck('G7  every merchant destination is still present',
    EXPECTED.every((id) => !!C.get(id)), EXPECTED.filter((id) => !C.get(id)).join(','));
  ck('G8  POS, Sell, Inventory, Staff and Marketing are untouched',
    C.get('pos').kind === 'pos' && C.get('sell').kind === 'native' && C.get('inventory').kind === 'native' &&
    C.get('staff').kind === 'native' && C.get('marketing').kind === 'native');

  const shell = SRC('merchant.html');
  ck('G9  the shell loads both new modules',
    /sokoni-merchant-disputes\.js/.test(shell) && /sokoni-merchant-disputes-ui\.js/.test(shell));
  ck('G10 the shell has a renderer for Disputes', /id === 'disputes'\) renderDisputes\(\)/.test(shell));
  ck('G11 the shell binds only the four party-scoped authorities',
    /callList:\s*_callable\('getSellerDisputes'\)/.test(shell) &&
    /callRespond:\s*_callable\('sellerRespondToDispute'\)/.test(shell) &&
    /callEvidence:\s*_callable\('addDisputeEvidence'\)/.test(shell));
}

/* ═══ H — the server contract this layer mirrors ═══ */
console.log('\nPART H — the layer agrees with the server\n');
{
  const fn = SRC('functions/disputes.js');
  /* The server's list lives in functions/dispute-hold.js (Repair 1: settlement and disputes must never
     disagree about what "open" means). Compared against the LOADED server value, not a source literal,
     and disputes.js must take its list from there — one list on the server, mirrored exactly here. */
  const SERVER_OPEN = require(require('path').join(__dirname, '..', 'functions', 'dispute-hold.js')).OPEN_STATUSES;
  ck('H1  OPEN_STATUSES matches the server exactly',
    /const OPEN_STATUSES = DH\.OPEN_STATUSES;/.test(fn) &&
    DP.OPEN_STATUSES.join(',') === SERVER_OPEN.join(',') &&
    SERVER_OPEN.join(',') === 'open,investigating,seller_responded');
  ck('H2  sellerRespondToDispute really is seller-only', /data\.sellerId !== uid/.test(fn));
  ck('H3  createDispute really is buyer-only', /if \(!isBuyer\)/.test(fn));
  ck('H4  cancelDispute really is buyer-only', /data\.buyerId !== uid/.test(fn));
  ck('H5  resolution really is admin-gated',
    /exports\.adminResolveDispute[\s\S]{0,240}_ac\.isAdmin/.test(fn));
  ck('H6  a response sets seller_responded, NOT resolved',
    /status:\s*'seller_responded'/.test(fn) && !/exports\.sellerRespondToDispute[\s\S]{0,700}status:\s*'resolved'/.test(fn));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
