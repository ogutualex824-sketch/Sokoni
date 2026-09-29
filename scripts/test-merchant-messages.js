#!/usr/bin/env node
/* Merchant Messages — the client layer and the authority boundary (2D-2 step 5).
 *
 *   node scripts/test-merchant-messages.js
 *
 * The properties this suite holds:
 *
 *   1. Every MUTATION is an op on messagesDispatch. The surface performs no
 *      Firestore write of any kind; its single Firestore access is a READ of a
 *      thread's messages, which rules gate on participation and whose client
 *      creates are blocked outright.
 *   2. Participation is the server's to decide, and the server decides it on
 *      every op — this layer never filters for security, only for display.
 *   3. `localStorage.sokoniMessages` is not carried over in any form.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const MM = require(path.join(ROOT, 'sokoni-merchant-messages.js'));

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

(async () => {

/* ═══ A — one server boundary ═══ */
console.log('\nPART A — every mutation is an op on the router\n');
{
  const calls = [];
  const dispatch = async (p) => { calls.push(p); return { data: { items: [], ok: true } }; };

  await MM.listThreads({ dispatch, query: 'ann' });
  ck('A1  the inbox is an op', calls[0].op === 'searchConversations');
  ck('A2  ...carrying the search text', calls[0].query === 'ann');

  await MM.send({ conversationId: 'c1', text: 'On its way', dispatch });
  ck('A3  sending is an op', calls[1].op === 'sendMessage' && calls[1].conversationId === 'c1');
  ck('A4  ...as type text', calls[1].type === 'text' && calls[1].text === 'On its way');

  await MM.markRead({ conversationId: 'c1', dispatch });
  ck('A5  marking read is an op', calls[2].op === 'markRead' && calls[2].conversationId === 'c1');

  await MM.getContext({ conversationId: 'c1', dispatch });
  ck('A6  reading context is an op', calls[3].op === 'getConversationContext');

  /* 2026-09-29 (T2a): + productQuestionAnswer — publishes the public answer to a product question; the server
     refuses anyone but that product's seller (NOT_SELLER, test-product-conversations PC5). Still no admin op. */
  ck('A7  the layer names ONLY participant-scoped ops',
    Object.values(MM.OPS).sort().join(',') ===
    'getConversationContext,markRead,productQuestionAnswer,reportConversation,searchConversations,sendMessage',
    Object.values(MM.OPS).join(','));

  /* The router also exposes four superAdmin ops. A merchant surface must not
     name them, even though naming one would be refused server-side. */
  const ADMIN_OPS = ['adminGetReports', 'adminReviewReport', 'adminUpdateChatPolicy', 'adminGetChatStats'];
  const merchantPath = CODE('merchant.html') + CODE('sokoni-merchant-messages.js') + CODE('sokoni-merchant-messages-ui.js');
  ck('A8  no admin op is named anywhere in the merchant path',
    !ADMIN_OPS.some((o) => new RegExp("['\"]" + o + "['\"]").test(merchantPath)));
}

