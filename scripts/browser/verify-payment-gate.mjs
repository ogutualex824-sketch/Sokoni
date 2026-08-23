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
      /* The handle is KEPT. The shell calls destroy() before it remounts a
         surface, and a rig that ignores it leaves the previous instance's
         listeners on the same host — two instances then handle one click and the
         stale one wins. That is exactly what happened on the first run of the
         mixed-tender case below: a discount from an earlier sale reappeared on a
         fresh 6,000 cart. The bug was in this file, not the till. */
      let ui = M.mount(panel, ctx);
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

      /* ══ MIXED TENDER ══ a fresh 6,000 sale paid 4,000 M-Pesa + 2,000 cash.
         Rung up from scratch so nothing above can leak into it. */
      const mix = {};
      try {
        md.listProducts = () => Promise.resolve([
          { id: 'P9', productId: 'P9', name: 'Gas cylinder', price: 6000, stock: 20, image: '' },
        ]);
        confirmNow = false;
        let asked = null;
        ctx.callStk = (p) => { asked = p.amount; return Promise.resolve({ data: { checkoutId: 'CHK9' } }); };
        ctx.callVerify = () => Promise.resolve({ data: {
          status: confirmNow ? 'completed' : 'pending',
          paidAmount: confirmNow ? 4000 : null,
          mpesaCode: confirmNow ? 'SPLIT4000' : null } });

        try { ui && ui.destroy && ui.destroy(); } catch (_) {}
        mix.tornDown = true;
        panel.innerHTML = ''; ui = M.mount(panel, ctx);
        await sleep(1400);
        const card2 = panel.querySelector('.msl-card');
        mix.hasCard = !!card2;
        if (!card2) throw new Error('no product card after remount');
        card2.click(); await sleep(300);
        const charge2 = [].slice.call(panel.querySelectorAll('button'))
          .find((b) => /charge/i.test(b.textContent || ''));
        mix.hasCharge = !!charge2;
        if (!charge2) throw new Error('no Charge control after remount');
        charge2.click();
        await sleep(400);
        mix.due = dueOf();
        mix.sheetOpen = !!panel.querySelector('.msl-sheet');

        /* Ask M-Pesa for 4,000 of the 6,000. */
        [].slice.call(panel.querySelectorAll('[data-act="method"]'))
          .find((b) => b.getAttribute('data-m') === 'mpesa').click();
        await sleep(300);
        const amt = panel.querySelector('#msl-mamt');
        mix.hasAmountField = !!amt;
        mix.methodButtons = panel.querySelectorAll('[data-act="method"]').length;
        if (!amt) throw new Error('no #msl-mamt; sheetOpen=' + mix.sheetOpen +
          ' due=' + mix.due + ' snippet=' + txt().slice(0, 180));
        amt.value = '4000'; fire(amt, 'input'); await sleep(250);
        const ph = panel.querySelector('#msl-phone');
        ph.value = '0712000111'; fire(ph, 'input'); await sleep(250);
        panel.querySelectorAll('[data-act="stk-send"]')[0].click();
        await sleep(1400);
        mix.askedFor = asked;
        mix.gatedWhilePending = !!(completeBtn() && completeBtn().disabled);

        confirmNow = true;
        await sleep(4200);
        const t = txt();
        mix.ledgerShowsMpesa = /M-Pesa[^0-9]*4,?000/i.test(t);
        mix.balanceAfter = (t.match(/Balance[^0-9]*([\d,]+)/i) || [])[1];
        mix.gatedWithBalance = !!(completeBtn() && completeBtn().disabled);

        /* The remaining 2,000 in cash. */
        const cashBtn = [].slice.call(panel.querySelectorAll('[data-act="method"]'))
          .find((b) => b.getAttribute('data-m') === 'cash');
        if (cashBtn) { cashBtn.click(); await sleep(250); }
        mix.ledgerSurvivedSwitch = /M-Pesa[^0-9]*4,?000/i.test(txt());
        /* RE-QUERIED every time. The sheet repaints on each keystroke so the
           ladder stays truthful as you type, which means the previous input node
           is detached the moment it fires. Holding one reference and writing to
           it again writes to nothing — the first version of this block did, and
           its two assertions failed against a screen that was actually correct. */
        const typeCash = async (v) => {
          const el = panel.querySelector('#msl-cash');
          if (!el) throw new Error('no #msl-cash to type into');
          el.value = String(v); fire(el, 'input'); await sleep(320);
        };

        await typeCash(2000);
        mix.openAfterCash = !!(completeBtn() && !completeBtn().disabled);

        /* Overpay the cash half: change must appear, computed across ALL tenders. */
        await typeCash(2500);
        mix.changeOnOverpay = (txt().match(/Change due[^0-9]*([\d,]+)/i) || [])[1];

        /* Short cash: must close again. */
        await typeCash(500);
        mix.shutWhenShort = !!(completeBtn() && completeBtn().disabled);
      } catch (e) { mix.error = String((e && e.message) || e); }

      out({
        dueBefore, dueAfter, showsDiscount,
        gatedOnSelect, asksForPhone, sendDisabledWithoutPhone, canSendWithPhone,
        waitingText, gatedWhilePending, openAfterConfirm, showsCode, mix,
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

  /* ── MIXED TENDER: 4,000 M-Pesa + 2,000 cash on a 6,000 sale ─────────────── */
  const x = m.mix || {};
  if (x.error) {
    ck('P11 the mixed-tender sale could be driven', false,
      x.error + '  | state: ' + JSON.stringify(x));
  } else {
    ck('P11 M-Pesa can be asked for PART of the sale',
      x.due === 6000 && x.hasAmountField && x.askedFor === 4000,
      'due=' + x.due + ' asked=' + x.askedFor);
    ck('P12 while that half is pending, Complete sale is shut',
      x.gatedWhilePending, 'entering cash later must not rescue an unpaid half');
    ck('P13 the confirmed half joins the ledger as a real tender',
      x.ledgerShowsMpesa, 'shown as M-Pesa 4,000, not merged into one figure');
    ck('P14 the balance falls to exactly what is still owed',
      x.balanceAfter === '2,000', 'balance read back as ' + x.balanceAfter);
    ck('P15 a confirmed half alone does NOT complete the sale',
      x.gatedWithBalance, '4,000 of a 6,000 sale is not payment');
    ck('P16 switching to Cash keeps the confirmed M-Pesa — that money is real',
      x.ledgerSurvivedSwitch, 'discarding it would lose a payment the customer made');
    ck('P17 the cash balance completes the split',
      x.openAfterCash, '4,000 + 2,000 = 6,000');
    ck('P18 overpaying the CASH half returns change across the whole tender set',
      x.changeOnOverpay === '500', 'change read back as ' + x.changeOnOverpay);
    ck('P19 CONTROL dropping the cash below the balance shuts it again',
      x.shutWhenShort, 'if this failed, P17 would not be a gate at all');
  }

  const passed = rows.filter((r) => r.ok).length;
  return {
    verdict: passed + '/' + rows.length + ' passed',
    failed: rows.filter((r) => !r.ok).map((r) => r.label + '  [' + r.detail + ']'),
  };
}
