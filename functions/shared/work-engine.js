'use strict';
/**
 * SOKONI Work/Job Engine — the ONE category-neutral lifecycle for contracted work (owner architecture 2026-09-28;
 * Marketing campaigns/projects are its first skin, 2026-10-03). PURE: states, who may move what, milestone shape.
 * No Firestore, no money. Money for a milestone is ALWAYS a canonical providerBookings booking created from an accepted
 * service-leads quote (IntaSend → held → completion PIN → settlement → business wallet → receipt). This engine never
 * prices, never charges a fee (campaign / project fees are UNPRICED → disabled) and never credits anyone.
 *
 * STATES   draft → proposed → accepted → active ⇄ paused → completed → archived      (cancelled from any open state)
 * ACTORS   provider (the business doing the work) · customer (who commissioned it) · admin (moderation only)
 * SKINS    marketing: kinds 'campaign' | 'project'. Construction / garage add their own skin + fields on the same record.
 */
const STATES = Object.freeze(['draft', 'proposed', 'accepted', 'active', 'paused', 'completed', 'archived', 'cancelled']);
const OPEN = Object.freeze(['draft', 'proposed', 'accepted', 'active', 'paused']);
const TERMINAL = Object.freeze(['archived', 'cancelled']);
const SKINS = Object.freeze({ marketing: { kinds: ['campaign', 'project'] } });

/* [from, to] → the actors allowed to make that move. Anything absent is refused. */
const MOVES = Object.freeze({
  'draft>proposed': ['provider'],              /* the provider sends the proposal (scope, milestones, budget) */
  'proposed>draft': ['provider'],              /* withdraw to revise */
  'proposed>accepted': ['customer'],           /* acceptance LOCKS the scope + milestone amounts */
  'accepted>active': ['provider'],             /* work starts */
  'active>paused': ['provider', 'customer'],
  'paused>active': ['provider', 'customer'],
  'active>completed': ['customer'],            /* the customer confirms completion of the whole engagement */
  'completed>archived': ['provider', 'customer', 'admin'],
  'draft>cancelled': ['provider'],
  'proposed>cancelled': ['provider', 'customer'],
  'accepted>cancelled': ['provider', 'customer'],
  'active>cancelled': ['admin'],               /* once work has started, only SOKONI (dispute / moderation) cancels */
  'paused>cancelled': ['admin'],
});

class WorkError extends Error { constructor(code, message) { super(message); this.code = code; } }

function canMove(from, to, actor) {
  const who = MOVES[from + '>' + to];
  return !!(who && who.indexOf(actor) >= 0);
}
function assertMove(from, to, actor) {
  if (STATES.indexOf(to) < 0) throw new WorkError('WORK_BAD_STATE', 'Unknown state "' + to + '".');
  if (TERMINAL.indexOf(from) >= 0) throw new WorkError('WORK_TERMINAL', 'This ' + from + ' engagement cannot change.');
  if (!canMove(from, to, actor)) throw new WorkError('WORK_MOVE_REFUSED', 'A ' + actor + ' cannot move this engagement from ' + from + ' to ' + to + '.');
}
/** Scope (title/description/deliverables/milestones/budget) is editable only while the provider still owns the draft. */
const scopeEditable = (status) => status === 'draft';

const _s = (v, max) => (v == null ? '' : String(v).replace(/[<>]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max));
const _cents = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e11) : 0; };
const _date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Milestones: title, due date, deliverables, amount (cents). Status/booking links are SERVER-owned, never accepted here. */
function sanitizeMilestones(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 24).map((m, i) => ({
    id: 'm' + (i + 1),
    title: _s(m && m.title, 160),
    dueDate: _date(m && m.dueDate),
    deliverables: (Array.isArray(m && m.deliverables) ? m.deliverables : []).map((x) => _s(x, 200)).filter(Boolean).slice(0, 12),
    amountCents: _cents(m && m.amountCents),
    status: 'planned',
  })).filter((m) => m.title);
}
function sanitizeScope(d) {
  const x = d || {};
  return {
    title: _s(x.title, 160),
    description: _s(x.description, 4000),
    deliverables: (Array.isArray(x.deliverables) ? x.deliverables : []).map((v) => _s(v, 200)).filter(Boolean).slice(0, 30),
    startDate: _date(x.startDate), endDate: _date(x.endDate),
    milestones: sanitizeMilestones(x.milestones),
  };
}
/** The budget is DERIVED from the milestones — never a separate client number that could disagree with them. */
const budgetOf = (milestones) => (milestones || []).reduce((s, m) => s + (Number(m.amountCents) || 0), 0);

module.exports = { STATES, OPEN, TERMINAL, SKINS, MOVES, WorkError, canMove, assertMove, scopeEditable, sanitizeScope, sanitizeMilestones, budgetOf };
