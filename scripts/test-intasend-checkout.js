/* shared/intasend-checkout.js — the one hosted-checkout client.

   WHAT THESE PROVE

   This module is NOT field-verified: no SOKONI code has ever successfully
   created an IntaSend checkout session. So these tests deliberately do not
   claim the endpoint works. They pin the things that are knowable without the
   network, and that would silently break money if they regressed:

     1. the request carries the PUBLIC key and NEVER the private key
     2. omitting `method` is preserved, because that omission IS the
        multi-method feature
     3. a non-answer THROWS rather than being recorded as a refusal
     4. unknown capability reads as UNKNOWN, never as an empty list

   The https layer is injected, exactly as stk-gateway's tests do it, so every
   byte on the wire can be asserted without touching IntaSend.
*/
'use strict';
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};

const C = require(path.join(__dirname, '..', 'functions', 'shared', 'intasend-checkout'));

const PUB  = 'ISPubKey_test_abc';
const PRIV = 'ISSecretKey_test_MUST_NEVER_APPEAR';

/* ── Injected https ──────────────────────────────────────────────────────── */
function mockHttps({ status = 200, body = '{"url":"https://payment.intasend.com/isl/ABC","invoice":{"invoice_id":"INV1"}}', socketError = null }) {
  const captured = { options: null, written: '' };
  return {
    captured,
    request(options, cb) {
      captured.options = options;
      const req = new EventEmitter();
      req.write = (d) => { captured.written += d; };
      req.end = () => {
        if (socketError) { setImmediate(() => req.emit('error', new Error(socketError))); return; }
        const res = new EventEmitter();
        res.statusCode = status;
        setImmediate(() => { if (body) res.emit('data', body); res.emit('end'); });
        cb(res);
      };
      return req;
    },
  };
}

