/* VERIFY — the payment sheet BEHAVES, not merely reads, correctly.
   ==========================================================================
   Run against a served copy:
     node <browser-automation>/browser.mjs http://127.0.0.1:8798/merchant-v2.html \
       --script scripts/browser/verify-payment-gate.mjs

   WHY THIS EXISTS ALONGSIDE test-till-payment.js
   That suite matches source patterns. Patterns with controls are worth having,
   but they cannot tell you whether the button on the glass is actually
   disabled. This drives the real module in a real DOM: it types a discount and
   reads the rendered Amount due, selects M-Pesa and reads the Complete sale
   button's disabled state, then hands the module a fake STK rail and watches
   the gate open ONLY once the server says `completed`.

   The fakes are deliberately on the OUTSIDE of the boundary being tested:
   callStk and callVerify stand in for the network, and everything they feed is
   what a server would legitimately return. Nothing inside the module is
   stubbed, so the gate under test is the real one.
========================================================================== */

function driveInPage() {
  const out = (o) => { document.body.dataset.payDiag = JSON.stringify(o); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      const M = window.SokoniMerchantSell, md = window.SokoniMerchantData;
      if (!M || !md) return out({ error: 'module absent M=' + !!M + ' md=' + !!md });
      if (!window.SokoniCash) return out({ error: 'SokoniCash absent — change would be unavailable' });

      md.listProducts = () => Promise.resolve([
        { id: 'P1', productId: 'P1', name: 'Sugar 2kg', price: 3000, stock: 50, image: '' },
      ]);

      /* The fake rail. Note what it CANNOT do: callStk returns a reference and
         nothing else — it has no way to report success, exactly like the real
         darajaSTKPush. Only callVerify can say `completed`, and it does so only
         after we flip the flag below. */
      let confirmNow = false;
      const ctx = {
        scope: { ok: true, shopId: 'rig', sellerUid: 'rig', capabilities: ['sell'] },
        db: null, shopName: 'Rig', origin: location.origin,
        onToast: () => {},
        callSale: () => Promise.resolve({ data: { saleId: 'S1', receipt: {} } }),
        callStk: () => Promise.resolve({ data: { checkoutId: 'CHK1' } }),
        callVerify: () => Promise.resolve({ data: { status: confirmNow ? 'completed' : 'pending',
                                                    mpesaCode: confirmNow ? 'SFH4X9QK21' : null } }),
      };

      let panel = document.getElementById('panel-sell');
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'panel'; panel.id = 'panel-sell';
        (document.querySelector('.main') || document.body).appendChild(panel);
      }
      panel.classList.add('show'); panel.classList.add('panel-scroll');
      panel.innerHTML = '';
      M.mount(panel, ctx);
      await sleep(1200);

      const q = (s) => panel.querySelector(s);
      const txt = () => (panel.textContent || '').replace(/\s+/g, ' ');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

      /* Ring up 3,000 and open the payment sheet. */
      const card = q('.msl-card');
      if (!card) return out({ error: 'no product card rendered' });
      card.click(); await sleep(300);
      const chargeBtn = [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /charge/i.test(b.textContent || ''));
      if (!chargeBtn) return out({ error: 'no Charge control' });
      chargeBtn.click(); await sleep(400);

      const dueOf = () => {
        /* Currency-agnostic on purpose: the formatter emits "KES", and pinning the
           probe to a symbol makes it fail on a formatting change while the figure
           it is actually checking is correct. */
        const m = txt().match(/Amount due[^0-9]*?([\d,]+)/i);
        return m ? Number(m[1].replace(/,/g, '')) : null;
      };
      const completeBtn = () => [].slice.call(panel.querySelectorAll('button'))
        .find((b) => /complete sale/i.test(b.textContent || ''));

      const dueBefore = dueOf();

      /* ── DISCOUNT ── type 200 and read the rendered ladder back. */
      const disc = q('#msl-disc');
      if (!disc) return out({ error: 'no discount field' });
      disc.value = '200'; fire(disc, 'input');
      await sleep(300);
      const dueAfter = dueOf();
      const showsDiscount = /Discount[^0-9]*200/i.test(txt());

      /* ── M-PESA ── selecting it must NOT enable Complete sale. */
      const mpesaBtn = [].slice.call(panel.querySelectorAll('[data-act="method"]'))
        .find((b) => b.getAttribute('data-m') === 'mpesa');
      if (!mpesaBtn) return out({ error: 'no M-Pesa method button' });
      mpesaBtn.click(); await sleep(300);
      const gatedOnSelect = !!(completeBtn() && completeBtn().disabled);
      const asksForPhone = !!q('#msl-phone');

      /* A push cannot be sent to nothing: the button stays disabled until the
         number is one M-Pesa could actually ring. */
      const sendBefore = [].slice.call(panel.querySelectorAll('[data-act="stk-send"]'))[0];
      const sendDisabledWithoutPhone = !!(sendBefore && sendBefore.disabled);

      const phone = q('#msl-phone');
      phone.value = '0712000111'; fire(phone, 'input');
      await sleep(300);
      const sendBtn = [].slice.call(panel.querySelectorAll('[data-act="stk-send"]'))[0];
      const canSendWithPhone = !!(sendBtn && !sendBtn.disabled);

      /* ── SEND ── the customer's phone rings. Still not paid. */
      sendBtn.click();
      await sleep(1500);
      const waitingText = /check their phone|waiting for the customer/i.test(txt());
      const gatedWhilePending = !!(completeBtn() && completeBtn().disabled);

      /* ── CONFIRM ── only now may the sale complete. */
      confirmNow = true;
      await sleep(4200);                       /* one poll interval plus slack */
      const openAfterConfirm = !!(completeBtn() && !completeBtn().disabled);
      const showsCode = /SFH4X9QK21/.test(txt());

      out({
        dueBefore, dueAfter, showsDiscount,
        gatedOnSelect, asksForPhone, sendDisabledWithoutPhone, canSendWithPhone,
        waitingText, gatedWhilePending, openAfterConfirm, showsCode,
      });
    } catch (e) { out({ error: String((e && e.stack) || e) }); }
  })();
}

