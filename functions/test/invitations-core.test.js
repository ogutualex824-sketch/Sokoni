/**
 * Invitation onboarding — end-to-end contract.
 *
 * Every case here derives from the ochisaac@gmail.com production failure
 * (2026-07-21 → 2026-08-01): an `admin` account that could never sign in because
 * it was created with a discarded random password and the only mail it ever
 * received was `template=welcome` with no setup link. `lastSignInTime` stayed
 * null for eleven days and nothing anywhere recorded a problem.
 *
 * The chain under test: invite → account → setup mail → password → sign-in →
 * accept → correct role → dashboard reachable.
 */
'use strict';

/* ── Fakes for the three external surfaces ─────────────────────────────────── */
const mockState = {
  users: new Map(),        // email -> userRecord
  claims: new Map(),       // uid -> claims
  docs: new Map(),         // 'col/id' -> data
  queued: [],              // emails queued
  links: [],               // reset links minted
  failMail: false,
};

jest.mock('firebase-admin', () => {
  const FieldValue = { serverTimestamp: () => '__ts__' };
  const Timestamp = {
    fromMillis: (ms) => ({ toDate: () => new Date(ms), toMillis: () => ms }),
    fromDate: (d) => ({ toDate: () => d, toMillis: () => d.getTime() }),
  };
  const mkDoc = (path) => ({
    get: async () => ({
      exists: mockState.docs.has(path),
      data: () => mockState.docs.get(path),
      ref: mkDoc(path),
    }),
    set: async (data, opts) => {
      const prev = (opts && opts.merge && mockState.docs.get(path)) || {};
      mockState.docs.set(path, { ...prev, ...data });
    },
    update: async (data) => mockState.docs.set(path, { ...(mockState.docs.get(path) || {}), ...data }),
  });
  const mkCol = (col) => ({
    doc: (id) => mkDoc(col + '/' + id),
    add: async (d) => { mockState.docs.set(col + '/' + Math.random(), d); return {}; },
    where: (f, op, v) => ({
      limit: () => ({
        get: async () => {
          const hits = [...mockState.docs.entries()]
            .filter(([k, d]) => k.startsWith(col + '/') && d && d[f] === v)
            .map(([k, d]) => ({ ref: mkDoc(k), data: () => d }));
          return { empty: !hits.length, docs: hits };
        },
      }),
    }),
    get: async () => ({
      docs: [...mockState.docs.entries()].filter(([k]) => k.startsWith(col + '/'))
        .map(([k, d]) => ({ id: k.split('/')[1], data: () => d, ref: mkDoc(k) })),
    }),
  });
  return {
    apps: [{}],
    initializeApp: () => {},
    firestore: Object.assign(() => ({ collection: mkCol }), { FieldValue, Timestamp }),
    auth: () => ({
      getUserByEmail: async (email) => {
        const u = mockState.users.get(email);
        if (!u) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return { ...u, customClaims: mockState.claims.get(u.uid) || u.customClaims };
      },
      getUser: async (uid) => {
        for (const u of mockState.users.values()) {
          if (u.uid === uid) return { ...u, customClaims: mockState.claims.get(uid) || u.customClaims };
        }
        throw new Error('no user');
      },
      createUser: async ({ email, displayName }) => {
        const u = {
          uid: 'uid-' + email, email, displayName,
          providerData: [{ providerId: 'password' }],
          metadata: { creationTime: 'now', lastSignInTime: null },
          customClaims: {},
        };
        mockState.users.set(email, u);
        return u;
      },
      setCustomUserClaims: async (uid, c) => { mockState.claims.set(uid, c); },
      generatePasswordResetLink: async (email) => {
        if (mockState.failMail) throw new Error('SMTP unavailable');
        const link = 'https://mysokoni.co.ke/__/auth/action?mode=resetPassword&oobCode=X-' + email;
        mockState.links.push(link);
        return link;
      },
      listUsers: async () => ({ users: [...mockState.users.values()], pageToken: undefined }),
    }),
  };
});

