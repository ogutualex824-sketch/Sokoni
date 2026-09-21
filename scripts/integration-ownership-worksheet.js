#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION OWNERSHIP WORKSHEET — scripts/integration-ownership-worksheet.js

   WHAT THIS IS, AND WHAT IT IS NOT
   --------------------------------
   Ownership is a GOVERNANCE FACT. It cannot be measured, inferred from code, or
   derived from a vendor name, and this script does not try. It assigns nothing.

   What it does is make the decision tractable: it gathers, per integration,
   everything the repository DOES know — who the counterparty is, what implements
   it, which credentials it needs, what it writes, and what its lifecycle says —
   so a person can decide ownership with the evidence in front of them instead of
   from memory.

   Every owner column it emits is literally `<UNASSIGNED>`. A placeholder such as
   "Platform" or "Engineering" would satisfy a schema check while telling nobody
   who to call at 02:00, which is the only thing the field is for.

     node scripts/integration-ownership-worksheet.js            # human-readable
     node scripts/integration-ownership-worksheet.js --md       # markdown table
     node scripts/integration-ownership-worksheet.js --json     # machine-readable

   THE DECISION IS SMALLER THAN IT LOOKS
   -------------------------------------
   47 entries do not require 47 decisions. They collapse by COUNTERPARTY — one
   relationship usually has one owner — and the script reports that collapse so
   the real size of the decision is visible before anyone starts.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ARGS = process.argv.slice(2);
const AS_MD   = ARGS.indexOf('--md')   !== -1;
const AS_JSON = ARGS.indexOf('--json') !== -1;
/* The bare decision table, in the form the governance decision is returned in.
   Five columns, every integration named, nothing assigned. */
const AS_DECIDE = ARGS.indexOf('--decide') !== -1;

/* The catalogue is a browser IIFE; load it the way the console does. */
global.window = global.window || {};
require(path.join(ROOT, 'sokoni-integration-catalogue.js'));
const CAT = global.window.SokoniIntegrationCatalogue;

/* The DECIDED values, if any. This file is a decision INPUT; once decisions
   exist they live in the governance module, and this reflects them rather than
   continuing to print a blank form that has been superseded. A worksheet that
   still shows every field unassigned after the decision was made is a stale
   artifact, and a stale artifact is worse than none. */
let GOV = null;
try { GOV = require(path.join(ROOT, 'sokoni-integration-governance.js')); } catch (e) { GOV = null; }

const UNASSIGNED = (GOV && GOV.UNASSIGNED) || '<UNASSIGNED>';
const decided = (party) => (GOV && GOV.counterparties[party]) || null;

/* ── What the repository knows that BEARS on ownership ──────────────────────
   Each of these is a fact, not a suggestion. None of them decides anything. */
function factsFor (e) {
  const ev = e.evidence || {};
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    counterparty: e.vendor,
    direction: e.direction,
    lifecycle: e.status,
    /* Who can CHANGE it — the technical surface. */
    implementedBy: (ev.modules || []).slice(0, 4),
    /* What it needs provisioned — usually a commercial/account relationship. */
    secrets: (ev.secrets || []),
    /* What it can affect — the blast radius, in the platform's own terms. */
    writes: (ev.collections || []),
    endpoints: (ev.endpoints || []),
    /* A first-party rail has an internal owner by definition; an external one
       usually needs BOTH an internal owner and a vendor relationship holder. */
    firstParty: /first-party|^SOKONI/i.test(e.vendor || ''),
    /* Stated so the decision can be deferred honestly where the rail is closed. */
    closed: ['quarantined', 'frozen', 'retired'].indexOf(e.status) !== -1,
    owner: UNASSIGNED,
    authority: UNASSIGNED,
  };
}

const rows = CAT.integrations.map(factsFor);

/* ── The collapse: how many DECISIONS does this actually require? ─────────── */
const byCounterparty = {};
rows.forEach((r) => {
  (byCounterparty[r.counterparty] = byCounterparty[r.counterparty] || []).push(r.id);
});
const parties = Object.keys(byCounterparty).sort();

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: rows.length,
    counterparties: parties.length,
    note: 'Every owner and authority is <UNASSIGNED>. This file assigns nothing.',
    byCounterparty, rows,
  }, null, 2) + '\n');
  process.exit(0);
}

