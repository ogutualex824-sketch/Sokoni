/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — EDIT AUTHORITY (client consumer)   P0-F, owner 2026-10-03
   ══════════════════════════════════════════════════════════════════════════════
   ONE pure answer to "may this owner make changes right now?", read ONLY from the
   server's providerDispatch {op:'businessWorkspace'} answer (functions/business-workspace.js)
   plus the signed ID-token claims. Pages render their edit controls read-only from it,
   so a deactivated / suspended / frozen owner is never offered a save the server or the
   rules will refuse.

   RULE (owner, relayed 2026-10-03): anything other than answer.editable === true is
   READ-ONLY.
     editable === true            → editable. The server's answer WINS over the interim
                                    signals below (it already folded freeze/suspension/
                                    deactivation into ownerState).
     editable false / missing /   → read-only. The REASON comes from, in order:
     non-boolean                      1. answer.ownerState (frozen | suspended | deactivated |
                                         unknown | active-but-not-editable)
                                      2. interim (old server, no ownerState): ID-token claim
                                         deactivated === true → deactivated;
                                         approval.state !== 'VALID_APPROVAL' → approval
                                      3. otherwise "status unknown"
     no answer at all             → read-only, "status unknown" (FAILS CLOSED)

   Server contract: approval token 'VALID_APPROVAL' (sokoni-5b f85039a,
   shared/approval-remediation.js STATES.VALID); ownerState + editable (sokoni-5b 1a5c9e5,
   ownerStateOf). This file reads NOTHING but what it is handed — never providers/shops
   fields, never application.status / adminApproved / approvedBy / verified.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var VALID_APPROVAL = 'VALID_APPROVAL';
  var OWNER_STATES = ['active', 'deactivated', 'suspended', 'frozen', 'unknown'];
  var REACTIVATE_HREF = '/profile.html';

  /* Plain words per reason code (owner wording for the four ownerStates). */
  var REASON_TEXT = {
    frozen: 'frozen by SOKONI',
    suspended: 'suspended',
    deactivated: 'deactivated — reactivate your account',
    unknown: 'status unknown',
    not_editable: 'your business status does not allow changes yet',
    approval: 'your business approval is not valid',
    no_answer: 'status unknown'
  };

  function isObj (x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  function readOnly (code, ownerState, source, approvalState) {
    var text = REASON_TEXT[code] || REASON_TEXT.unknown;
    if (code === 'approval' && approvalState) text += ' (' + approvalState + ')';
    return Object.freeze({
      editable: false, readOnly: true, reasonCode: code, reason: text,
      ownerState: ownerState || null, source: source,
      action: code === 'deactivated' ? Object.freeze({ href: REACTIVATE_HREF, label: 'Reactivate your account' }) : null
    });
  }

  /**
   * @param {object|null} answer  the businessWorkspace answer (callable .data), or null when it could not be had
   * @param {object|null} claims  ID-token claims, or null when unreadable
   * @returns {{editable:boolean, readOnly:boolean, reasonCode:string|null, reason:string|null,
   *            ownerState:string|null, source:'server'|'interim'|'none', action:{href,label}|null}}
   */
  function decide (answer, claims) {
    var a = isObj(answer) ? answer : null;
    if (!a) return readOnly('no_answer', null, 'none');
    var os = typeof a.ownerState === 'string' && OWNER_STATES.indexOf(a.ownerState) >= 0 ? a.ownerState : null;

    if (a.editable === true) {
      return Object.freeze({ editable: true, readOnly: false, reasonCode: null, reason: null, ownerState: os || 'active', source: 'server', action: null });
    }
    /* editable false, missing or malformed → READ-ONLY; only the reason is being chosen now. */
    var server = typeof a.editable === 'boolean' || os !== null;
    if (os === 'frozen' || os === 'suspended' || os === 'deactivated' || os === 'unknown') return readOnly(os, os, 'server');
    if (os === 'active') return readOnly('not_editable', os, 'server');
    if (typeof a.ownerState === 'string' && !os) return readOnly('unknown', null, 'server');   /* a state this client does not know */

    /* Interim (an old server that does not send ownerState). */
    var c = isObj(claims) ? claims : null;
    if (c && c.deactivated === true) return readOnly('deactivated', 'deactivated', 'interim');
    var ap = isObj(a.approval) && typeof a.approval.state === 'string' ? a.approval.state : null;
    if (ap !== VALID_APPROVAL) return readOnly('approval', null, 'interim', ap || 'missing');
    return readOnly(server ? 'not_editable' : 'unknown', null, server ? 'server' : 'interim');
  }

  /* The one sentence every page shows next to its disabled controls. */
  function message (d) {
    var r = d && d.reason ? d.reason : REASON_TEXT.unknown;
    return 'Your account can’t make changes right now (' + r + ')';
  }

  var API = Object.freeze({ decide: decide, message: message, VALID_APPROVAL: VALID_APPROVAL,
    OWNER_STATES: OWNER_STATES.slice(), REASON_TEXT: REASON_TEXT, REACTIVATE_HREF: REACTIVATE_HREF });
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SokoniEditAuthority = API;
})(typeof window !== 'undefined' ? window : globalThis);