/* ═══ B — the one Firestore access is a READ ═══ */
console.log('\nPART B — reads only, and the rules make writes impossible\n');
{
  const q = MM.messagesQuery('conv_1', 50);
  ck('B1  the thread query is a path array, never a spliced string',
    Array.isArray(q.path) && q.path.join('/') === 'conversations/conv_1/messages', JSON.stringify(q.path));
  ck('B2  ...ordered oldest-first, as a conversation reads',
    q.orderBy[0] === 'timestamp' && q.orderBy[1] === 'asc');
  ck('B3  ...and bounded', q.limit === 50);

  let threw = false;
  try { MM.messagesQuery(null); } catch (_) { threw = true; }
  ck('B4  no conversation id means no query', threw);

  const layer = CODE('sokoni-merchant-messages.js');
  const ui = CODE('sokoni-merchant-messages-ui.js');
  ck('B5  neither module invokes a Firestore write',
    !/\b(deleteDoc|setDoc|updateDoc|addDoc|writeBatch|runTransaction)\s*\(/.test(layer + ui));
  ck('B6  neither module builds a collection reference itself',
    !/\bcollection\s*\(/.test(layer + ui));

  /* The rule that makes this safe, asserted against the shipped ruleset. */
  const rules = SRC('firestore.rules');
  const msgBlock = rules.slice(rules.indexOf('match /conversations/{convId}'),
    rules.indexOf('match /conversations/{convId}') + 1400);
  ck('B7  rules gate the message READ on participation', /allow read: if inConvo\(\)/.test(msgBlock));
  ck('B8  rules block client message CREATES outright', /allow create: if false/.test(msgBlock));

  const denied = await MM.loadMessages({ conversationId: 'c1',
    db: { queryMessages: async () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } } });
  ck('B9  a rules refusal is reported, not rendered as an empty conversation',
    denied.ok === false && denied.messages === undefined && /permissions/.test(denied.error));
}

/* ═══ C — participation is the server's to decide ═══ */
console.log('\nPART C — the layer never decides access\n');
{
  const layer = CODE('sokoni-merchant-messages.js');
  ck('C1  the layer contains no participant check of its own',
    !/participants/.test(layer), 'a client-side participant filter would be security theatre');

  /* Every refusal shape the server can return must surface as a refusal. */
  const shapes = [
    ['not a participant', { code: 'permission-denied', message: 'Not a participant' }],
    ['deactivated account', { code: 'permission-denied', message: 'Your account is deactivated.' }],
    ['unknown conversation', { code: 'not-found', message: 'Conversation not found' }],
  ];
  for (const [label, e] of shapes) {
    const err = Object.assign(new Error(e.message), { code: e.code });
    const r = await MM.send({ conversationId: 'x', text: 'hello there', dispatch: async () => { throw err; } });
    ck('C2-' + label + ' is surfaced verbatim, with its code',
      r.ok === false && r.error === e.message && r.code === e.code);
  }

  /* The server checks participation on markRead and updateConversationStatus —
     asserted against the shipped source, since this layer cannot. */
  const fn = SRC('functions/messages.js');
  ck('C3  markRead is participant-checked server-side',
    /exports\.markRead[\s\S]{0,600}participants\.includes\(uid\)/.test(fn));
  ck('C4  updateConversationStatus is participant-checked server-side',
    /exports\.updateConversationStatus[\s\S]{0,1200}participants\.includes\(req\.auth\.uid\)/.test(fn));
  ck('C5  sendMessage is participant-checked server-side',
    /exports\.sendMessage[\s\S]{0,3000}participants\.includes\(req\.auth\.uid\)/.test(fn));
  ck('C6  getConversationContext is participant-checked server-side',
    /exports\.getConversationContext[\s\S]{0,600}participants\.includes\(uid\)/.test(fn));
  /* createConversation cannot be used to join an existing thread: the caller must
     be in the participant list it supplies, and a conversation is created, never
     joined. */
  ck('C7  createConversation refuses a caller absent from its own participant list',
    /participantUids\.includes\(uid\)[\s\S]{0,160}Caller must be listed as a participant/.test(fn));
  ck('C8  the inbox is a per-account projection, so it cannot return another user\'s threads',
    /collection\('userConversations'\)\.doc\(uid\)/.test(fn));
  /* And the four admin ops on the same router are gated. */
  ck('C9  every admin op on the router is superAdmin-gated',
    ['adminGetReports', 'adminReviewReport', 'adminUpdateChatPolicy', 'adminGetChatStats']
      .every((n) => new RegExp('exports\\.' + n + '[\\s\\S]{0,400}superAdmin').test(fn)));
}

/* ═══ D — payloads and display ═══ */
console.log('\nPART D — what is sent, and what is shown\n');
{
  const m = MM.buildMessage({ conversationId: 'c1', text: '  On its way  ' });
  ck('D1  the text is trimmed', m.text === 'On its way');
  ck('D2  the type is text', m.type === 'text');

  const bad = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('D3  an empty message is refused', bad(() => MM.buildMessage({ conversationId: 'c1', text: '   ' })));
  ck('D4  a message over the server cap is refused',
    bad(() => MM.buildMessage({ conversationId: 'c1', text: 'x'.repeat(MM.MAX_TEXT + 1) })));
  ck('D5  ...and the cap matches the server', MM.MAX_TEXT === 4000 &&
    /text must be ≤ 4000 characters/.test(SRC('functions/messages.js')));
  ck('D6  a missing conversation id is refused', bad(() => MM.buildMessage({ text: 'hello' })));

  const listed = await MM.listThreads({ dispatch: async () => ({ data: { items: [
    { conversationId: 'a', participantName: 'Zed', unreadCount: 0, lastMessageAt: { seconds: 300 } },
    { conversationId: 'b', participantName: 'Ann', unreadCount: 3, lastMessageAt: { seconds: 100 } },
    { conversationId: 'c', participantName: 'Bob', unreadCount: 0, lastMessageAt: { seconds: 400 } },
  ] } }) });
  ck('D7  unread threads sort FIRST', listed.threads[0].id === 'b', listed.threads.map((t) => t.id).join(','));
  ck('D8  ...then most recent', listed.threads[1].id === 'c' && listed.threads[2].id === 'a');
  ck('D9  the unread total is reported', listed.unreadTotal === 3);

  ck('D10 a zero unread count shows no badge', MM.unreadBadge(0) === null);
  ck('D11 a real count shows one', MM.unreadBadge(3) === '3');
  ck('D12 a very large count is capped for the layout', MM.unreadBadge(1200) === '99+');
  ck('D13 a missing unread count projects as 0, not unknown',
    MM.projectThread({ conversationId: 'x' }).unreadCount === 0);
}

/* ═══ E — nothing from seller.html's storage model ═══ */
console.log('\nPART E — the localStorage inbox is not carried over\n');
{
  const layer = CODE('sokoni-merchant-messages.js');
  const ui = CODE('sokoni-merchant-messages-ui.js');
  ck('E1  no localStorage in either module', !/localStorage/.test(layer + ui));
  ck('E2  no sokoniMessages key anywhere', !/sokoniMessages/.test(layer + ui));
  ck('E3  no inline on* handler built from data',
    !/\son(click|input|change|submit)\s*=\s*(\\?["'])/.test(layer + ui));

  /* seller.js still has it — recorded, not fixed here. */
  ck('E4  seller.js still carries its localStorage inbox (legacy, out of the merchant path)',
    /sokoniMessages/.test(SRC('seller.js')));
}

/* ═══ F — routing ═══ */
console.log('\nPART F — native, and nothing removed\n');
{
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  ck('F1  the route contract still validates', C.validate().length === 0, C.validate().join(' | '));
  ck('F2  Messages is a NATIVE route', C.get('messages').kind === 'native');
  ck('F3  ...so no seller.html iframe is required', !C.get('messages').sec && !C.get('messages').src);

  const EXPECTED = ['dashboard','plan','sell','products','inventory','pos','orders','analytics','revenue',
    'payments','deliveries','returns','receipts','staff','messages','disputes','settings','marketing'];
  ck('F4  every merchant destination is still present',
    EXPECTED.every((id) => !!C.get(id)), EXPECTED.filter((id) => !C.get(id)).join(','));
  ck('F5  POS, Sell, Inventory, Staff, Marketing and Disputes are untouched',
    C.get('pos').kind === 'pos' && ['sell','inventory','staff','marketing','disputes']
      .every((id) => C.get(id).kind === 'native'));

  const shell = SRC('merchant.html');
  ck('F6  the shell loads both new modules',
    /sokoni-merchant-messages\.js/.test(shell) && /sokoni-merchant-messages-ui\.js/.test(shell));
  ck('F7  the shell has a renderer for Messages', /id === 'messages'\) renderMessages\(\)/.test(shell));
  ck('F8  the shell binds the dispatcher as the ONE mutation boundary',
    /dispatch:\s*_callable\('messagesDispatch'\)/.test(shell));
  ck('F9  ...and the read adapter exposes queryMessages', /queryMessages: function/.test(shell));
}

/* ═══ G — mutation control ═══ */
console.log('\nPART G — mutation control\n');
{
  ck('G1  a client-appended bubble surviving a failed send → detected',
    !/S\.messages\.push/.test(CODE('sokoni-merchant-messages-ui.js')),
    'the surface re-reads the thread instead of appending locally');
  ck('G2  a localStorage inbox reintroduced → detected',
    /localStorage/.test('localStorage.setItem("sokoniMessages", x)'));
  ck('G3  a Firestore write reintroduced → detected',
    /\b(setDoc|addDoc)\s*\(/.test('await addDoc(ref, msg)'));
  ck('G4  an admin op named in the merchant path → detected',
    /['"]adminGetReports['"]/.test("dispatch({op:'adminGetReports'})"));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