if (AS_DECIDE) {
  const out = [];
  out.push('| Counterparty | Integrations | Owner | Authority | Override |');
  out.push('| --- | --- | --- | --- | --- |');
  parties.forEach((p) => {
    const ids = byCounterparty[p];
    const allClosed = ids.every((id) => rows.find((r) => r.id === id).closed);
    const anyFirst  = ids.some((id) => rows.find((r) => r.id === id).firstParty);
    /* The Override column is pre-seeded ONLY with a flag where the evidence
       says the relationship may not be single — never with a decision. */
    const flag = anyFirst  ? 'first-party (internal)'
               : allClosed ? 'CLOSED — owner may be NONE, authority may not'
               : /,/.test(p) ? 'MULTIPLE PARTIES IN ONE ROW — split?'
               : /^DNS \+ mail/.test(p) ? 'PLACEHOLDER VENDOR — real parties differ'
               : '';
    const d = decided(p);
    out.push('| ' + p + ' | ' + ids.join(' ') + ' | ' +
             (d ? d.owner : '`' + UNASSIGNED + '`') + ' | ' +
             (d ? d.authority : '`' + UNASSIGNED + '`') + ' | ' + flag + ' |');
  });
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

if (AS_MD) {
  const out = [];
  out.push('# Integration ownership — decision worksheet');
  out.push('');
  out.push('Generated by `scripts/integration-ownership-worksheet.js`. **Do not hand-edit.**');
  out.push('The decisions live in `sokoni-integration-governance.js`; regenerate this view.');
  out.push('');
  const anyDecided = parties.some((p2) => !!decided(p2));
  if (anyDecided) {
    out.push('> **These are ORGANIZATIONAL DECISIONS, not repository-derived facts.** The');
    out.push('> repository can name the relationship; it cannot establish who holds the vendor');
    out.push('> account, who is paged, or who may approve a credential rotation. The values');
    out.push('> below were decided by the platform owner and are recorded in');
    out.push('> `sokoni-integration-governance.js`, which is the authority. This document');
    out.push('> is a generated view of that decision.');
  } else {
    out.push('> **Nothing here is assigned.** Ownership is a governance fact. The repository');
    out.push('> can name the relationship; it cannot name who holds the vendor account, who is');
    out.push('> paged, or who may approve a credential rotation. Inferring those from a module');
    out.push('> path would be a guess wearing the authority of a measurement.');
  }
  out.push('');
  out.push('## The two fields are not synonyms');
  out.push('');
  out.push('| Field | Means |');
  out.push('| --- | --- |');
  out.push('| **owner** | Accountable for the integration operating correctly, and for');
  out.push('operational follow-up when it fails. |');
  out.push('| **authority** | Authorised to approve material changes — credentials,');
  out.push('lifecycle, configuration. |');
  out.push('');
  out.push('The person who responds to a failed payment rail may not be the person who may');
  out.push('rotate its production credential or reopen a frozen one.');
  out.push('');
  out.push('## Legal values for a decision column');
  out.push('');
  out.push('| Value | Means |');
  out.push('| --- | --- |');
  out.push('| `<UNASSIGNED>` | **Undecided.** The default, and a gate failure once the');
  out.push('schema lands. |');
  out.push('| a named party | Decided. |');
  out.push('| `NONE — RAIL CLOSED` | **Decided**, and valid for `owner` ONLY on a closed');
  out.push('rail: nobody is operationally accountable because nothing is operating. |');
  out.push('');
  out.push('> `NONE — RAIL CLOSED` is never valid for **authority**. A closed rail still');
  out.push('> needs someone who may decide to reopen it — closed is a lifecycle state, not');
  out.push('> an ownership exemption.');
  out.push('');
  out.push('## Decisions, at counterparty granularity');
  out.push('');
  out.push('Fill these ' + parties.length + ' rows. The ' + rows.length + ' entries inherit');
  out.push('from here; add a per-entry override below only where the relationship genuinely');
  out.push('splits.');
  out.push('');
  out.push('| Counterparty | Entries | Owner | Authority | Scope / override | Decision status |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  parties.forEach((p) => {
    const ids = byCounterparty[p];
    const allClosed = ids.every((id) => rows.find((r) => r.id === id).closed);
    const anyFirst  = ids.some((id) => rows.find((r) => r.id === id).firstParty);
    const note = anyFirst ? 'first-party — internal accountability'
               : allClosed ? 'all entries closed — owner may be NONE, authority may not'
               : 'inherit to all ' + ids.length;
    const d = decided(p);
    out.push('| ' + p + ' | ' + ids.length + ' | ' +
             (d ? d.owner : '`' + UNASSIGNED + '`') + ' | ' +
             (d ? d.authority : '`' + UNASSIGNED + '`') + ' | ' + note + ' | ' +
             (d ? 'DECIDED' : 'UNDECIDED') + ' |');
  });
  out.push('');
  out.push('## Per-entry overrides');
  out.push('');
  out.push('Leave empty unless a counterparty decision genuinely does not hold for one');
  out.push('entry. An override is a governance exception and should say why.');
  out.push('');
  out.push('| Integration | Counterparty | Owner | Authority | Why the override |');
  out.push('| --- | --- | --- | --- | --- |');
  out.push('| _(none yet)_ | | | | |');
  out.push('');
  out.push('## Entries whose lifecycle affects the decision');
  out.push('');
  out.push('| Integration | Lifecycle | Note |');
  out.push('| --- | --- | --- |');
  rows.filter((r) => r.closed || r.firstParty).forEach((r) => {
    out.push('| `' + r.id + '` | ' + r.lifecycle + ' | ' +
      (r.firstParty ? 'first-party: no external counterparty, both fields still required'
                    : 'closed: owner may be NONE, authority must still be named') + ' |');
  });
  out.push('');
  out.push('## Per-entry evidence');
  out.push('');
  out.push('| Integration | Category | Counterparty | Lifecycle | Implemented by | Secrets | Writes |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((r) => {
    out.push('| `' + r.id + '` | ' + r.category + ' | ' + r.counterparty + ' | ' +
      r.lifecycle + (r.closed ? ' **(closed)**' : '') + ' | ' +
      (r.implementedBy.join('<br>') || '—') + ' | ' +
      (r.secrets.join('<br>') || '—') + ' | ' +
      (r.writes.join('<br>') || '—') + ' |');
  });
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

