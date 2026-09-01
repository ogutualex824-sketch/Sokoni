'use strict';
/* AdminOS Authority Core — PURE unit tests (no emulator) for the claim-algebra.
 * Binding scope design/adminos-authority-core 05df4c9.
 *   C1  preserve non-role claims + normalize only the six governed roles + superAdmin⇒admin
 *   C2/C6  permsVersion monotonic (never downgrades a higher existing value)
 *   C7  deterministic event identity (retry idempotency)
 * The transactional contract (C3/C8/C9/C10) is proven in emulator-tests/authority-core.emul.js.
 */
const ace = require('../authority-control-events');
const { _requireSuperAdmin } = require('../super-admin');

describe('AdminOS Authority Core — C3 single-authority deny (superAdmin claim is THE gate)', () => {
  const call = (token) => () => _requireSuperAdmin({ auth: token ? { uid: 'c', token } : null });
  test('no auth → denied', () => { expect(call(null)).toThrow(/superAdmin/); });
  test('admin claim alone is NOT sufficient (only superAdmin manages roles)', () => {
    expect(call({ admin: true })).toThrow(/superAdmin/);
  });
  test('a forged non-claim signal (e.g. adminPermissions grant) does NOT authorize', () => {
    expect(call({ admin: true, adminPermissions: { roles: { write: true } } })).toThrow(/superAdmin/);
  });
  test('superAdmin claim → allowed (no throw)', () => {
    expect(call({ superAdmin: true })).not.toThrow();
  });
});

describe('AdminOS Authority Core — C1 claim merge/preserve/normalize', () => {
  test('preserves EVERY non-role claim (merchantId, posId, custom) while setting the role', () => {
    const current = { merchantId: 'm_123', posId: 'till_7', someFlag: true, seller: true, permsVersion: 1 };
    const merged  = ace.computeMergedClaims(current, 'admin');
    expect(merged.merchantId).toBe('m_123');   // C1: non-role claim untouched
    expect(merged.posId).toBe('till_7');
    expect(merged.someFlag).toBe(true);
    expect(merged.admin).toBe(true);
    expect(merged.seller).toBe(false);          // stale governed role cleared
  });

  test('superAdmin ⇒ admin (superAdmin never exists without admin)', () => {
    const m = ace.computeMergedClaims({}, 'superAdmin');
    expect(m.superAdmin).toBe(true);
    expect(m.admin).toBe(true);
  });

  test('normalizes ALL six governed keys to booleans; unselected → false (not deleted)', () => {
    const m = ace.computeMergedClaims({ admin: true, superAdmin: true, moderator: true }, 'seller');
    for (const k of ace.GOVERNED_ROLE_KEYS) expect(typeof m[k]).toBe('boolean');
    expect(m.seller).toBe(true);
    expect(m.admin).toBe(false);
    expect(m.superAdmin).toBe(false);
    expect(m.moderator).toBe(false);
  });

  test('demotion to buyer clears every elevated governed role', () => {
    const m = ace.computeMergedClaims({ admin: true, superAdmin: true, merchantId: 'keep' }, 'buyer');
    expect(m.buyer).toBe(true);
    expect(m.admin).toBe(false);
    expect(m.superAdmin).toBe(false);
    expect(m.merchantId).toBe('keep');          // non-role survives a demotion
  });

  test('does NOT delete a non-governed key even when it looks privilege-adjacent', () => {
    const m = ace.computeMergedClaims({ impersonator: true, tenantAdmin: true }, 'buyer');
    expect(m.impersonator).toBe(true);          // outside the governed set → preserved verbatim
    expect(m.tenantAdmin).toBe(true);
  });
});

describe('AdminOS Authority Core — C2/C6 permsVersion monotonicity', () => {
  test('absent/zero existing → CURRENT_PERMS_VERSION', () => {
    expect(ace.computeMergedClaims({}, 'admin').permsVersion).toBe(ace.CURRENT_PERMS_VERSION);
    expect(ace.computeMergedClaims({ permsVersion: 0 }, 'admin').permsVersion).toBe(ace.CURRENT_PERMS_VERSION);
  });
  test('a HIGHER existing permsVersion is NEVER downgraded', () => {
    const m = ace.computeMergedClaims({ permsVersion: 9 }, 'admin');
    expect(m.permsVersion).toBe(9);             // max(9, 1) === 9
  });
  test('equal existing stays equal', () => {
    expect(ace.computeMergedClaims({ permsVersion: ace.CURRENT_PERMS_VERSION }, 'seller').permsVersion)
      .toBe(ace.CURRENT_PERMS_VERSION);
  });
});

describe('AdminOS Authority Core — C7 deterministic event identity', () => {
  const base = { targetUid: 'u1', callerUid: 'c1', intendedClaims: ace.computeMergedClaims({}, 'admin'), requestId: 'req-1' };
  test('identical intent → identical id (retry idempotency)', () => {
    expect(ace.deterministicEventId(base)).toBe(ace.deterministicEventId({ ...base }));
  });
  test('id is stable regardless of intendedClaims key ordering', () => {
    const reordered = { buyer: false, permsVersion: 1, superAdmin: false, admin: true, moderator: false, driver: false, seller: false, merchantId: 'x' };
    const a = ace.deterministicEventId(base);
    const b = ace.deterministicEventId({ ...base, intendedClaims: reordered });
    expect(b).toBe(a);                           // only governed keys + permsVersion are material, order-independent
  });
  test('different requestId → different id (distinct intents do not collide)', () => {
    expect(ace.deterministicEventId({ ...base, requestId: 'req-2' })).not.toBe(ace.deterministicEventId(base));
  });
  test('different elected role → different id', () => {
    const seller = { ...base, intendedClaims: ace.computeMergedClaims({}, 'seller') };
    expect(ace.deterministicEventId(seller)).not.toBe(ace.deterministicEventId(base));
  });
  test('ids are namespaced + hex', () => {
    expect(ace.deterministicEventId(base)).toMatch(/^ce_[0-9a-f]{64}$/);
  });
});

describe('AdminOS Authority Core — claimsApplied (reconciliation predicate)', () => {
  const intended = ace.computeMergedClaims({}, 'admin');
  test('true when governed keys + permsVersion satisfied', () => {
    expect(ace.claimsApplied({ admin: true, superAdmin: false, seller: false, driver: false, moderator: false, buyer: false, permsVersion: 1 }, intended)).toBe(true);
  });
  test('false when a governed key differs (mutation not applied)', () => {
    expect(ace.claimsApplied({ admin: false, permsVersion: 1 }, intended)).toBe(false);
  });
  test('true when permsVersion EXCEEDS intended (already advanced)', () => {
    expect(ace.claimsApplied({ admin: true, permsVersion: 5 }, intended)).toBe(true);
  });
});
