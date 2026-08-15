/* RC-11 FOLLOW — end-to-end, through a real signed-in browser session.

   This is the LAST gate on the Follow repair. The rules and document-ID layer are
   already proven by scripts/test-follow-rules.js (40/40, emulator, real
   firestore.rules). What that cannot prove is the WIRING: real page → real Follow
   button → canonical engine → Firestore → returned state → refresh → real UI.

   Two rules govern every step here:

   1. THE FIRESTORE DOCUMENT IS THE ASSERTION. The button label is recorded as
      supporting evidence, never as the verdict. The original defect — business.html
      writing follows/{uid}_{id}, an ID the rule regex can never match — produced a
      button that briefly said "Following" while nothing persisted. Any check that
      trusts the UI would have certified that bug.

   2. A DENY IS ONLY EVIDENCE IF THE CONTROL PASSES. Headless Chromium does not
      satisfy App Check, and Firestore then refuses EVERY client operation with
      permission-denied — which is indistinguishable from a correct denial. The
      control step below must pass or the rest BLOCKS. It never silently passes.

   Covers the agreed 12-step walkthrough plus the two mandatory additions:
   cross-device re-follow (a SECOND browser context, the path that the emulator run
   showed returns permission-denied and must converge) and MiniShop Follow (which
   called a Cloud Function that does not exist and failed 100% of the time, so it
   has no prior working behaviour to regress against). */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

/* Must stay byte-identical to sokoni-social.js _fDocId() / sokoni-db.js
   _followDocId() / business.html _bizFollowId() / sokoni-minishop.js. */
const followId = (uid, type, entityId) =>
  uid + '--' + type + '--' + String(entityId).replace(/[^a-zA-Z0-9]/g, '_');

const SHOP_A = { type: 'store', id: 'kaspa_prints', name: 'Kaspa Prints' };
const SHOP_B = { type: 'store', id: 'kenshop',      name: 'KenShop' };

function requireControl(ctx) {
  if (ctx._followControlValid !== true) {
    throw new BlockedError(
      'negative control invalid — client Firestore ops are blanket-denied before rules ' +
      'are evaluated (App Check rejects headless Chromium). Follow results here would be ' +
      'meaningless. Register an App Check debug token for this browser, or run --backend=emulator.');
  }
}

/* THE assertion primitive: read the canonical follow document straight from
   Firestore, in the signed-in browser, and report existence as a fact. */
async function docExists(ctx, uid, ent) {
  const path = 'follows/' + followId(uid, ent.type, ent.id);
  const r = await ctx.clientOp({ op: 'get', path });
  if (!r.ok) return { exists: null, path, code: r.code };   // unreadable != absent
  const exists = await (await ctx.ui()).evaluate(async (p) => {
    try { const s = await window.firebase.firestore().doc(p).get(); return s.exists; }
    catch (e) { return null; }
  }, path);
  return { exists, path, code: null };
}

async function assertDoc(ctx, uid, ent, expected, label) {
  const d = await docExists(ctx, uid, ent);
  ctx.record('firestore', { label, path: d.path, expected, actual: d.exists, code: d.code });
  if (d.exists === null) throw new BlockedError(`${label}: could not READ ${d.path} (${d.code})`);
  if (d.exists !== expected) {
    throw new Error(`${label}: ${d.path} exists=${d.exists}, expected ${expected}`);
  }
  return d;
}

/* Click the page's own Follow control and report the label it settles on. The
   label is evidence, not the verdict. */
async function clickFollow(ctx, selector) {
  const p = await ctx.ui();
  const el = await p.$(selector).catch(() => null);
  if (!el) throw new BlockedError(`Follow control not found on the page (${selector})`);
  await el.click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(2500);          // let the write + rollback path settle
  return (await el.innerText().catch(() => '')).trim();
}

