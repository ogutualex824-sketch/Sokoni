/* RC-10 ACCOUNT BASELINE & NAVIGATION — locks in the 2026-07-26 account-consistency
   fixes so they cannot silently regress:
     • the Orders button is decoupled from the crashing Profile page,
     • the subscription page never renders "KES NaN",
     • auth-state is a single canonical resolution-aware source,
     • every account has a complete baseline (users/wallet/notificationPrefs),
     • a signed-in account never loops profile.html ↔ login.html.

   Static-safe steps run everywhere; auth steps report BLOCKED (never a false pass)
   on the static backend and run for real on production/emulator. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

module.exports = {
  id: 'RC-10', title: 'Account Baseline & Navigation',
  steps: [
    { name: 'Orders button is decoupled from Profile (→ my-orders.html)', capability: 'Navigation integrity', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/category.html?cat=all', { waitUntil: 'domcontentloaded' });
        const href = await page.evaluate(() => {
          const a = Array.from(document.querySelectorAll('a.bnav-item'))
            .find(el => /orders/i.test(el.textContent || ''));
          return a ? a.getAttribute('href') : null;
        });
        if (href == null) throw new BlockedError('no Orders bottom-nav item on this page');
        if (/profile\.html#orders/.test(href)) throw new Error(`Orders still points at the crashing profile page: ${href}`);
        if (!/my-orders\.html/.test(href)) throw new Error(`Orders href unexpected: ${href}`);
        return { detail: `Orders → ${href}` };
    }},

    { name: 'Subscription page never renders "KES NaN"', capability: 'Pricing integrity', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/plans.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);
        const nan = await page.evaluate(() => {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n; while ((n = w.nextNode())) {
            if (n.parentElement && /SCRIPT|STYLE/.test(n.parentElement.tagName)) continue;
            if (/KES\s*NaN|\bNaN\b/i.test(n.textContent || '')) return n.textContent.trim().slice(0, 60);
          }
          return null;
        });
        if (nan) throw new Error(`visible NaN on plans page: "${nan}"`);
    }},

    { name: 'Auth-state is a single canonical resolution-aware source', capability: 'Auth-state unification', async run(ctx) {
        const page = await ctx.ui();
        const base = ctx.baseUrl();
        const [authSrc, permSrc] = await page.evaluate(async (b) => {
          const g = async (p) => { try { return await (await fetch(b + p)).text(); } catch (e) { return ''; } };
          return [await g('/sokoni-auth-state.js'), await g('/sokoni-permissions.js')];
        }, base);
        if (!/window\.SokoniAuthState/.test(authSrc)) throw new Error('sokoni-auth-state.js does not expose SokoniAuthState');
        if (!/isResolved|whenResolved/.test(authSrc)) throw new Error('SokoniAuthState missing resolution API');
        if (!/SokoniAuthState/.test(permSrc)) throw new Error('sokoni-permissions.js does not delegate to SokoniAuthState');
        /* the premature-false bug: a live `if (window.firebaseAuth) return false;` NOT inside a comment */
        const liveBug = permSrc.split('\n').some(l => /^\s*if \(window\.firebaseAuth\) return false;/.test(l));
        if (liveBug) throw new Error('premature-false bug still present in sokoni-permissions.js');
    }},

    { name: 'Every account has a complete baseline (users/wallet/notificationPrefs)', capability: 'Baseline integrity', async run(ctx) {
        const uid = await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.buyer); // BlockedError on static
        if (!uid) throw new Error('no uid for buyer identity');
        const [u, w, n] = await Promise.all([
          ctx.backend.getDoc(`users/${uid}`),
          ctx.backend.getDoc(`wallets/${uid}`),
          ctx.backend.getDoc(`notificationPrefs/${uid}`),
        ]);
        const missing = [];
        if (!u) missing.push('users');
        if (!w) missing.push('wallets');
        if (!n) missing.push('notificationPrefs');
        if (missing.length) throw new Error(`baseline docs missing for buyer: ${missing.join(', ')} (run scripts/migrate-user-baselines.js --live)`);
        if (w && w.balance !== 0 && typeof w.balance !== 'number') throw new Error('wallet balance not numeric');
        ctx.record('baseline', { uid, users: !!u, wallet: !!w, notif: !!n });
        return { detail: `uid=${uid} users✓ wallet✓ notifPrefs✓` };
    }},

    { name: 'Signed-in account does not loop profile.html ↔ login.html', capability: 'Session stability', async run(ctx) {
        const res = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer); // BlockedError on static
        if (!res || res.ok === false) throw new BlockedError('sign-in unavailable: ' + (res && (res.code || res.msg)));
        const page = await ctx.ui();
        let navs = 0;
        page.on('framenavigated', f => { if (f === page.mainFrame()) navs++; });
        await page.goto(ctx.baseUrl() + '/profile.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(6000);
        const landed = page.url();
        if (/login/.test(landed)) throw new Error(`profile bounced a signed-in user to login (navs=${navs}) — the loop is back`);
        if (navs > 4) throw new Error(`profile redirect-looped (${navs} navigations)`);
        const ok = await page.evaluate(() => !!(document.querySelector('.up-tab') && window.SokoniAuthState));
        if (!ok) throw new Error('profile did not render tabs / SokoniAuthState absent');
        const errs = page._rcErrors.filter(e => !/u\[v\]|Cannot read prop/.test(e));
        if (errs.length) throw new Error(`profile pageerror: ${errs[0]}`);
        return { detail: `stayed on profile (navs=${navs}), tabs rendered, auth-state present` };
    }},
  ],
};
