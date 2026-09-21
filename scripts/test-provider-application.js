/* sokoni-provider-application.js — the services half of the dual intake.

   WHAT THESE PROVE

   Submitting is a REQUEST. The single worst outcome for this file is that a
   caller talks it into writing something that looks like an approval, so the
   forbidden-field filter is tested with a positive control proving legitimate
   profile fields DO survive — otherwise "nothing smuggled through" would pass
   against a primitive that writes nothing at all.

   The second property is that the two halves are INDEPENDENT: a provider
   application must not touch the merchant document, or a dual applicant's two
   reviews collapse into one.
*/
'use strict';
const path = require('path');
const M = require(path.join(__dirname, '..', 'sokoni-merchant-application.js'));
const P = require(path.join(__dirname, '..', 'sokoni-provider-application.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

const UID = 'uid_cyber_1';

function mkFs(seed) {
  const store = Object.assign({}, seed || {});
  return {
    store,
    writes: [],
    async get(c, id) { return store[c + '/' + id] || null; },
    async set(c, id, data) { this.writes.push([c + '/' + id, data]); store[c + '/' + id] = data; },
  };
}

(async () => {

  console.log('\n── Document identity ──');
  ck('provider doc id is {uid}--provider', P.docId(UID) === UID + '--provider', P.docId(UID));
  ck('it differs from the merchant id', P.docId(UID) !== M.docId(UID));
  ck('both live in `applications`', P.COLLECTION === M.COLLECTION && P.COLLECTION === 'applications');
  ck('intake type is provider', P.TYPE === 'provider');
  ck('…and the merchant one is still seller (unchanged)', M.TYPE === 'seller');

  console.log('\n── A clean submission ──');
  {
    const fs = mkFs();
    const r = await P.submit({ uid: UID, fs, agreementAccepted: true, profile: { name: 'KASS Cyber' } });
    ck('it submits', r.ok, r.message || '');
    ck('action is create', r.action === 'create', r.action);
    ck('status is pending_review', r.status === 'pending_review', r.status);
    ck('exactly ONE document was written', fs.writes.length === 1, fs.writes.length);
    const [id, d] = fs.writes[0];
    ck('…at the provider id', id === 'applications/' + UID + '--provider', id);
    ck('type is provider', d.type === 'provider');
    ck('hub is service', d.hub === 'service');
    ck('status is not caller-controlled', d.status === 'pending_review');
    ck('agreement is recorded', d.agreementAccepted === true);
  }

  console.log('\n── It CANNOT write an approval ──');
  {
    const fs = mkFs();
    await P.submit({
      uid: UID, fs, agreementAccepted: true,
      profile: {
        name: 'Legit Name',
        status: 'approved', role: 'provider', roles: ['admin'], approved: true,
        verified: true, isAdmin: true, admin: true, superAdmin: true,
        claims: { provider: true }, customClaims: { admin: true },
        decidedBy: 'me', decidedAt: 'now', commissionRate: 0, featured: true,
      },
    });
    const d = fs.writes[0][1];
    ck('status stays pending_review', d.status === 'pending_review', d.status);
    ck('no role', d.role === undefined);
    ck('no roles', d.roles === undefined);
    ck('no approved flag', d.approved === undefined);
    ck('no verified flag', d.verified === undefined);
    ck('no admin / superAdmin', d.isAdmin === undefined && d.admin === undefined && d.superAdmin === undefined);
    ck('no claims / customClaims', d.claims === undefined && d.customClaims === undefined);
    ck('no decidedBy / decidedAt', d.decidedBy === undefined && d.decidedAt === undefined);
    ck('no commissionRate / featured', d.commissionRate === undefined && d.featured === undefined);
    /* POSITIVE CONTROL — without this, every assertion above would also pass
       against a primitive that wrote an empty document. */
    ck('…and a LEGITIMATE profile field DID survive', d.name === 'Legit Name', d.name);
  }

  console.log('\n── The agreement is a precondition ──');
  {
    const fs = mkFs();
    const r = await P.submit({ uid: UID, fs, profile: { name: 'X' } });
    ck('no agreement ⇒ refused', !r.ok && r.reason === 'agreement_not_accepted', r.reason);
    ck('…and NOTHING was written', fs.writes.length === 0, fs.writes.length);
    const r2 = await P.submit({ uid: UID, fs, agreementAccepted: 'yes', profile: {} });
    ck('a truthy non-true value does not count', !r2.ok, r2.reason);
  }

  console.log('\n── Resubmission semantics are the sibling\'s ──');
  {
    const key = 'applications/' + UID + '--provider';
    const approved = mkFs({ [key]: { status: 'approved' } });
    const r1 = await P.submit({ uid: UID, fs: approved, agreementAccepted: true, profile: {} });
    ck('an APPROVED provider cannot re-apply', !r1.ok && r1.reason === 'already_approved', r1.reason);
    ck('…and nothing was written', approved.writes.length === 0);

    const susp = mkFs({ [key]: { status: 'suspended' } });
    const r2 = await P.submit({ uid: UID, fs: susp, agreementAccepted: true, profile: {} });
    ck('a SUSPENDED provider cannot clear it by re-applying', !r2.ok && r2.reason === 'suspended', r2.reason);
    ck('…and nothing was written', susp.writes.length === 0);

    const rej = mkFs({ [key]: { status: 'rejected', resubmitCount: 2 } });
    const r3 = await P.submit({ uid: UID, fs: rej, agreementAccepted: true, profile: {} });
    ck('a REJECTED provider may resubmit', r3.ok && r3.action === 'resubmit', r3.action);
    ck('…and the counter increments', rej.writes[0][1].resubmitCount === 3, rej.writes[0][1].resubmitCount);

    const pend = mkFs({ [key]: { status: 'pending_review' } });
    const r4 = await P.submit({ uid: UID, fs: pend, agreementAccepted: true, profile: { name: 'Edited' } });
    ck('a PENDING application accepts profile edits', r4.ok && r4.action === 'update', r4.action);
  }

  console.log('\n── The two halves are INDEPENDENT (dual business) ──');
  {
    const fs = mkFs();
    await M.submit({ uid: UID, fs, agreementAccepted: true, profile: { name: 'KASS' } });
    await P.submit({ uid: UID, fs, agreementAccepted: true, profile: { name: 'KASS' } });
    ck('two documents exist', fs.writes.length === 2, fs.writes.length);
    const ids = fs.writes.map((w) => w[0]).sort();
    ck('…one merchant, one provider',
       ids.join(' ') === `applications/${UID}--merchant applications/${UID}--provider`, ids.join(' '));
    ck('the merchant doc is type seller', fs.store['applications/' + UID + '--merchant'].type === 'seller');
    ck('the provider doc is type provider', fs.store['applications/' + UID + '--provider'].type === 'provider');
  }
  {
    /* A half-suspension must be expressible — the reason dual is two documents. */
    const key = 'applications/' + UID + '--merchant';
    const fs = mkFs({ [key]: { status: 'suspended' } });
    const mr = await M.submit({ uid: UID, fs, agreementAccepted: true, profile: {} });
    const pr = await P.submit({ uid: UID, fs, agreementAccepted: true, profile: {} });
    ck('a suspended PRODUCTS side refuses', !mr.ok, mr.reason);
    ck('…while the SERVICES side still submits', pr.ok, pr.message || '');
  }

  console.log('\n── Refusals ──');
  {
    let threw = false;
    try { await P.submit({ fs: mkFs(), agreementAccepted: true }); } catch (_) { threw = true; }
    ck('no uid throws', threw);
    threw = false;
    try { await P.submit({ uid: UID, agreementAccepted: true }); } catch (_) { threw = true; }
    ck('no firestore adapter throws', threw);
  }

  console.log('\n── No duplicated security logic ──');
  {
    const src = require('fs').readFileSync(
      path.join(__dirname, '..', 'sokoni-provider-application.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* The forbidden list and the resubmission rules must be IMPORTED, not
       re-declared — two copies of a security filter is one that gets updated
       and one that does not. */
    ck('FORBIDDEN is not re-declared here', !/FORBIDDEN\s*=\s*\[/.test(code));
    ck('decideAction is not re-implemented', !/function decideAction/.test(code));
    ck('…both are taken from the merchant module',
       /merchant\.FORBIDDEN/.test(code) && /merchant\.decideAction/.test(code));
    ck('…and the stripped source still has real code',
       /function buildDocument/.test(code), code.length + ' chars');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n  HARNESS CRASHED — a FAILURE, not a refusal:\n', e);
  process.exit(2);
});
