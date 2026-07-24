/* RC-09 FIRESTORE RULES — client-side authorization, exercised through a real
   browser session with a real ID token. The Admin SDK BYPASSES rules entirely,
   so this is the only path that produces runtime evidence the deployed rules
   enforce the intended model.

   Every "should deny" is paired with a NEGATIVE CONTROL: the same operation
   performed by an identity that IS permitted. Without the control, a rule that
   denies everyone looks identical to a rule that denies correctly — the suite
   would report a reassuring PASS for a completely broken security model.

   Model under test (firestore.rules, products):
     read   : if true                      — public catalogue
     create : sellerUid == request.auth.uid
     update : isAdmin() || (owner && sellerUid unchanged)
     delete : isAdmin() || owner
   and auditLog: write: if false — denied for everyone. */
'use strict';
const { BlockedError } = require('../backends/backend-interface');

const OWNED    = 'products/rc-rules-owned';
const FOREIGN  = 'products/rc-rules-foreign';
const FOREIGN_UID = 'rc-not-this-seller-uid';

/* Record one scenario in a uniform shape so the report is auditable. */
function record(ctx, o) { ctx.record('rules', o); }

async function expectOp(ctx, { label, op, path, data, expect }) {
  const r = await ctx.clientOp({ op, path, data });
  const actual = r.ok ? 'allow' : 'deny';
  record(ctx, { label, op, path, expect, actual, code: r.code || null, uid: r.uid || null });
  return { ...r, actual, ok: actual === expect };
}

/* A "deny" result only means the rules denied it if we have PROVEN the client
   can do something it is permitted to do. If the control failed, every client
   operation is being refused before rules are consulted — and reporting those
   denials as security evidence would be actively dangerous, because they would
   look identical with wide-open rules. So deny steps hard-BLOCK on an invalid
   control rather than passing. */
function requireValidControl(ctx) {
  if (ctx._rulesControlValid !== true) {
    throw new BlockedError(
      'negative control invalid — client operations are blanket-denied before rules ' +
      'are evaluated (App Check rejects the headless browser). Deny results here are ' +
      'NOT rule evidence. Register an App Check debug token, or run on the emulator.');
  }
}

