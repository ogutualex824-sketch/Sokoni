/* ============================================================================
   SOKONI Integration Governance — sokoni-integration-governance.js      v1.0.0
   ============================================================================
   WHO IS ACCOUNTABLE FOR EACH INTEGRATION, AND WHO MAY APPROVE A CHANGE TO IT.

   ─────────────────────────────────────────────────────────────────────────
   PROVENANCE — READ THIS BEFORE TRUSTING A VALUE IN THIS FILE
   ─────────────────────────────────────────────────────────────────────────
   Every owner and authority below is an ORGANIZATIONAL GOVERNANCE DECISION.
   None of it is a repository-derived fact.

   The repository can prove that Typesense, Firebase, IntaSend and the rest are
   integrations: their modules exist, their secrets are named, their endpoints
   are called. It CANNOT prove that any particular person holds a particular
   organizational responsibility. No commit, no module path and no vendor string
   establishes who is paged at 02:00 or who may authorise a credential rotation.

   So this file lives apart from `sokoni-integration-catalogue.js` deliberately.
   The catalogue is evidence. This is a decision. Keeping them in one file would
   let a reader assume the same standard of proof applies to both, and it does
   not.

   Recorded 2026-09-21 from an explicit decision by the platform owner. Changing
   a value here is a governance act, not a code change: amend it when the
   organization changes, never to make a gate pass.

   ─────────────────────────────────────────────────────────────────────────
   THE TWO FIELDS ARE NOT SYNONYMS
   ─────────────────────────────────────────────────────────────────────────
     owner       accountable for the integration OPERATING correctly, and for
                 operational follow-up when it fails
     authority   authorised to APPROVE material changes — credentials,
                 lifecycle, configuration

   The person who responds to a failed payment rail is not necessarily the
   person who may rotate its production credential or reopen a frozen one. That
   is why there are two fields and why they must never be collapsed.

   ─────────────────────────────────────────────────────────────────────────
   DECISIONS ARE MADE PER COUNTERPARTY, AND INHERITED
   ─────────────────────────────────────────────────────────────────────────
   One relationship, one owner. The 47 catalogue entries inherit from the 22
   counterparty rows below rather than carrying 47 independent decisions, which
   would be 47 chances to drift.

   An ENTRY OVERRIDE exists only where the organization genuinely splits
   responsibility for one integration. An override is an exception and must say
   why. It is NOT a way to record that a vendor string happens to name several
   companies — see the note on ERP connectors.

   ─────────────────────────────────────────────────────────────────────────
   `NONE — RAIL CLOSED`
   ─────────────────────────────────────────────────────────────────────────
   Valid for `owner` ONLY, and only on a rail whose lifecycle is closed
   (quarantined, frozen, retired). Nobody is operationally accountable because
   nothing is operating.

   It is NEVER valid for `authority`. A closed rail still needs a named person
   who may decide to reopen it. Closed is a lifecycle state, not an ownership
   exemption. `scripts/integration-relationship-census.js` enforces both halves.
   ========================================================================== */