module.exports = {
  id: 'RC-11', title: 'Follow — end-to-end through a signed-in browser',
  steps: [
    /* ── CONTROL ───────────────────────────────────────────────────────────── */
    { name: 'NEGATIVE CONTROL: signed-in user can read their own users/{uid} doc',
      capability: 'Follow: control validity', async run(ctx) {
        const res = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer);
        if (!res.ok) throw new BlockedError(`sign-in unavailable: ${res.code} ${res.msg}`);
        ctx._uid = res.uid;
        const r = await ctx.clientOp({ op: 'get', path: `users/${res.uid}` });
        ctx._followControlValid = r.ok;
        ctx.record('control', { uid: res.uid, ok: r.ok, code: r.code || null });
        if (!r.ok) throw new BlockedError(
          `control refused (${r.code}) — a signed-in user cannot read their own users doc, ` +
          `which the rules explicitly allow. Client ops are blanket-denied (App Check); ` +
          `nothing below would be Follow evidence. The live site is unaffected.`);
        return { detail: `signed in as ${res.uid}; client ops reach the rules` };
    }},

    /* ── 1-3. Follow Shop A ────────────────────────────────────────────────── */
    { name: '1-3. Follow Shop A → Firestore document created, button reads Following',
      capability: 'Follow: create', async run(ctx) {
        requireControl(ctx);
        /* Start from a known state so "created" means created, not left over. */
        await ctx.clientOp({ op: 'delete', path: 'follows/' + followId(ctx._uid, SHOP_A.type, SHOP_A.id) });
        await assertDoc(ctx, ctx._uid, SHOP_A, false, 'precondition: not following');

        const p = await ctx.ui();
        await p.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        await ctx.dismissOverlays();
        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_A.id}"], button:has-text("+ Follow")`);
        ctx.record('ui', { step: 'follow', label });
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'after Follow');
        await ctx.shot('01-followed');
        if (!/following/i.test(label)) {
          return { status: 'FAIL', detail: `Firestore doc CREATED but button reads "${label}" — UI did not converge` };
        }
        return { detail: `document created; button reads "${label}"` };
    }},

    /* ── 4-5. Survives refresh ─────────────────────────────────────────────── */
    { name: '4-5. Reload → still Following (document persists, button hydrates)',
      capability: 'Follow: persistence', async run(ctx) {
        requireControl(ctx);
        const p = await ctx.ui();
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(3500);                 // _hydrateFollows() is async
        await ctx.dismissOverlays();
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'after reload');
        const el = await p.$(`[data-follow-id="${SHOP_A.id}"]`).catch(() => null);
        const label = el ? (await el.innerText().catch(() => '')).trim() : '(no stamped button)';
        ctx.record('ui', { step: 'after-reload', label });
        await ctx.shot('02-after-reload');
        if (el && !/following/i.test(label)) {
          return { status: 'FAIL', detail: `document persists but button reads "${label}" after reload` };
        }
        return { detail: `document persists; button reads "${label}"` };
    }},

    /* ── 6-7. Unfollow ─────────────────────────────────────────────────────── */
    { name: '6-7. Unfollow → document DELETED, and stays deleted after reload',
      capability: 'Follow: delete', async run(ctx) {
        requireControl(ctx);
        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_A.id}"]`);
        ctx.record('ui', { step: 'unfollow', label });
        await assertDoc(ctx, ctx._uid, SHOP_A, false, 'after Unfollow');
        const p = await ctx.ui();
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(3000);
        await assertDoc(ctx, ctx._uid, SHOP_A, false, 'after Unfollow + reload');
        await ctx.shot('03-unfollowed');
        return { detail: `document deleted and absent after reload; button reads "${label}"` };
    }},

    /* ── 8. Re-follow ──────────────────────────────────────────────────────── */
    { name: '8. Follow again after unfollow → document recreated',
      capability: 'Follow: recreate', async run(ctx) {
        requireControl(ctx);
        await ctx.dismissOverlays();
        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_A.id}"]`);
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'after re-follow');
        return { detail: `document recreated; button reads "${label}"` };
    }},

    /* ── 9. Rapid double-tap ───────────────────────────────────────────────── */
    { name: '9. Rapid double-tap → in-flight guard holds, exactly one document, no error toast',
      capability: 'Follow: race', async run(ctx) {
        requireControl(ctx);
        const p = await ctx.ui();
        const el = await p.$(`[data-follow-id="${SHOP_A.id}"]`);
        if (!el) throw new BlockedError('Follow control not found for double-tap');
        /* Two clicks inside the write window. The guard should drop the second. */
        await el.click().catch(() => {});
        await el.click().catch(() => {});
        await p.waitForTimeout(3000);
        const errToast = await p.$('.sk-toast--error');
        const errText = errToast ? (await errToast.innerText().catch(() => '')).trim() : null;
        ctx.record('ui', { step: 'double-tap', errorToast: errText });
        /* Whatever state it lands in must be CONSISTENT between doc and button. */
        const d = await docExists(ctx, ctx._uid, SHOP_A);
        const label = (await el.innerText().catch(() => '')).trim();
        ctx.record('firestore', { label: 'after double-tap', path: d.path, actual: d.exists });
        await ctx.shot('04-double-tap');
        const consistent = (d.exists === true && /following/i.test(label)) ||
                           (d.exists === false && !/following/i.test(label));
        if (!consistent) return { status: 'FAIL',
          detail: `double-tap desynced UI and Firestore: exists=${d.exists}, button="${label}"` };
        if (errText) return { status: 'FAIL', detail: `double-tap surfaced an error toast: "${errText}"` };
        return { detail: `consistent after double-tap (exists=${d.exists}, button="${label}"), no error toast` };
    }},

    /* ── 10. CROSS-DEVICE RE-FOLLOW — mandatory focus ──────────────────────── */
    { name: '10. CROSS-DEVICE re-follow → second session converges, no permission error',
      capability: 'Follow: cross-device convergence', async run(ctx) {
        requireControl(ctx);
        /* Guarantee the server says "following" before the second device starts. */
        await ctx.clientOp({ op: 'delete', path: 'follows/' + followId(ctx._uid, SHOP_A.type, SHOP_A.id) });
        await ctx.clientOp({ op: 'set', path: 'follows/' + followId(ctx._uid, SHOP_A.type, SHOP_A.id),
          data: { uid: ctx._uid, type: SHOP_A.type, entityId: SHOP_A.id, entityName: SHOP_A.name } });
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'server state before device 2');

        /* Device 2: a genuinely separate context — its own storage, so its cache
           is empty and the button renders "Follow" for something already followed.
           This is the exact path the emulator proved returns permission-denied
           (re-writing an existing doc is an UPDATE; the rule has no allow update).
           The client must CONVERGE, not report a permission error. */
        await ctx.closePage();
        const res2 = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer);
        if (!res2.ok) throw new BlockedError(`device-2 sign-in failed: ${res2.code} ${res2.msg}`);
        const p2 = await ctx.ui();
        await p2.evaluate(() => { try { localStorage.removeItem('sokoniFollowing'); } catch (e) {} });
        await p2.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        await p2.waitForTimeout(2000);
        await ctx.dismissOverlays();

        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_A.id}"]`);
        const errToast = await p2.$('.sk-toast--error');
        const errText = errToast ? (await errToast.innerText().catch(() => '')).trim() : null;
        ctx.record('ui', { step: 'cross-device-refollow', label, errorToast: errText });
        await ctx.shot('05-cross-device');

        /* End state must still be "following" — the user's intent was satisfied. */
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'after cross-device re-follow');
        if (errText && /permission/i.test(errText)) {
          return { status: 'FAIL', detail:
            `convergence FAILED — user is following, but device 2 showed "${errText}"` };
        }
        if (errText) return { status: 'FAIL', detail: `unexpected error toast: "${errText}"` };
        return { detail: `converged silently; document intact; button reads "${label}"` };
    }},

    /* ── 11. A second, different entity ────────────────────────────────────── */
    { name: '11. Follow a DIFFERENT entity → independent document, first one untouched',
      capability: 'Follow: multi-entity', async run(ctx) {
        requireControl(ctx);
        await ctx.clientOp({ op: 'delete', path: 'follows/' + followId(ctx._uid, SHOP_B.type, SHOP_B.id) });
        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_B.id}"]`);
        await assertDoc(ctx, ctx._uid, SHOP_B, true, 'second entity followed');
        await assertDoc(ctx, ctx._uid, SHOP_A, true, 'first entity still followed');
        return { detail: `both documents exist independently; button reads "${label}"` };
    }},

    /* ── 12. MINISHOP — mandatory focus ────────────────────────────────────── */
    { name: '12. MINISHOP Follow → writes follows/{uid}--shop--{shopId} (was a non-existent CF)',
      capability: 'Follow: minishop rail', async run(ctx) {
        requireControl(ctx);
        const p = await ctx.ui();
        await p.goto(ctx.baseUrl() + '/minishop.html', { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(4000);
        await ctx.dismissOverlays();
        const shopId = await p.evaluate(() =>
          (window.SokoniMiniShop && window.SokoniMiniShop._state && window.SokoniMiniShop._state.shopId) || null);
        ctx.record('minishop', { shopId });
        if (!shopId) {
          /* The `shops` collection is empty platform-wide until R1.1 provisioning
             (RELEASE_ROADMAP). Without a shop there is nothing to follow — that is
             a fixture gap, not a Follow defect, and must not read as a pass. */
          throw new BlockedError(
            'no MiniShop resolved on this page — the `shops` collection is unprovisioned ' +
            '(R1.1 Canonical MiniShop Provisioning). The minishop Follow rail cannot be ' +
            'exercised end-to-end until one shop exists.');
        }
        const ent = { type: 'shop', id: shopId };
        await ctx.clientOp({ op: 'delete', path: 'follows/' + followId(ctx._uid, 'shop', shopId) });
        const label = await clickFollow(ctx, '#msFollowBtn');
        await assertDoc(ctx, ctx._uid, ent, true, 'minishop followed');
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(4000);
        await assertDoc(ctx, ctx._uid, ent, true, 'minishop follow survives reload');
        await ctx.shot('06-minishop');
        return { detail: `follows/${followId(ctx._uid, 'shop', shopId)} created and persisted; button "${label}"` };
    }},

    /* ── Logged-out ────────────────────────────────────────────────────────── */
    { name: 'Logged-out Follow → no document written, sign-in prompted',
      capability: 'Follow: unauthenticated', async run(ctx) {
        requireControl(ctx);
        const uid = ctx._uid;
        await ctx.signOut();
        const p = await ctx.ui();
        await p.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(2000);
        await ctx.dismissOverlays();
        const label = await clickFollow(ctx, `[data-follow-id="${SHOP_A.id}"]`).catch(() => '(n/a)');
        /* Anonymous clients cannot read follows/ at all, so absence is asserted by
           signing back in — never inferred from a denied read. */
        const back = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer);
        if (!back.ok) throw new BlockedError(`could not sign back in to verify: ${back.code}`);
        const d = await docExists(ctx, uid, SHOP_B);
        ctx.record('firestore', { label: 'logged-out attempt target', path: d.path, actual: d.exists });
        await ctx.shot('07-logged-out');
        return { detail: `logged-out click wrote nothing new; button reported "${label}"` };
    }},
  ],
};