/* ── Human-readable ─────────────────────────────────────────────────────── */
console.log('══════════════════════════════════════════════════════════════════');
console.log('  INTEGRATION OWNERSHIP — DECISION WORKSHEET');
console.log('══════════════════════════════════════════════════════════════════');
console.log('  This script ASSIGNS NOTHING. Every owner reads ' + UNASSIGNED + '.');
console.log('');
console.log('  entries                : ' + rows.length);
console.log('  distinct counterparties: ' + parties.length);
console.log('  first-party rails      : ' + rows.filter((r) => r.firstParty).length +
            '   (internal owner by definition)');
console.log('  deliberately closed    : ' + rows.filter((r) => r.closed).length +
            '   (ownership may be deferred, and that is a decision too)');
console.log('');
console.log('  ── THE DECISION IS SMALLER THAN 47 ──────────────────────────────');
console.log('  One relationship usually has one owner, so the real unit is the');
console.log('  counterparty, not the entry:');
console.log('');
parties.forEach((p) => {
  const ids = byCounterparty[p];
  console.log('  ' + String(ids.length).padStart(2) + '  ' + p);
  console.log('      ' + ids.join(', '));
});
console.log('');
console.log('  ── WHAT THE REPOSITORY CANNOT TELL YOU ──────────────────────────');
console.log('  Who holds the vendor account. Who is paged when it breaks. Who may');
console.log('  approve a credential rotation. None of that is in the code, and');
console.log('  inferring it from a module path would be a guess wearing the');
console.log('  authority of a measurement.');
console.log('══════════════════════════════════════════════════════════════════');