(async () => {

  /* ══ buildPayload ═══════════════════════════════════════════════════════ */
  console.log('\n── buildPayload: the legitimate call MUST succeed ──');
  {
    const p = JSON.parse(C.buildPayload({
      amountKES: 4850, apiRef: 'SKN123', publicKey: PUB, narrative: 'KASS SHOP',
    }));
    ck('a minimal valid payload builds', !!p);
    ck('amount is carried as a number', p.amount === 4850, p.amount);
    ck('api_ref is carried', p.api_ref === 'SKN123');
    ck('public_key is in the body', p.public_key === PUB);
    ck('currency defaults to KES', p.currency === 'KES');
  }

  console.log('\n── buildPayload: omitting `method` is PRESERVED ──');
  {
    const p = JSON.parse(C.buildPayload({ amountKES: 100, apiRef: 'R1', publicKey: PUB }));
    ck('no method field is emitted when none is given',
       !Object.prototype.hasOwnProperty.call(p, 'method'), JSON.stringify(Object.keys(p)));
    /* Inverting control: if the builder ignored `method` entirely, the absence
       above would pass for the wrong reason. */
    const q = JSON.parse(C.buildPayload({ amountKES: 100, apiRef: 'R1', publicKey: PUB, method: 'CARD-PAYMENT' }));
    ck('a named method IS emitted when given', q.method === 'CARD-PAYMENT', q.method);
  }

  console.log('\n── buildPayload: refusals ──');
  const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('a missing publicKey is refused',
     throws(() => C.buildPayload({ amountKES: 1, apiRef: 'R' })));
  ck('a missing apiRef is refused',
     throws(() => C.buildPayload({ amountKES: 1, publicKey: PUB })));
  ck('a zero amount is refused',
     throws(() => C.buildPayload({ amountKES: 0, apiRef: 'R', publicKey: PUB })));
  ck('a negative amount is refused',
     throws(() => C.buildPayload({ amountKES: -5, apiRef: 'R', publicKey: PUB })));
  ck('a non-numeric amount is refused',
     throws(() => C.buildPayload({ amountKES: 'lots', apiRef: 'R', publicKey: PUB })));
  ck('an unknown method is refused before the wire',
     throws(() => C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB, method: 'CRYPTO-VIBES' })));
  ck('and a KNOWN method is not refused (guard is not refuse-all)',
     !throws(() => C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB, method: 'M-PESA' })));

  console.log('\n── buildPayload: empty optionals are omitted, not sent blank ──');
  {
    const p = JSON.parse(C.buildPayload({
      amountKES: 1, apiRef: 'R', publicKey: PUB,
      email: '', phone: '', narrative: '', redirectUrl: '', walletId: '',
    }));
    ck('blank email is omitted', !('email' in p));
    ck('blank phone is omitted', !('phone_number' in p));
    ck('blank narrative is omitted', !('narrative' in p));
    ck('blank wallet_id is omitted', !('wallet_id' in p));
  }

  console.log('\n── buildPayload: tariff uses IntaSend\'s spelling ──');
  {
    const p = JSON.parse(C.buildPayload({
      amountKES: 1, apiRef: 'R', publicKey: PUB,
      cardTariff: C.TARIFF.BUSINESS_PAYS, mobileTariff: C.TARIFF.CUSTOMER_PAYS,
    }));
    ck('card_tarrif (sic) is emitted', p.card_tarrif === 'BUSINESS-PAYS', p.card_tarrif);
    ck('mobile_tarrif (sic) is emitted', p.mobile_tarrif === 'CUSTOMER-PAYS', p.mobile_tarrif);
    ck('the correctly-spelled key is NOT emitted', !('card_tariff' in p));
  }

  /* ══ createCheckout — the wire ══════════════════════════════════════════ */
  console.log('\n── createCheckout: the PRIVATE KEY NEVER LEAVES ──');
  {
    const h = mockHttps({});
    const payload = C.buildPayload({ amountKES: 4850, apiRef: 'SKN9', publicKey: PUB });
    await C.createCheckout({ payload, publicKey: PUB, privateKey: PRIV, sandbox: false, https: h });

    const hdrs = JSON.stringify(h.captured.options.headers);
    ck('no Authorization header is sent', !/authorization/i.test(hdrs), hdrs.slice(0, 60));
    ck('the private key is absent from the headers', !hdrs.includes(PRIV));
    ck('the private key is absent from the body', !h.captured.written.includes(PRIV));
    ck('the PUBLIC key IS sent as a header',
       h.captured.options.headers['INTASEND_PUBLIC_API_KEY'] === PUB);
    /* Positive control: the assertions above would also pass if nothing at all
       were sent. Prove the request actually carried the order. */
    ck('the body actually carried the payload', h.captured.written.includes('SKN9'));
  }

  console.log('\n── createCheckout: host and path ──');
  {
    const h = mockHttps({});
    await C.createCheckout({
      payload: C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB }),
      publicKey: PUB, sandbox: false, https: h,
    });
    ck('live host', h.captured.options.hostname === 'payment.intasend.com', h.captured.options.hostname);
    ck('path is /api/v1/checkout/', h.captured.options.path === '/api/v1/checkout/', h.captured.options.path);
    ck('method is POST', h.captured.options.method === 'POST');
  }
  {
    const h = mockHttps({});
    await C.createCheckout({
      payload: C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB }),
      publicKey: PUB, sandbox: true, https: h,
    });
    ck('sandbox host', h.captured.options.hostname === 'sandbox.intasend.com', h.captured.options.hostname);
  }

  console.log('\n── createCheckout: a NON-ANSWER throws, it is not a refusal ──');
  {
    let threw = false;
    try {
      await C.createCheckout({
        payload: C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB }),
        publicKey: PUB, sandbox: false, https: mockHttps({ socketError: 'ECONNRESET' }),
      });
    } catch (_) { threw = true; }
    ck('a socket error rejects', threw);
  }
  {
    let threw = false;
    try {
      await C.createCheckout({
        payload: C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB }),
        publicKey: PUB, sandbox: false, https: mockHttps({ status: 200, body: '<html>502</html>' }),
      });
    } catch (_) { threw = true; }
    ck('a non-JSON body rejects rather than resolving empty', threw);
  }
  {
    const r = await C.createCheckout({
      payload: C.buildPayload({ amountKES: 1, apiRef: 'R', publicKey: PUB }),
      publicKey: PUB, sandbox: false, https: mockHttps({ status: 400, body: '{"amount":["required"]}' }),
    });
    ck('a 4xx RESOLVES (it is an answer) rather than throwing', r.status === 400, r.status);
  }

  /* ══ classifyOutcome ════════════════════════════════════════════════════ */
  console.log('\n── classifyOutcome matches stk-gateway exactly ──');
  {
    const gw = require(path.join(__dirname, '..', 'functions', 'shared', 'stk-gateway'));
    const codes = [200, 201, 400, 401, 404, 409, 500, 502, 503, 0];
    const same = codes.every((c) => C.classifyOutcome(c) === gw.classifyOutcome(c));
    ck('both rails agree on every status code', same,
       codes.map((c) => c + ':' + C.classifyOutcome(c)).join(' '));
    ck('5xx is OUTCOME_UNKNOWN, never REJECTED', C.classifyOutcome(503) === 'OUTCOME_UNKNOWN');
    ck('201 is ACCEPTED', C.classifyOutcome(201) === 'GATEWAY_ACCEPTED');
  }

  /* ══ Response readers ═══════════════════════════════════════════════════ */
  console.log('\n── checkoutUrlOf / invoiceIdOf tolerate IntaSend\'s spellings ──');
  ck('url', C.checkoutUrlOf({ url: 'A' }) === 'A');
  ck('checkout_url', C.checkoutUrlOf({ checkout_url: 'B' }) === 'B');
  ck('invoice.url', C.checkoutUrlOf({ invoice: { url: 'C' } }) === 'C');
  ck('absent url reads null, not undefined-ish', C.checkoutUrlOf({}) === null);
  ck('invoice.invoice_id', C.invoiceIdOf({ invoice: { invoice_id: 'I1' } }) === 'I1');
  ck('top-level id', C.invoiceIdOf({ id: 'I2' }) === 'I2');
  ck('absent invoice id reads null', C.invoiceIdOf({}) === null);

  console.log('\n── methodsOf: UNKNOWN is not the same as NONE ──');
  ck('a response that does not say reads null', C.methodsOf({ url: 'x' }) === null);
  ck('an empty array also reads null, never []',
     C.methodsOf({ available_methods: [] }) === null,
     JSON.stringify(C.methodsOf({ available_methods: [] })));
  ck('a populated list is returned',
     JSON.stringify(C.methodsOf({ available_methods: ['M-PESA', 'CARD-PAYMENT'] }))
       === '["M-PESA","CARD-PAYMENT"]');
  ck('objects with a name are flattened',
     JSON.stringify(C.methodsOf({ methods: [{ name: 'M-PESA' }] })) === '["M-PESA"]');

  /* ══ The capability list is not a capability claim ══════════════════════ */
  console.log('\n── CANDIDATE_METHODS is a probe list, not an enabled list ──');
  ck('it is frozen', Object.isFrozen(C.CANDIDATE_METHODS));
  ck('it contains CARD-PAYMENT as a CANDIDATE', C.CANDIDATE_METHODS.includes('CARD-PAYMENT'));
  ck('nothing in this module reports methods as enabled',
     typeof C.enabledMethods === 'undefined' && typeof C.isCardEnabled === 'undefined');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n  HARNESS CRASHED — this is a FAILURE, not a refusal:\n', e);
  process.exit(2);
});
