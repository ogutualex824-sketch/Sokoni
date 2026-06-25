#!/usr/bin/env node
/**
 * SOKONI Pre-Deploy Safety Gate
 * Blocks deployment while payments, orders, or critical queues are active.
 * Exit 0 = safe to deploy. Exit 1 = hold deployment.
 */
'use strict';

const admin = require('firebase-admin');

const PROJECT  = process.env.FIREBASE_PROJECT || 'sokoni-aeb26';
const TIMEOUT  = parseInt(process.env.GATE_TIMEOUT_MINUTES || '10', 10);
const POLL_MS  = 15_000;

/* Thresholds */
const MAX_PENDING_PAYMENTS   = 0;   /* zero tolerance — wait for all to settle */
const MAX_ACTIVE_DELIVERIES  = 5;   /* allow small backlog; gate only on surge  */
const MAX_QUEUE_DEPTH        = 50;  /* email/webhook queue depth                 */
const MAX_OPEN_POS_SESSIONS  = 0;   /* no open POS sessions during deploy        */

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

async function checkGate() {
  const results = await Promise.allSettled([
    /* 1. In-flight STK / IntaSend payments */
    db.collection('orders')
      .where('paymentStatus', '==', 'pending')
      .where('createdAt', '>', new Date(Date.now() - 10 * 60_000))
      .count().get(),

    /* 2. Active deliveries being dispatched right now */
    db.collection('deliveries')
      .where('status', 'in', ['assigning', 'dispatching'])
      .count().get(),

    /* 3. Unprocessed webhook queue */
    db.collection('webhookQueue')
      .where('status', '==', 'pending')
      .count().get(),

    /* 4. Open POS sessions */
    db.collection('posSessions')
      .where('status', '==', 'open')
      .where('updatedAt', '>', new Date(Date.now() - 5 * 60_000))
      .count().get(),

    /* 5. Email queue backlog */
    db.collection('emailQueue')
      .where('status', 'in', ['pending', 'retrying'])
      .count().get(),

    /* 6. Active financial reconciliation jobs */
    db.collection('reconciliationJobs')
      .where('status', '==', 'running')
      .count().get(),
  ]);

  const [payments, deliveries, webhooks, pos, emails, reconciliation] =
    results.map((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`Gate check ${i} failed (non-blocking): ${r.reason?.message}`);
        return { data: () => ({ count: 0 }) };
      }
      return r.value;
    });

  return {
    pendingPayments:        payments.data().count,
    activeDeliveries:       deliveries.data().count,
    pendingWebhooks:        webhooks.data().count,
    openPosSessions:        pos.data().count,
    emailQueue:             emails.data().count,
    activeReconciliations:  reconciliation.data().count,
  };
}

function isBlocked(state) {
  const reasons = [];
  if (state.pendingPayments   > MAX_PENDING_PAYMENTS)  reasons.push(`${state.pendingPayments} pending payments`);
  if (state.openPosSessions   > MAX_OPEN_POS_SESSIONS) reasons.push(`${state.openPosSessions} open POS sessions`);
  if (state.activeReconciliations > 0)                 reasons.push(`${state.activeReconciliations} active reconciliations`);
  if (state.pendingWebhooks   > MAX_QUEUE_DEPTH)       reasons.push(`${state.pendingWebhooks} pending webhooks (>${MAX_QUEUE_DEPTH})`);
  return reasons;
}

async function run() {
  const deadline = Date.now() + TIMEOUT * 60_000;
  let attempt    = 0;

  console.log(`\nSOKONI Pre-Deploy Gate — timeout ${TIMEOUT}min\n`);

  while (Date.now() < deadline) {
    attempt++;
    const state   = await checkGate();
    const blocked = isBlocked(state);

    console.log(`[Attempt ${attempt}] ${new Date().toISOString()}`);
    console.table(state);

    if (blocked.length === 0) {
      console.log('\n✅  Gate OPEN — safe to deploy\n');
      process.exit(0);
    }

    console.warn(`\n⏳  Gate BLOCKED:\n  • ${blocked.join('\n  • ')}`);
    console.log(`   Retrying in ${POLL_MS / 1000}s...\n`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  console.error(`\n❌  Gate TIMEOUT after ${TIMEOUT}min — aborting deploy`);
  console.error('   Manual review required before deploying.');
  process.exit(1);
}

run().catch(err => {
  console.error('Gate error:', err.message);
  process.exit(1);
});
