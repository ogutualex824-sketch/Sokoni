'use strict';
/**
 * SOKONI Communication Engine — the channel router.
 * ============================================================================================
 * Answers one question: GIVEN that SOKONI has decided to tell someone something, which channel
 * should carry it?
 *
 *     present in-app?   -> in_app          free, instant, already in context
 *     push available?   -> push            cheapest reachable channel
 *     critical?         -> sms             costs money; reserved for consequence
 *     needs a record?   -> email           a receipt someone can keep
 *
 * ── IT IS NOT A SECOND NOTIFICATION AUTHORITY ──────────────────────────────────────────────
 * `notify.js` decides channels from the notification TYPE and owns preferences, quiet hours,
 * dedupe, tokens and the audit log. That stays. This module answers the question notify.js
 * cannot: what should we do given what we now know about REACHABILITY — that this person is
 * looking at the app, or that they have no push token at all.
 *
 * So this returns a PLAN, and a plan is advice. Nothing here sends, nothing here overrides a
 * preference, and a caller that ignores it is not doing anything wrong. When the two are ever
 * wired together, notify.js remains the authority and this becomes its reachability input —
 * not the other way round.
 *
 * ── A NORMAL MESSAGE MUST NOT BECOME AN SMS ────────────────────────────────────────────────
 * This is the rule with a bill attached. SMS costs money per message, and a chat layer that
 * quietly falls back to SMS turns a free conversation into a metered one — usually discovered
 * on an invoice. So `commerce` and `marketing` NEVER route to SMS here, whatever the
 * reachability. Only `critical` may, because critical means security and money: the classes
 * where not arriving is worse than the cost.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require, no environment.
 */

/* Ordered cheapest-and-most-immediate first. The order is the policy. */
const CHANNEL_PREFERENCE = Object.freeze(['in_app', 'push', 'email', 'sms']);

/** Which priorities may ever reach a metered channel. */
const SMS_ELIGIBLE_PRIORITIES = Object.freeze(['critical']);

/** Which priorities are worth an email. `marketing` is included because email is where
 *  marketing belongs — and excluded from everything urgent for the same reason. */
const EMAIL_ELIGIBLE_PRIORITIES = Object.freeze(['critical', 'commerce', 'marketing']);

/**
 * routeFor({ priority, present, hasPushTarget, hasEmail, hasPhone, requiresRecord })
 *   -> { plan, considered, reason }
 *
 * `plan` is the ordered channels worth attempting. `considered` explains every channel that
 * was NOT planned and why, because "we did not text them" is a question someone asks about a
 * bill, and an answer that has to be reconstructed from code is not an answer.
 *
 * FAILS CLOSED on an unknown priority: no plan, stated reason. A message whose consequence
 * nobody has classified must not pick its own channel.
 */
function routeFor(input) {
  const i = input || {};
  const priority = String(i.priority || '');
  const considered = {};
  const plan = [];

  if (!EMAIL_ELIGIBLE_PRIORITIES.includes(priority)) {
    return { plan: [], considered: { all: 'unknown_priority' }, reason: 'unknown_priority' };
  }

  /* IN-APP — free, instant, and already in the business context the message is about. Only
     when the person is actually present; posting to a screen nobody is looking at and calling
     it delivered is the oldest lie in messaging. */
  if (i.present === true) plan.push('in_app');
  else considered.in_app = 'recipient_not_present';

  /* PUSH — the cheapest way to reach someone who is not looking. */
  if (i.hasPushTarget === true) plan.push('push');
  else considered.push = 'no_push_target';

  /* EMAIL — a record the recipient keeps. Planned when they have an address, and required
     outright when the caller says this needs to leave a trail. */
  if (i.hasEmail === true) plan.push('email');
  else considered.email = 'no_email_address';

  /* SMS — metered. The guard with a bill attached. */
  if (!SMS_ELIGIBLE_PRIORITIES.includes(priority)) {
    considered.sms = 'priority_not_sms_eligible';
  } else if (i.hasPhone !== true) {
    considered.sms = 'no_phone_number';
  } else {
    plan.push('sms');
  }

  /* A communication that must leave a record and has no way to do so is a REFUSAL, not a
     best-effort. Reporting "sent" for something that could never be evidenced is how a
     receipt nobody received becomes a dispute nobody can settle. */
  if (i.requiresRecord === true && !plan.includes('email')) {
    return {
      plan: [],
      considered,
      reason: 'record_required_but_no_email',
    };
  }

  return {
    plan: _ordered(plan),
    considered,
    reason: plan.length ? 'route_available' : 'unreachable',
  };
}

function _ordered(plan) {
  return CHANNEL_PREFERENCE.filter((c) => plan.includes(c));
}

/**
 * explain(route) -> string[]
 *
 * Operator-readable lines for a console that has to justify a channel choice. The wording is
 * not the policy; `considered` is.
 */
function explain(route) {
  const r = route || {};
  const out = [];
  (r.plan || []).forEach((c) => out.push(c + ': planned'));
  Object.keys(r.considered || {}).forEach((c) => out.push(c + ': ' + r.considered[c]));
  return out;
}

module.exports = {
  CHANNEL_PREFERENCE,
  SMS_ELIGIBLE_PRIORITIES,
  EMAIL_ELIGIBLE_PRIORITIES,
  routeFor,
  explain,
};