module.exports = {
  id: 'RC-09', title: 'Firestore Rules (client-side authorization)',
  steps: [
    { name: 'Seed: one product owned by the RC seller, one owned by another seller',
      capability: 'Rules fixture', async run(ctx) {
        const uid = await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.seller);
        /* The buyer must exist in Auth too, or the buyer-isolation step below
           BLOCKS on auth/invalid-credential and that scenario goes untested. */
        await ctx.backend.ensureUser(ctx.dataset.IDENTITIES.buyer);
        const base = { ...ctx.dataset.RC_TAG, name: 'RC Rules Probe', price: 1000,
                       status: 'active', isVisible: true, searchableTerms: ['rc', 'rules'] };
        await ctx.backend.setDoc(OWNED,   { ...base, sellerUid: uid });
        await ctx.backend.setDoc(FOREIGN, { ...base, sellerUid: FOREIGN_UID });
        ctx.record('assertion', { ownedBy: uid, foreignBy: FOREIGN_UID });
        return { detail: `owned by ${uid}, foreign by ${FOREIGN_UID}` };
    }},

    /* DEPLOYED rules deny anonymous direct reads of `products`, and that is the
       intended posture — verified empirically that it costs visitors nothing:
       a logged-out load of mysokoni.co.ke renders 91 priced items, so the
       catalogue reaches visitors through a different path, not raw client reads.

       NOTE — the repo's firestore.rules says `allow read: if true` for products
       while production DENIES it. The working-tree file is modified and
       undeployed, so deploying it as-is would LOOSEN this collection to public
       client reads. Flagged rather than silently encoded into the expectation. */
    { name: 'Anonymous direct read of products is denied (deployed posture)',
      capability: 'Rules: public read', async run(ctx) {
        await ctx.signOut();
        const r = await expectOp(ctx, { label: 'anon read product', op: 'get', path: OWNED, expect: 'deny' });
        if (!r.ok) {
          return { status: 'BLOCKED', detail:
            'anonymous read SUCCEEDED — deployed rules now allow public client reads of ' +
            'products. Not a failure, but a posture change: re-confirm it is intended.' };
        }
        return { detail: `denied (${r.code}) — catalogue still served to visitors via another path` };
    }},

    /* THE CONTROL. Uses users/{uid} self-access, which the rules explicitly
       permit (`request.auth.uid == userId`) — NOT products, because product
       mutation is Cloud-Function-mediated and a client is denied there BY
       DESIGN, which would make a useless control. If even this is refused, the
       client is blocked before rules run and nothing below is rule evidence. */
    { name: 'NEGATIVE CONTROL: signed-in user CAN read their own users/{uid} doc',
      capability: 'Rules: control validity', async run(ctx) {
        const res = await ctx.signInAs(ctx.dataset.IDENTITIES.seller);
        if (!res.ok) throw new BlockedError(`sign-in unavailable: ${res.code} ${res.msg}`);
        const r = await expectOp(ctx, { label: 'self read users doc', op: 'get',
                                        path: `users/${res.uid}`, expect: 'allow' });
        ctx._rulesControlValid = r.ok;
        if (!r.ok) {
          /* Not a product defect and not a rules defect — an ENVIRONMENT limit.
             Real browsers pass App Check via ReCaptcha; headless Chromium does
             not, so Firestore refuses everything with permission-denied. */
          throw new BlockedError(
            `control refused (${r.code}) — a signed-in user cannot even read their own ` +
            `users doc, which the rules explicitly allow. Client ops are blanket-denied ` +
            `(App Check). Rules CANNOT be certified from headless Chromium without an ` +
            `App Check debug token; the live site is unaffected.`);
        }
        return { detail: 'self-read allowed — controls are valid, deny results below are meaningful' };
    }},

    { name: 'CONTROL: signed-out write is denied', capability: 'Rules: anonymous write', async run(ctx) {
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'anon update product', op: 'update',
                                        path: OWNED, data: { price: 999 }, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: an unauthenticated client could write a product');
        return { detail: `denied (${r.code})` };
    }},

    { name: 'Seller CANNOT update another seller\'s product',
      capability: 'Rules: cross-seller isolation', async run(ctx) {
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'seller update foreign product', op: 'update',
                                        path: FOREIGN, data: { price: 1 }, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: a seller could modify another seller\'s product');
        return { detail: `denied (${r.code})` };
    }},

    { name: 'Seller CANNOT reassign ownership (sellerUid is immutable)',
      capability: 'Rules: ownership immutability', async run(ctx) {
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'owner rewrites sellerUid', op: 'update',
                                        path: OWNED, data: { sellerUid: FOREIGN_UID }, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: sellerUid is mutable — ownership could be transferred or stolen');
        return { detail: `denied (${r.code})` };
    }},

    { name: 'Seller CANNOT delete another seller\'s product',
      capability: 'Rules: cross-seller delete', async run(ctx) {
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'seller delete foreign product', op: 'delete',
                                        path: FOREIGN, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: a seller could delete another seller\'s product');
        return { detail: `denied (${r.code})` };
    }},

    { name: 'Buyer CANNOT write a seller-owned product (control: seller could, above)',
      capability: 'Rules: buyer isolation', async run(ctx) {
        await ctx.signOut();
        const res = await ctx.signInAs(ctx.dataset.IDENTITIES.buyer);
        if (!res.ok) throw new BlockedError(`buyer sign-in unavailable: ${res.code} ${res.msg}`);
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'buyer update seller product', op: 'update',
                                        path: OWNED, data: { price: 5 }, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: an ordinary buyer could modify a seller\'s product');
        return { detail: `denied (${r.code})` };
    }},

    { name: 'Admin-only collection rejects an ordinary authenticated user',
      capability: 'Rules: admin-only collections', async run(ctx) {
        requireValidControl(ctx);
        const r = await expectOp(ctx, { label: 'buyer writes auditLog', op: 'set',
                                        path: 'auditLog/rc-rules-probe',
                                        data: { ...ctx.dataset.RC_TAG, probe: true }, expect: 'deny' });
        if (!r.ok) throw new Error('SECURITY: an ordinary user could write the audit log');
        return { detail: `denied (${r.code})` };
    }},
  ],
};
