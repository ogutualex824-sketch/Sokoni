'use strict';
/**
 * Confirm an invitation actually reached the invitee's provider.
 *
 *   node functions/scripts/verify-invite-mail.js --email a@b.com [--queue-id <id>] [--wait 360]
 *
 * ── WHY THIS IS SEPARATE FROM SENDING ────────────────────────────────────────
 * `emailQueue` rows are drained by the deployed `processEmailQueue` on a 2-minute
 * schedule, so the instant after a fallback-to-queue there is NOTHING to observe:
 * "pending" and "will never send" look identical. Declaring success at that moment
 * is the exact ambiguity that let an invitee sit stranded for eleven days
 * (CHANGELOG 2026-08-01). This polls past the scheduler window and reports the
 * queue row's TERMINAL status, or says plainly that it never reached one.
 */

const admin = require('firebase-admin');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
function arg(n) { const i = process.argv.indexOf('--' + n); return i !== -1 ? process.argv[i + 1] : null; }

const email   = String(arg('email') || '').toLowerCase().trim();
const queueId = arg('queue-id');
const WAIT_S  = parseInt(arg('wait') || '360', 10);

if (!email) { console.error('\nUsage: verify-invite-mail.js --email <e> [--queue-id <id>] [--wait <seconds>]\n'); process.exit(1); }

admin.initializeApp({ projectId: PROJECT });
const core = require('../invitations-core');
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => (t && t.toDate ? t.toDate().toISOString() : (t || '(none)'));
const TERMINAL = ['sent', 'failed', 'bounced', 'skipped'];

(async () => {
  const deadline = Date.now() + WAIT_S * 1000;
  let row = null, id = queueId;

  for (;;) {
    if (id) {
      const d = await db.collection('emailQueue').doc(id).get();
      row = d.exists ? d.data() : null;
    } else {
      const q = await db.collection('emailQueue')
        .where('to', '==', email).orderBy('createdAt', 'desc').limit(1).get();
      if (!q.empty) { id = q.docs[0].id; row = q.docs[0].data(); }
    }

    const status = row ? String(row.status || 'pending') : '(no row)';
    console.log(`  [${new Date().toISOString()}] emailQueue/${id || '?'} → ${status}`);

    if (row && TERMINAL.includes(status.toLowerCase())) break;
    if (Date.now() >= deadline) {
      console.log('\n  STILL NOT TERMINAL after ' + WAIT_S + 's.');
      console.log('  The row is durable — processEmailQueue will keep retrying — but');
      console.log('  delivery is NOT confirmed. Do not tell the invitee it was sent.\n');
      break;
    }
    await sleep(30000);
  }

  if (row) {
    console.log('\n  ── queue row ─────────────────────────────────────────────');
    console.log('  to        : ' + row.to);
    console.log('  template  : ' + (row.template || '(none)'));
    console.log('  subject   : ' + (row.subject || '(none)'));
    console.log('  status    : ' + (row.status || 'pending'));
    console.log('  provider  : ' + (row.provider || '(none)'));
    console.log('  attempts  : ' + (row.attempts != null ? row.attempts : '(none)'));
    console.log('  error     : ' + (row.error || row.lastError || '(none)'));
    console.log('  createdAt : ' + iso(row.createdAt));
    console.log('  sentAt    : ' + iso(row.sentAt || row.processedAt));
  }

  const inv = await db.collection(core.COL).doc(core.inviteIdFor(email)).get();
  if (inv.exists) {
    const p = inv.data();
    console.log('\n  ── invitations record ────────────────────────────────────');
    console.log('  status       : ' + p.status);
    console.log('  role         : ' + p.role + ' (' + p.roleKind + ')');
    console.log('  signInReady  : ' + p.signInReady);
    console.log('  setupMailId  : ' + (p.setupMailQueueId || '(none)'));
    console.log('  resendCount  : ' + p.resendCount);
    console.log('  expiresAt    : ' + iso(p.expiresAt));
  }

  const u = await admin.auth().getUserByEmail(email);
  console.log('\n  ── account ───────────────────────────────────────────────');
  console.log('  lastSignIn   : ' + (u.metadata.lastSignInTime || '(never)'));
  console.log('  signable     : ' + (core.hasUsablePassword(u) ? 'YES' : 'NO — link not used yet'));
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('\n  Failed: ' + e.message + '\n'); process.exit(1); });
