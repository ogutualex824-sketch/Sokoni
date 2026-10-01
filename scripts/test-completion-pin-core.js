'use strict';
/* The product completion PIN engine (functions/shared/completion-pin.js) — owner rules 2026-10-01:
   48 h server-side TTL · max 5 sends · no silent replacement · atomic lockout · 6 digits · plaintext never persisted ·
   one-shot. In-memory Firestore whose transactions are SERIALISED (as Firestore's contention resolves them).
     node scripts/test-completion-pin-core.js */
const path = require('path');
const P = require(path.join(__dirname, '..', 'functions', 'shared', 'completion-pin.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

const DOCS = new Map();
const DEL = { __del: 1 }, TS = 'TS';
const FV = { serverTimestamp: () => TS, delete: () => DEL };
const apply = (prev, d, merge) => { const o = merge ? Object.assign({}, prev || {}) : {}; for (const [k, v] of Object.entries(d)) { if (v === DEL) delete o[k]; else o[k] = v; } return o; };
const ref = (p) => ({ path: p, get: async () => ({ exists: DOCS.has(p), data: () => DOCS.get(p) }),
  set: async (d, o) => { DOCS.set(p, apply(DOCS.get(p), d, o && o.merge)); } });
let chain = Promise.resolve();
const db = { collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  runTransaction: (fn) => { const run = chain.then(async () => { const w = [];
    const t = { get: async (r) => ({ exists: DOCS.has(r.path), data: () => DOCS.get(r.path) }),
      set: (r, d, o) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, o && o.merge))),
      update: (r, d) => w.push(() => DOCS.set(r.path, apply(DOCS.get(r.path), d, true))) };
    const out = await fn(t); w.forEach((f) => f()); return out; });
    chain = run.catch(() => {}); return run; } };
const KEY = 'test-hmac-key-0123456789';
const T0 = 1_800_000_000_000;
const paidOrder = (id, o) => DOCS.set('orders/' + id, Object.assign({ status: 'paid', paymentVerified: true, fulfillmentType: 'delivery',
  buyerUid: 'b1', sellerUid: 's1', deliveryAddress: 'Kilimani' }, o));
const dump = () => JSON.stringify([...DOCS.entries()]);