(function () {
  'use strict';

  /* The roles these decisions are expressed in. Named people, because "the
     platform team" is not someone you can page. */
  var CEO = 'CEO — Isaac Ouma Ochieng';
  var COO = 'COO/DPO — Alex Ogutu Ochieng';
  var CFO = 'CFO — Violet Ashitsa Kadiagu';
  var CTO = 'CTO — Donna Obongo';

  /* The sentinel for an operationally unowned CLOSED rail. Not a placeholder:
     it is a decided outcome, and the census treats it as one. */
  var RAIL_CLOSED = 'NONE — RAIL CLOSED';

  /* The sentinel for an UNDECIDED field. Nothing should carry it; the census
     fails on it. It exists so a new counterparty added without a decision is
     visibly undecided rather than silently inheriting someone else's name. */
  var UNASSIGNED = '<UNASSIGNED>';

  /* ── THE DECISION TABLE, keyed by the catalogue's `vendor` ────────────
     The key must match `vendor` exactly. The census fails on a catalogue
     counterparty with no row here, and on a row here matching no counterparty —
     both directions, so neither list can drift silently past the other. */
  var COUNTERPARTIES = {
    "Africa's Talking":                          { owner: CTO, authority: CEO },
    'Algolia':                                   { owner: CTO, authority: CEO },
    'Anthropic':                                 { owner: CTO, authority: CEO },

    /* No acquirer has signed, so there is no relationship to operate. The
       authority is named because reopening this rail is a decision someone must
       be able to take. */
    'Card acquirer (unsigned)':                  { owner: RAIL_CLOSED, authority: CEO,
      note: 'Rail is quarantined and no acquirer has signed. Owner is deliberately ' +
            'NONE: nothing is operating. Authority is named so reopening remains a ' +
            'decision someone can take.' },

    'Cloudflare':                                { owner: CTO, authority: CEO },

    /* A PLACEHOLDER vendor string, not one relationship. Real signing identities
       are HostPinnacle/MailBaby (DKIM selector `default`) and SendGrid (s1/s2).
       A surface owner is assigned; an entry override is NOT required yet, and
       the census does not demand one. Split it when the organization actually
       splits responsibility — not because the string names two parties. */
    'DNS + mail providers':                      { owner: COO, authority: CEO,
      note: 'Surface-level owner. The vendor string is a placeholder covering two real ' +
            'relationships — HostPinnacle/MailBaby and SendGrid. An entry override is a ' +
            'further governance decision, not a consequence of this row.' },

    'Google':                                    { owner: CTO, authority: CEO },
    'Google Cloud':                              { owner: CTO, authority: CEO },
    'Google Firebase':                           { owner: CTO, authority: CEO },
    'HostPinnacle':                              { owner: COO, authority: CEO },

    /* Money. Operational accountability sits with finance; approval with the CEO. */
    'IntaSend':                                  { owner: CFO, authority: CEO },
    'Kenya Revenue Authority':                   { owner: CFO, authority: CEO },

    'Merchant endpoints':                        { owner: CTO, authority: CEO },
    'Meta':                                      { owner: CTO, authority: CEO },
    'Office of the Data Protection Commissioner': { owner: COO, authority: CEO },
    'OpenStreetMap Foundation':                  { owner: CTO, authority: CEO },

    /* Seven vendor names, ONE governance row. Per-ERP overrides are permitted
       where an individual relationship is separately held, but no split is
       created merely because seven names appear in the string. */
    'SAP, Sage, Odoo, Dynamics, QuickBooks, Xero, Zoho': { owner: COO, authority: CEO,
      note: 'Surface owner for the connector layer. ERP-specific overrides are PERMITTED ' +
            'where a relationship is separately held; none is required, and none is ' +
            'implied by the vendor string naming seven companies.' },

    'SMTP host':                                 { owner: CTO, authority: CEO },

    /* No external counterparty. Both fields still apply: internal accountability
       and change authority are separate questions even when the relationship is
       with SOKONI itself. */
    'SOKONI (first-party)':                      { owner: CTO, authority: CEO,
      note: 'First-party. The accountability relationship is with SOKONI itself, so ' +
            'there is no vendor account to hold — which does not remove the need for ' +
            'either field.' },

    'Third-party consumers':                     { owner: CTO, authority: CEO },
    'Twilio SendGrid':                           { owner: COO, authority: CEO },
    'Typesense':                                 { owner: CTO, authority: CEO },
  };

  /* ── ENTRY OVERRIDES ─────────────────────────────────────────────────
     Keyed by integration id. Empty on purpose.

     An override is a governance EXCEPTION: it says this one integration is
     owned differently from the rest of its counterparty's relationship. It must
     carry `why`. The census rejects an override without one, and rejects an
     override whose id is not in the catalogue.

     The DNS/mail and ERP rows above are candidates IF the organization splits
     responsibility. Neither is required, and adding one to satisfy a checker
     rather than to record a decision would make this file evidence of nothing. */
  var OVERRIDES = {
    /* 'some-integration-id': { owner: X, authority: Y, why: 'stated reason' }, */
  };

  /** Resolve governance for one integration. Returns null when the entry is
      unknown, and an object carrying `inherited` so a consumer can tell a
      counterparty decision from an entry exception. */
  function governanceFor (entryOrId, catalogue) {
    var cat = catalogue ||
      (typeof window !== 'undefined' && window.SokoniIntegrationCatalogue) || null;
    var e = (entryOrId && entryOrId.id) ? entryOrId
          : (cat && cat.lookup ? cat.lookup(entryOrId) : null);
    if (!e) return null;

    var over = OVERRIDES[e.id];
    if (over) {
      return { owner: over.owner, authority: over.authority,
               inherited: false, counterparty: e.vendor, why: over.why || '' };
    }
    var row = COUNTERPARTIES[e.vendor];
    if (!row) {
      return { owner: UNASSIGNED, authority: UNASSIGNED, inherited: true,
               counterparty: e.vendor,
               why: 'No governance row exists for this counterparty.' };
    }
    return { owner: row.owner, authority: row.authority, inherited: true,
             counterparty: e.vendor, why: row.note || '' };
  }

  var API = {
    version: '1.0.0',
    counterparties: COUNTERPARTIES,
    overrides: OVERRIDES,
    governanceFor: governanceFor,
    UNASSIGNED: UNASSIGNED,
    RAIL_CLOSED: RAIL_CLOSED,
    roles: { CEO: CEO, COO: COO, CFO: CFO, CTO: CTO },
    /* Stated in the data, not only in a comment, so a consumer that renders
       these values can carry the caveat with them. */
    provenance: 'Organizational governance decisions, not repository-derived facts. ' +
                'The repository can prove an integration exists; it cannot prove who ' +
                'holds a given organizational responsibility.',
  };

  if (typeof window !== 'undefined') window.SokoniIntegrationGovernance = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