export default async function run(page) {
  const rows = [];
  const ck = (label, ok, detail) => rows.push({ ok, label, detail: String(detail ?? '') });

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('http://127.0.0.1:8798/merchant-v2.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.addScriptTag({ content: `(${driveInPage.toString()})();` });
  await page.waitForFunction(() => document.body.dataset.payDiag !== undefined,
    null, { timeout: 45000, polling: 300 }).catch(() => {});
  const m = JSON.parse(await page.evaluate(() => document.body.dataset.payDiag || '{}'));

  if (m.error) {
    ck('P0 the sheet could be driven at all', false, m.error);
    return { verdict: '0/1 passed', failed: ['P0  [' + m.error + ']'] };
  }

  ck('P1 the discount changes the AMOUNT DUE on screen',
    m.dueBefore === 3000 && m.dueAfter === 2800,
    'due ' + m.dueBefore + ' → ' + m.dueAfter);
  ck('P2 the ladder shows the discount, it is not silently netted off',
    m.showsDiscount, 'a customer should see where the figure came from');

  ck('P3 selecting M-Pesa does NOT enable Complete sale',
    m.gatedOnSelect, 'this is the defect: choosing a method completed the sale');
  ck('P4 it asks for the buyer\'s number instead',
    m.asksForPhone, 'a push has to go somewhere');
  ck('P5 the push cannot be sent to an unusable number',
    m.sendDisabledWithoutPhone, 'disabled until the number is one M-Pesa could ring');
  ck('P6 CONTROL a valid number DOES enable sending',
    m.canSendWithPhone, 'if this failed, P5 would just be a permanently dead button');

  ck('P7 after sending, the till says to check the phone',
    m.waitingText, 'the cashier needs to know what to tell the customer');
  ck('P8 while pending, Complete sale is STILL disabled',
    m.gatedWhilePending, 'having sent a push is not having been paid');

  ck('P9 the gate opens ONLY once the server reports the payment completed',
    m.openAfterConfirm, 'this is the whole slice');
  ck('P10 the confirmed M-Pesa code is shown back to the cashier',
    m.showsCode, 'so it can be read against the customer\'s SMS');

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
