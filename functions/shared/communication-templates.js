'use strict';
/**
 * SOKONI Communication Engine — the approved template library.
 * ============================================================================================
 * The copy an operator is allowed to send, and the rules that stop it going wrong.
 *
 * ── WHY TEMPLATES, AND WHY APPROVED ────────────────────────────────────────────────────────
 * An admin typing a message to a customer is writing in SOKONI's voice to someone who did not
 * choose to hear from SOKONI. Templates make the common case consistent, reviewable and
 * translatable later, and they make the uncommon case visible: a custom message is still
 * allowed and is RECORDED AS CUSTOM, so "what did we tell people" is answerable.
 *
 * ── A TEMPLATE DECLARES ITS CHANNELS ───────────────────────────────────────────────────────
 * The same words do not work everywhere. An SMS is metered and has no subject line; an email
 * has both and is read minutes later; a push has about forty characters before a phone cuts
 * it off. So a template says which channels it is FOR, and asking for one it does not declare
 * is a refusal rather than a silent reformat — the alternative is a 300-character "email"
 * arriving as three truncated SMS nobody can read.
 *
 * ── A MISSING VARIABLE IS A REFUSAL ────────────────────────────────────────────────────────
 * `render` throws on an unfilled placeholder. The failure mode it exists to prevent is the one
 * everybody has received: "Hi , your order  has been". A blank where a name should be is worse
 * than no message, because it was sent on purpose and reads as contempt.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require. Templates are DATA; sending is notify.js's
 * job and nothing here sends.
 */

/** The groups an operator browses. Mirrors the business vocabulary, not the transport. */
const GROUPS = Object.freeze(['order', 'delivery', 'payment', 'account', 'support']);

/* Placeholders are `{name}`. Deliberately not a template engine: no logic, no loops, no
   conditionals. A template that can branch is a program, and a program in a copy library is a
   thing nobody reviews. */
const _VAR = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Every template names its group, the channels it is valid for, the variables it needs, and
 * the priority its content implies. `priority` is CONTENT-DERIVED and advisory — the router
 * still decides the channel, and `notify.js` still owns preferences and quiet hours.
 *
 * SMS bodies are kept short on purpose: every 160 characters is another message and another
 * charge.
 */
const TEMPLATES = Object.freeze({
  /* ── ORDER ─────────────────────────────────────────────────────────────────────────────── */
  order_received: Object.freeze({
    group: 'order',
    label: 'Order received',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'We have your order {orderRef}',
    body: 'Hi {name}, we have received your order {orderRef} and the seller has been notified.',
  }),
  order_confirmed: Object.freeze({
    group: 'order',
    label: 'Order confirmed',
    channels: Object.freeze(['push', 'email', 'sms', 'in_app']),
    priority: 'commerce',
    subject: 'Order {orderRef} confirmed',
    body: 'Hi {name}, {shop} has confirmed order {orderRef}.',
  }),
  order_delayed: Object.freeze({
    group: 'order',
    label: 'Order delayed',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'Order {orderRef} is delayed',
    body: 'Hi {name}, order {orderRef} is taking longer than expected. {reason}',
  }),
  order_cancelled: Object.freeze({
    group: 'order',
    label: 'Order cancelled',
    channels: Object.freeze(['push', 'email', 'sms', 'in_app']),
    priority: 'commerce',
    subject: 'Order {orderRef} cancelled',
    body: 'Hi {name}, order {orderRef} has been cancelled. {reason}',
  }),

  /* ── DELIVERY ──────────────────────────────────────────────────────────────────────────── */
  rider_assigned: Object.freeze({
    group: 'delivery',
    label: 'Rider assigned',
    channels: Object.freeze(['push', 'sms', 'in_app']),
    priority: 'commerce',
    subject: 'A rider is on the way',
    body: '{name}, a rider has been assigned to {orderRef}.',
  }),
  rider_arriving: Object.freeze({
    group: 'delivery',
    label: 'Rider arriving',
    channels: Object.freeze(['push', 'sms', 'in_app']),
    priority: 'commerce',
    subject: 'Your rider is nearby',
    body: '{name}, your rider is arriving with {orderRef}.',
  }),
  delivery_delayed: Object.freeze({
    group: 'delivery',
    label: 'Delivery delayed',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'Delivery delayed',
    body: 'Hi {name}, the delivery for {orderRef} is delayed. {reason}',
  }),

  /* ── PAYMENT ───────────────────────────────────────────────────────────────────────────── */
  payment_received: Object.freeze({
    group: 'payment',
    label: 'Payment received',
    channels: Object.freeze(['push', 'email', 'sms', 'in_app']),
    /* CRITICAL: money. It reaches someone even at 3am, because not knowing a payment landed
       is worse than being woken. */
    priority: 'critical',
    subject: 'Payment received for {orderRef}',
    body: 'Hi {name}, we have received your payment of {amount} for {orderRef}.',
  }),
  payment_failed: Object.freeze({
    group: 'payment',
    label: 'Payment failed',
    channels: Object.freeze(['push', 'email', 'sms', 'in_app']),
    priority: 'critical',
    subject: 'Payment could not be completed',
    body: 'Hi {name}, the payment for {orderRef} did not go through. {reason}',
  }),
  refund_processed: Object.freeze({
    group: 'payment',
    label: 'Refund processed',
    channels: Object.freeze(['push', 'email', 'sms', 'in_app']),
    priority: 'critical',
    subject: 'Refund sent for {orderRef}',
    body: 'Hi {name}, a refund of {amount} for {orderRef} has been sent.',
  }),

  /* ── ACCOUNT ───────────────────────────────────────────────────────────────────────────── */
  verification_required: Object.freeze({
    group: 'account',
    label: 'Verification required',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'critical',
    subject: 'Verification needed on your SOKONI account',
    body: 'Hi {name}, we need to verify {what} before you can continue.',
  }),
  account_approved: Object.freeze({
    group: 'account',
    label: 'Account approved',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'Your SOKONI account is approved',
    body: 'Hi {name}, your account has been approved. Welcome to SOKONI.',
  }),
  account_restricted: Object.freeze({
    group: 'account',
    label: 'Account restricted',
    channels: Object.freeze(['email', 'in_app']),
    /* EMAIL AND IN-APP ONLY, deliberately. A restriction needs to be explained, and an
       explanation does not fit in a push or an SMS. Telling someone their account is
       restricted in forty characters, with no room for why or what to do, is a notification
       that creates a support case instead of preventing one. */
    priority: 'critical',
    subject: 'Your SOKONI account has been restricted',
    body: 'Hi {name}, your account has been restricted. {reason} '
        + 'You can reply to this message or contact SOKONI support.',
  }),

  /* ── SUPPORT ───────────────────────────────────────────────────────────────────────────── */
  case_received: Object.freeze({
    group: 'support',
    label: 'Case received',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'We have your message ({caseRef})',
    body: 'Hi {name}, we have received your message and opened case {caseRef}.',
  }),
  case_updated: Object.freeze({
    group: 'support',
    label: 'Case updated',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'Update on case {caseRef}',
    body: 'Hi {name}, there is an update on case {caseRef}. {update}',
  }),
  case_resolved: Object.freeze({
    group: 'support',
    label: 'Case resolved',
    channels: Object.freeze(['push', 'email', 'in_app']),
    priority: 'commerce',
    subject: 'Case {caseRef} resolved',
    body: 'Hi {name}, case {caseRef} has been resolved. {resolution}',
  }),
});