jest.mock('../email-service', () => ({
  EMAIL_SECRETS: [],
  /* Immediate send is the primary path now — the invitee's ONLY way in must not
     wait on a 2-minute scheduled drain. */
  send: async (msg) => {
    if (mockState.failMail) throw new Error('smtp down');
    mockState.queued.push(msg);
    return { messageId: 'm-' + mockState.queued.length };
  },
  queue: async (msg) => {
    if (mockState.failMail) throw new Error('queue down');
    mockState.queued.push(msg);
    return 'q-' + mockState.queued.length;
  },
}));
jest.mock('../email-templates', () => ({ base: (o) => '<html>' + (o.body || '') + '</html>' }));
jest.mock('firebase-functions/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));

const core = require('../invitations-core');

beforeEach(() => {
  mockState.users.clear(); mockState.claims.clear(); mockState.docs.clear();
  mockState.queued.length = 0; mockState.links.length = 0; mockState.failMail = false;
});

/* Helper: an account created by an ops script — password provider, never used. */
function seedStrandedAccount(email, claims = {}) {
  const uid = 'uid-' + email;
  mockState.users.set(email, {
    uid, email, displayName: '',
    providerData: [{ providerId: 'password' }],
    metadata: { creationTime: '2026-07-21', lastSignInTime: null },
    customClaims: claims,
  });
  mockState.claims.set(uid, claims);
  return uid;
}

describe('hasUsablePassword — the signal that was never checked', () => {
  test('password provider + never signed in = NOT usable (the ochisaac shape)', () => {
    expect(core.hasUsablePassword({
      providerData: [{ providerId: 'password' }],
      metadata: { lastSignInTime: null },
    })).toBe(false);
  });

  test('a successful sign-in proves the owner knows the password', () => {
    expect(core.hasUsablePassword({
      providerData: [{ providerId: 'password' }],
      metadata: { lastSignInTime: 'Thu, 30 Jul 2026' },
    })).toBe(true);
  });

  test('federated-only accounts need no password at all', () => {
    expect(core.hasUsablePassword({
      providerData: [{ providerId: 'google.com' }],
      metadata: { lastSignInTime: null },
    })).toBe(true);
  });
});

describe('Task 1+2 — an invitation always yields a signable account', () => {
  test('new invitee: account created AND a setup link mailed', async () => {
    const res = await core.createInvitation({
      email: 'new@example.com', role: 'moderator', invitedBy: 'admin1', name: 'New',
    });
    expect(res.authAccountCreated).toBe(true);
    expect(res.signInReady).toBe(true);
    expect(res.setupMailQueueId).toBeTruthy();
    expect(mockState.queued).toHaveLength(1);
  });

  test('the mail is a password-setup mail, not a bare welcome', async () => {
    await core.createInvitation({ email: 'new@example.com', role: 'admin', invitedBy: 'a' });
    const mail = mockState.queued[0];
    expect(mail.template).toBe('invitation-password-setup');
    expect(mail.template).not.toBe('welcome');
    /* It must actually carry a usable reset link — the whole failure was a mail
       that looked fine and contained no way in.
       The HTML copy is entity-escaped (`&` → `&amp;`), which is correct for
       markup, so the assertion accepts either form; the plain-text part must
       carry the link verbatim so it can be copied out of any client. */
    expect(mail.html).toMatch(/mode=resetPassword(&|&amp;)oobCode=/);
    expect(mail.text).toMatch(/mode=resetPassword&oobCode=/);
    expect(mail.text).toContain('https://mysokoni.co.ke/__/auth/action');
  });

  test('an EXISTING account that never signed in still gets a setup link', async () => {
    /* Exactly ochisaac: the account already exists, so a naive "create user"
       path short-circuits and the invitee is left stranded. */
    seedStrandedAccount('ochisaac@example.com', { admin: true });
    const res = await core.createInvitation({ email: 'ochisaac@example.com', role: 'admin', invitedBy: 'a' });
    expect(res.authAccountCreated).toBe(false);
    expect(res.setupMailQueueId).toBeTruthy();
    expect(mockState.queued[0].template).toBe('invitation-password-setup');
  });

  test('an account that has signed in is NOT sent a reset link', async () => {
    const uid = seedStrandedAccount('active@example.com', { admin: true });
    mockState.users.get('active@example.com').metadata.lastSignInTime = 'Thu, 30 Jul 2026';
    mockState.claims.set(uid, { admin: true });
    const res = await core.createInvitation({ email: 'active@example.com', role: 'admin', invitedBy: 'a' });
    expect(res.setupMailQueueId).toBeNull();
    expect(mockState.queued).toHaveLength(0);
  });

  test('the setup mail is SENT immediately, not left on a 2-minute queue', async () => {
    /* `queue()` writes a pending row drained by processEmailQueue every 2 minutes.
       "Queued" is indistinguishable from "delivered" to the admin who just
       clicked Invite — the ambiguity that let ochisaac sit stranded for 11 days. */
    const res = await core.sendPasswordSetupMail({
      email: 'x@example.com', name: 'X', roleLabel: 'Administrator', dest: '/admin', reason: 't',
    });
    expect(res.delivery).toBe('sent');
    expect(res.messageId).toBeTruthy();
  });

  test('a provider outage falls back to the durable queue rather than losing the mail', async () => {
    const realSend = require('../email-service').send;
    require('../email-service').send = async () => { throw new Error('provider 503'); };
    try {
      const res = await core.sendPasswordSetupMail({
        email: 'y@example.com', name: 'Y', roleLabel: 'Administrator', dest: '/admin', reason: 't',
      });
      expect(res.delivery).toBe('queued');
      expect(res.queueId).toBeTruthy();
    } finally {
      require('../email-service').send = realSend;
    }
  });

  test('if the setup mail cannot be sent the invitation FAILS loudly', async () => {
    /* The defining rule: never report a sent invitation the invitee cannot act
       on. A stranded invitee is a defect, not a pending mockState. */
    mockState.failMail = true;
    await expect(core.createInvitation({ email: 'x@example.com', role: 'moderator', invitedBy: 'a' }))
      .rejects.toThrow(/could not be sent|unable to sign in/i);
    const rec = [...mockState.docs.entries()].find(([k]) => k.startsWith('invitations/'));
    expect(rec[1].status).toBe('blocked_no_setup_mail');
  });
});

describe('Task 4 — role consistency is enforced before acceptance', () => {
  test('a moderator invite onto an admin account is REFUSED, not silently applied', () => {
    const v = core.checkRoleConsistency('moderator', { admin: true });
    expect(v.ok).toBe(false);
    expect(v.action).toBe('would_downgrade');
    expect(v.note).toMatch(/already holds "admin"/);
  });

  test('raising privilege is allowed', () => {
    expect(core.checkRoleConsistency('admin', { moderator: true }))
      .toMatchObject({ ok: true, action: 'upgrade', from: 'moderator', to: 'admin' });
  });

  test('a matching claim is a no-op, not a re-grant', () => {
    expect(core.checkRoleConsistency('admin', { admin: true })).toMatchObject({ ok: true, action: 'noop' });
  });

  test('a fresh account is simply granted', () => {
    expect(core.checkRoleConsistency('moderator', {})).toMatchObject({ ok: true, action: 'grant' });
  });

  test('vertical roles are NOT claims and never count as a mismatch', () => {
    /* The first audit reported three merchant invites as "mismatched" purely
       because `merchant` is a registeredAs key, not an Auth claim. */
    expect(core.checkRoleConsistency('merchant', {})).toMatchObject({ ok: true, action: 'vertical_role' });
    expect(core.checkRoleConsistency('merchant', { admin: true }).ok).toBe(true);
  });

  test('a contradictory invitation is refused at CREATE time', async () => {
    seedStrandedAccount('boss@example.com', { admin: true });
    await expect(core.createInvitation({ email: 'boss@example.com', role: 'moderator', invitedBy: 'a' }))
      .rejects.toThrow(/already holds "admin"/);
  });
});

describe('Task 3 + 5 — one acceptance flow, full chain', () => {
  test('invite → account → setup mail → sign-in → accept → role → dashboard', async () => {
    // 1. Admin creates the invite.
    const inv = await core.createInvitation({
      email: 'staff@example.com', role: 'moderator', invitedBy: 'admin1', name: 'Staff',
    });
    expect(inv.ok).toBe(true);

    // 2. Account exists, 3. setup mail queued with a real link.
    expect(mockState.users.has('staff@example.com')).toBe(true);
    expect(mockState.queued[0].html).toMatch(/oobCode/);

    // 4+5. Invitee sets a password and signs in (Firebase stamps lastSignInTime).
    const uid = 'uid-staff@example.com';
    mockState.users.get('staff@example.com').metadata.lastSignInTime = 'now';

    // 6. Acceptance.
    const acc = await core.acceptInvitation({
      token: inv.token, uid, callerEmail: 'staff@example.com',
    });
    expect(acc).toMatchObject({ success: true, role: 'moderator' });

    // 7. Correct role assigned as an Auth claim.
    expect(mockState.claims.get(uid)).toMatchObject({
      moderator: true, platformEmployee: true, platformRole: 'moderator',
    });

    // 8. Dashboard reachable — the employee record the admin surfaces read.
    expect(mockState.docs.get('platformEmployees/' + uid)).toMatchObject({
      role: 'moderator', active: true, email: 'staff@example.com',
    });

    // Invitation is closed out.
    const rec = [...mockState.docs.entries()].find(([k]) => k.startsWith('invitations/'))[1];
    expect(rec.status).toBe('accepted');
  });

  test('legacy platformInvites links keep working (consolidation without breakage)', async () => {
    mockState.docs.set('platformInvites/tok-legacy', {
      token: 'tok-legacy', email: 'old@example.com', role: 'support',
      status: 'pending', invitedBy: 'admin1',
      expiresAt: { toDate: () => new Date(Date.now() + 864e5) },
    });
    const uid = seedStrandedAccount('old@example.com');
    const acc = await core.acceptInvitation({ token: 'tok-legacy', uid, callerEmail: 'old@example.com' });
    expect(acc.success).toBe(true);
    expect(mockState.claims.get(uid)).toMatchObject({ support: true });
    /* Mirrored into the canonical collection so the consolidated view is complete. */
    const mirrored = [...mockState.docs.entries()].find(([k]) => k.startsWith('invitations/'));
    expect(mirrored[1]).toMatchObject({ status: 'accepted', source: 'platformInvites(legacy)' });
  });

  test('acceptance blocks on a role conflict instead of granting both claims', async () => {
    /* The old inline handler spread {...prev, [role]: true}, so this produced an
       account holding BOTH admin and moderator — privileges nobody granted. */
    mockState.docs.set('platformInvites/tok-conf', {
      token: 'tok-conf', email: 'ochisaac@example.com', role: 'moderator',
      status: 'pending', expiresAt: { toDate: () => new Date(Date.now() + 864e5) },
    });
    const uid = seedStrandedAccount('ochisaac@example.com', { admin: true });
    await expect(core.acceptInvitation({ token: 'tok-conf', uid, callerEmail: 'ochisaac@example.com' }))
      .rejects.toThrow(/already holds "admin"/);
    expect(mockState.claims.get(uid)).toEqual({ admin: true });   // unchanged
    expect(mockState.docs.get('platformInvites/tok-conf').status).toBe('blocked_role_conflict');
  });

  test('an invite can only be accepted by its addressee', async () => {
    const inv = await core.createInvitation({ email: 'a@example.com', role: 'support', invitedBy: 'x' });
    await expect(core.acceptInvitation({ token: inv.token, uid: 'uid-b', callerEmail: 'b@example.com' }))
      .rejects.toThrow(/was sent to a@example.com/);
  });

  test('expired and already-accepted invites are rejected', async () => {
    mockState.docs.set('platformInvites/tok-exp', {
      token: 'tok-exp', email: 'e@example.com', role: 'support', status: 'pending',
      expiresAt: { toDate: () => new Date(Date.now() - 1000) },
    });
    seedStrandedAccount('e@example.com');
    await expect(core.acceptInvitation({ token: 'tok-exp', uid: 'uid-e@example.com', callerEmail: 'e@example.com' }))
      .rejects.toThrow(/expired/i);

    mockState.docs.set('platformInvites/tok-used', {
      token: 'tok-used', email: 'u@example.com', role: 'support', status: 'accepted',
      expiresAt: { toDate: () => new Date(Date.now() + 864e5) },
    });
    await expect(core.acceptInvitation({ token: 'tok-used', uid: 'z', callerEmail: 'u@example.com' }))
      .rejects.toThrow(/already accepted/i);
  });
});

describe('Task 6 — the audit finds stranded accounts', () => {
  test('flags a password account that never signed in with no setup mail', async () => {
    seedStrandedAccount('stranded@example.com', { admin: true });
    const rep = await core.auditOnboarding();
    expect(rep.strandedCount).toBe(1);
    expect(rep.stranded[0]).toMatchObject({ email: 'stranded@example.com', claims: ['admin'] });
  });

  test('does NOT flag an account that received a setup mail', async () => {
    seedStrandedAccount('ok@example.com');
    mockState.docs.set('emailQueue/1', { to: 'ok@example.com', template: 'invitation-password-setup' });
    const rep = await core.auditOnboarding();
    expect(rep.strandedCount).toBe(0);
  });

  test('a bare welcome mail does NOT clear the stranded flag', async () => {
    /* The precise ochisaac trap: mail was sent, so any check counting "did we
       email them?" passes while the person still cannot sign in. */
    seedStrandedAccount('welcomeonly@example.com', { admin: true });
    mockState.docs.set('emailQueue/1', { to: 'welcomeonly@example.com', template: 'welcome', subject: 'Welcome to SOKONI' });
    const rep = await core.auditOnboarding();
    expect(rep.strandedCount).toBe(1);
  });

  test('reports claim/invitation conflicts and ignores vertical roles', async () => {
    seedStrandedAccount('conf@example.com', { admin: true });
    mockState.docs.set('platformInvites/t1', { email: 'conf@example.com', role: 'moderator', status: 'pending' });
    mockState.docs.set('platformInvites/t2', { email: 'conf@example.com', role: 'merchant', status: 'pending' });
    const rep = await core.auditOnboarding();
    expect(rep.conflictCount).toBe(1);
    expect(rep.conflicts[0].inviteRole).toBe('moderator');
  });
});