(async () => {
  console.log('\nCompletion PIN engine\n');
  /* generation */
  const pins = new Set(); for (let i = 0; i < 2000; i++) pins.add(P.newPin());
  ck('G-1', [...pins].every(P.isPinShape) && pins.size > 1900, '6-digit PINs from a CSPRNG (2000 draws, no shape violations)', pins.size);
  ck('G-2', !/Math\.random/.test(require('fs').readFileSync(require.resolve(path.join(__dirname, '..', 'functions', 'shared', 'completion-pin.js')), 'utf8')), 'the engine never uses Math.random');
  ck('G-3', !P.isPinShape('1234') && !P.isPinShape('12345678') && !P.isPinShape('12a456') && P.isPinShape('012345'), 'ONLY exactly 6 digits is a PIN (4-digit and 8-digit refused)');

  /* auto issue at payment */
  paidOrder('o1');
  let r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'auto', now: T0 });
  const o1 = DOCS.get('orders/o1'), p1 = DOCS.get('deliveryPins/o1');
  ck('I-1', r.ok && r.action === 'issued' && r.version === 1 && P.isPinShape(r.pin) && o1.deliveryPinExpiresAt === T0 + 48 * 3600e3 && o1.deliveryPinEngine === 2,
    'a PAID delivery order gets a PIN with a 48 h server-side expiry', { r: Object.assign({}, r, { pin: '…' }), exp: o1.deliveryPinExpiresAt });
  ck('I-2', !dump().includes('"' + r.pin + '"') && p1.sealed && !('pin' in p1) && o1.deliveryPinHash === P.hashPin(KEY, 'o1', r.pin),
    'the PLAINTEXT is persisted NOWHERE: the order holds the HMAC, deliveryPins holds the PIN sealed');
  ck('I-3', P.openPin(KEY, 'o1', 1, p1.sealed) === r.pin && P.openPin(KEY, 'o2', 1, p1.sealed) === null && P.openPin(KEY, 'o1', 2, p1.sealed) === null && P.openPin('other-key', 'o1', 1, p1.sealed) === null,
    'the seal opens only for this order + version + key (bound, tamper-evident)');
  const pin1 = r.pin;
  r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'auto', now: T0 + 5 });
  ck('I-4', r.ok && r.action === 'none' && DOCS.get('orders/o1').deliveryPinHash === o1.deliveryPinHash, 'auto issue is idempotent — a PIN the buyer may hold is never replaced');
  for (const [id, o, why] of [['u1', { paymentVerified: false }, 'ORDER_NOT_PAID'], ['c1', { status: 'cancelled' }, 'ORDER_NOT_ELIGIBLE'],
    ['rf1', { status: 'refunded' }, 'ORDER_NOT_ELIGIBLE'], ['d1', { status: 'completed' }, 'ALREADY_COMPLETED'],
    ['pk1', { fulfillmentType: 'pickup', deliveryAddress: null }, 'ORDER_NOT_ELIGIBLE']]) { paidOrder(id, o);
    const x = await P.issueOrResend({ db, FV, key: KEY, orderId: id, mode: 'auto', now: T0 });
    ck('I-5:' + id, !x.ok && x.reason === why && !DOCS.get('orders/' + id).deliveryPinHash, 'no PIN for a ' + why.toLowerCase() + ' order', x); }

  /* send requests: same PIN within the window, limits, reissue after expiry */
  r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'request', actorUid: 's1', now: T0 + 30e3 });
  ck('S-1', !r.ok && r.reason === 'PIN_RATE_LIMITED', 'a send request < 60 s after the last send is RATE_LIMITED', r);
  const [a, b] = await Promise.all([P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'request', actorUid: 's1', now: T0 + 120e3 }),
                                    P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'request', actorUid: 's1', now: T0 + 120e3 })]);
  ck('S-2', a.ok && a.action === 'resend' && a.pin === pin1 && !b.ok && b.reason === 'PIN_RATE_LIMITED' && DOCS.get('orders/o1').deliveryPinHash === o1.deliveryPinHash,
    'two seller taps → the SAME live PIN is re-sent once (one active PIN), the second tap is rate-limited', { a: a.action, b: b.reason });
  let sends = DOCS.get('orders/o1').deliveryPinSends, t = T0 + 120e3, last;
  while (sends < 5) { t += 61e3; last = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'request', now: t }); sends = DOCS.get('orders/o1').deliveryPinSends; }
  r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o1', mode: 'request', now: t + 61e3 });
  ck('S-3', sends === 5 && !r.ok && r.reason === 'PIN_RATE_LIMITED', 'the 6th send request is refused (max five, counted server-side)', { sends, r });
  paidOrder('o2'); await P.issueOrResend({ db, FV, key: KEY, orderId: 'o2', mode: 'auto', now: T0 });
  const pinOld = P.openPin(KEY, 'o2', 1, DOCS.get('deliveryPins/o2').sealed);
  const late = T0 + 49 * 3600e3;
  r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o2', mode: 'request', actorUid: 's1', now: late });
  ck('S-4', r.ok && r.action === 'issued' && r.version === 2 && r.pin !== pinOld && DOCS.get('orders/o2').deliveryPinExpiresAt === late + 48 * 3600e3,
    'EXPIRED PIN ≠ expired order: a send request after 48 h issues a NEW PIN (version 2, fresh 48 h)', r.action);
  let v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o2', pin: pinOld, now: late + 1 });
  const v2 = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o2', pin: r.pin, now: late + 2 });
  ck('S-5', !v.ok && v.reason === 'PIN_INVALID' && v2.ok, 'the OLD PIN is dead the moment the new one exists; the new one verifies', { v, v2 });

  /* verification: expiry, lockout (atomic), lapse, used */
  paidOrder('o3'); await P.issueOrResend({ db, FV, key: KEY, orderId: 'o3', mode: 'auto', now: T0 });
  const pin3 = P.openPin(KEY, 'o3', 1, DOCS.get('deliveryPins/o3').sealed);
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: pin3, now: T0 + 48 * 3600e3 + 1 });
  ck('V-1', !v.ok && v.reason === 'PIN_EXPIRED' && !DOCS.get('orders/o3').deliveryVerifyAttempts, 'an EXPIRED PIN never completes (and is not counted as a guess)', v);
  const wrong = pin3 === '000000' ? '000001' : '000000';
  const burst = await Promise.all(Array.from({ length: 8 }, () => P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: wrong, now: T0 + 10 })));
  const o3 = DOCS.get('orders/o3');
  ck('V-2', o3.deliveryVerifyAttempts === 5 && burst.filter((x) => x.reason === 'PIN_LOCKED').length === 4 && o3.deliveryPinLockedUntil === T0 + 10 + 30 * 60e3,
    '8 CONCURRENT wrong guesses: exactly 5 are counted, the 5th locks, the rest are refused as LOCKED (no guess sneaks past)', { attempts: o3.deliveryVerifyAttempts, reasons: burst.map((x) => x.reason) });
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: pin3, now: T0 + 20 });
  ck('V-3', !v.ok && v.reason === 'PIN_LOCKED', 'while locked even the RIGHT PIN is refused', v);
  ck('V-4', [...DOCS.keys()].some((k) => k.indexOf('pinSecurityEvents/o3_lock_') === 0), 'the lock raises a pinSecurityEvents record for AdminOS');
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: wrong, now: T0 + 31 * 60e3 });
  ck('V-5', !v.ok && v.reason === 'PIN_INVALID' && DOCS.get('orders/o3').deliveryVerifyAttempts === 1, 'after the lock lapses the counter starts again (temporary lock)', DOCS.get('orders/o3').deliveryVerifyAttempts);
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: pin3, now: T0 + 32 * 60e3 });
  ck('V-6', v.ok, 'then the right PIN verifies', v);
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: '1234', now: T0 + 32 * 60e3 });
  ck('V-7', !v.ok && v.reason === 'PIN_INVALID' && v.counted === false, 'a 4-digit entry is refused as malformed (6 digits only)', v);
  DOCS.set('orders/o3', Object.assign(DOCS.get('orders/o3'), { status: 'delivered', deliveryPinStatus: 'USED' }));
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o3', pin: pin3, now: T0 + 33 * 60e3 });
  ck('V-8', !v.ok && v.reason === 'ALREADY_COMPLETED', 'a USED PIN is refused (one-shot)', v);
  paidOrder('o4', { status: 'cancelled', deliveryPinHash: 'x', deliveryPinBinding: 'order' });
  v = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o4', pin: '123456', now: T0 });
  r = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o4', mode: 'request', now: T0 });
  ck('V-9', !v.ok && v.reason === 'ORDER_NOT_ELIGIBLE' && !r.ok && r.reason === 'ORDER_NOT_ELIGIBLE', 'a cancelled order: no completion and no reissue', { v, r });

  /* legacy package-bound PINs (minted at rider accept before this engine) */
  paidOrder('o5', { deliveryPinHash: P.hashPin(KEY, 'o5', '111111'), deliveryPinBinding: 'order' });
  const pkg = { ref: 'pkg5', hash: P.hashPin(KEY, 'pkg5', '222222') };
  const l1 = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o5', pin: '222222', legacyPkg: pkg, now: T0 });
  const l2 = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o5', pin: '111111', legacyPkg: pkg, now: T0 });
  ck('L-1', l1.ok && l2.ok, 'mid-flight legacy deliveries still verify (package-bound and order-bound) — no rider stranded at a door');
  await P.issueOrResend({ db, FV, key: KEY, orderId: 'o5', mode: 'request', now: T0 + 61e3 });
  const l3 = await P.verifyAttempt({ db, FV, key: KEY, orderId: 'o5', pin: '222222', legacyPkg: pkg, now: T0 + 62e3 });
  ck('L-2', !l3.ok && DOCS.get('orders/o5').deliveryPinEngine === 2, 'once an engine PIN is issued, the legacy package-bound PIN is dead', l3);

  /* delivery: SMS recorded without the body; failure surfaces to AdminOS; WhatsApp OFF */
  const sent = [];
  const okSms = async (to, text) => { sent.push({ to, text }); return { ok: true, results: [{ messageId: 'ATX1', status: 'Success' }] }; };
  paidOrder('o6'); const i6 = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o6', mode: 'auto', now: T0 });
  const d6 = await P.deliverPin({ db, FV, orderId: 'o6', version: 1, pin: i6.pin, phone: '254700000001', sendSms: okSms, now: T0 });
  const logs6 = [...DOCS.entries()].filter(([k]) => k.indexOf('deliveryPinLog/o6') === 0).map(([, v]) => v);
  ck('D-1', d6.ok && sent.length === 1 && sent[0].text.includes(i6.pin) && /PIN YAKO NI PRODUCT YAKO/.test(sent[0].text) && DOCS.get('orders/o6').deliveryPinDelivery === 'SENT',
    'the buyer gets ONE SMS with the PIN and the safety line', sent[0] && sent[0].text.replace(i6.pin, '••••••'));
  ck('D-2', logs6.some((l) => l.channel === 'sms' && l.messageId === 'ATX1' && l.status === 'SENT') && logs6.some((l) => l.channel === 'whatsapp' && l.status === 'NOT_CONFIGURED') && !dump().includes(i6.pin),
    'channel / provider / messageId / status recorded; WhatsApp logged NOT_CONFIGURED; the PIN is in NO stored record', logs6);
  paidOrder('o7'); const i7 = await P.issueOrResend({ db, FV, key: KEY, orderId: 'o7', mode: 'auto', now: T0 });
  const d7 = await P.deliverPin({ db, FV, orderId: 'o7', version: 1, pin: i7.pin, phone: '254700000002', sendSms: async () => ({ ok: false, status: 401 }), now: T0 });
  ck('D-3', !d7.ok && DOCS.get('orders/o7').deliveryPinDelivery === 'FAILED' && DOCS.get('pinDeliveryFailures/o7_v1').status === 'open' && DOCS.get('orders/o7').status === 'paid',
    'SMS failure → PIN DELIVERY FAILED for AdminOS/Support; the order is NOT marked delivered', DOCS.get('pinDeliveryFailures/o7_v1'));
  const d8 = await P.deliverPin({ db, FV, orderId: 'o7', version: 1, pin: i7.pin, phone: null, sendSms: okSms, now: T0 + 1 });
  ck('D-4', !d8.ok && DOCS.get('pinDeliveryFailures/o7_v1').reason === 'no_buyer_phone', 'no buyer phone → recorded as a delivery failure, never silently dropped');

  /* masked views */
  const mv = P.maskedView(DOCS.get('orders/o6'), T0 + 1);
  ck('M-1', mv.masked === '••••••' && mv.state === 'DELIVERED' && mv.maxSends === 5 && !JSON.stringify(mv).includes(i6.pin) && !JSON.stringify(mv).includes(DOCS.get('orders/o6').deliveryPinHash),
    'the masked view (buyer card / AdminOS) carries state, expiry, sends, attempts — never the PIN or its hash', mv);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