const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

/** Extract the placeholders a piece of copy needs. */
function variablesOf(text) {
  const out = [];
  String(text || '').replace(_VAR, (_, name) => { if (out.indexOf(name) === -1) out.push(name); return _; });
  return out;
}

/** Every variable a template needs, across subject and body. */
function requiredVariables(templateId) {
  const t = TEMPLATES[String(templateId || '')];
  if (!t) return [];
  const subj = variablesOf(t.subject);
  const body = variablesOf(t.body);
  return subj.concat(body.filter((v) => subj.indexOf(v) === -1));
}

/** Templates in a group, for an operator browsing. */
function templatesIn(group) {
  const g = String(group || '');
  return TEMPLATE_IDS.filter((id) => TEMPLATES[id].group === g);
}

/**
 * render({ templateId, channel, vars }) -> { subject, body, priority, templateId }
 *
 * THROWS on: unknown template, a channel the template does not declare, and ANY unfilled
 * placeholder. See the header — "Hi , your order  has been" is the failure this prevents, and
 * it can only be prevented by refusing to produce it.
 */
function render(input) {
  const i = input || {};
  const templateId = String(i.templateId || '');
  const t = TEMPLATES[templateId];
  if (!t) throw new Error(`communication-templates: unknown template "${templateId}"`);

  const channel = String(i.channel || '');
  if (!t.channels.includes(channel)) {
    throw new Error(
      `communication-templates: "${templateId}" is not approved for ${channel} `
      + `(approved: ${t.channels.join(', ')})`);
  }

  const vars = i.vars || {};
  const needed = requiredVariables(templateId);
  const missing = needed.filter((v) => {
    const val = vars[v];
    return val === undefined || val === null || String(val).trim() === '';
  });
  if (missing.length) {
    throw new Error(
      `communication-templates: "${templateId}" needs ${missing.join(', ')} — `
      + 'refusing to send copy with a blank where a value should be');
  }

  const fill = (text) => String(text).replace(_VAR, (_, name) => String(vars[name]));

  return {
    templateId,
    channel,
    subject: fill(t.subject),
    body: fill(t.body),
    /* Advisory. The router still chooses the channel and notify.js still owns preferences. */
    priority: t.priority,
    source: 'template',
  };
}

/**
 * describeCustom(text) -> { subject, body, priority, templateId: null, source: 'custom' }
 *
 * A custom message is ALLOWED and is marked as custom, never dressed up as a template. "What
 * did we tell people" must stay answerable, and a custom message that looks approved makes it
 * unanswerable.
 */
function describeCustom(subject, body) {
  const s = String(subject || '').trim();
  const b = String(body || '').trim();
  if (!b) throw new Error('communication-templates: a custom message needs a body');
  return {
    templateId: null,
    subject: s.slice(0, 200),
    body: b.slice(0, 2000),
    priority: 'commerce',
    source: 'custom',
  };
}

module.exports = {
  GROUPS,
  TEMPLATES,
  TEMPLATE_IDS,
  variablesOf,
  requiredVariables,
  templatesIn,
  render,
  describeCustom,
};
