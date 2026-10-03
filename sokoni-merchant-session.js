/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT-V2 PROVIDER SESSION MAPPING  (owner decision 2026-10-03)
   ══════════════════════════════════════════════════════════════════════════════
   ONE shell for merchants AND service providers. When the signed-in account has no
   shop but has providers/{uid}, merchant-v2 opens a PROVIDER session, and this file
   turns the SERVER's workspace answer into the shell's capability list.

   The answer comes from providerDispatch {op:'businessWorkspace'}
   (functions/business-workspace.js workspaceFor + the handler's marketing flag):

     { found, state, reason, message, label, category, route,
       modules: { <key>: { state:'AVAILABLE'|'LOCKED'|…, reason } },
       approval: { state:'VALID_APPROVAL'|… },
       serviceCapabilities: [...],
       marketing: boolean,            ← sokoni-b2, e4f9b7d (server decision record ∩ listing)
       marketingCategories: [ids],
       capabilities?: [...] }         ← optional future server list

   MAPPING (pure; this file reads NOTHING but the answer it is handed):
     'marketing'        iff answer.marketing === true. STRICT boolean — 'true', 1, {}
                        and absence all grant nothing. Never computed from providers
                        fields, never from modules.marketing (that is the provider's OWN
                        promotion module, AVAILABLE for every approved provider — a
                        different thing from being approved to SELL marketing services).
     'module:<key>'     for each modules[key].state === 'AVAILABLE', ONLY when the
                        answer is a routed answer (state 'AVAILABLE') AND the derived
                        approval is VALID_APPROVAL. A holding answer marks overview and
                        settings AVAILABLE; those grant nothing here.
     answer.capabilities  each well-formed string is passed through under the same
                        approval gate — EXCEPT 'marketing', which only the strict
                        boolean above may grant.
   Namespaced 'module:' so a provider module key can never collide with a merchant
   capability name ('sell', …) or a group gate ('marketing').

   Anything unexpected → { ok:false, capabilities:[] } with a reason. Fails CLOSED.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var CAP_RE = /^[a-z][A-Za-z0-9_-]*(:[A-Za-z0-9_-]+)?$/;
  var VALID_APPROVAL = 'VALID_APPROVAL';

  /* Plain words for the server's reason codes — never an internal code alone. The
     server's own `message` wins when it sends one. */
  var REASON_TEXT = {
    NOT_APPROVED: 'your business is not approved yet',
    SUSPENDED: 'your business is suspended',
    UNCLASSIFIED: 'SOKONI is confirming what kind of business you are',
    NO_APPROVED_BUSINESS: 'you do not have an approved business on SOKONI yet',
    APPROVAL_UNREADABLE: 'your approval record could not be read just now',
    CAPABILITY_UNREADABLE: 'your business record could not be read just now',
    CAPABILITY_CONFLICT: 'your business records need a SOKONI review',
    CATEGORY_CAPABILITY_DISAGREEMENT: 'your business records need a SOKONI review',
    REFUSED: 'SOKONI did not approve this business record',
    CLEANUP_OWNED: 'your business record is under SOKONI review',
    'workspace-malformed': 'the workspace answer could not be understood',
    'workspace-unavailable': 'the workspace service did not answer',
  };

  function reasonText (code, message) {
    if (typeof message === 'string' && message.trim()) return message.trim();
    var c = String(code || '');
    if (REASON_TEXT[c]) return REASON_TEXT[c];
    if (/^workspace-/.test(c)) return 'the workspace service refused (' + c.replace(/^workspace-/, '') + ')';
    return c ? 'the server answered ' + c : 'no reason was given';
  }

  /* The ONE honest notice for a provider session without a workspace. */
  function notice (code, message) {
    var t = reasonText(code, message);
    return "Your provider workspace isn't available yet — " + t + (/[.!?]$/.test(t) ? '' : '.');
  }

  function mapWorkspace (answer) {
    var a = answer;   /* the callable's .data — the shell unwraps it, this never guesses */
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return { ok: false, capabilities: [], reason: 'workspace-malformed', notice: notice('workspace-malformed'), workspace: null };
    }
    var caps = [];
    var add = function (c) { if (caps.indexOf(c) < 0) caps.push(c); };

    /* Marketing: the strict boolean, and only that. */
    if (a.marketing === true) add('marketing');

    var approvalOk = !!(a.approval && typeof a.approval === 'object' && a.approval.state === VALID_APPROVAL);
    var routed = a.state === 'AVAILABLE';
    var modulesOk = a.modules && typeof a.modules === 'object' && !Array.isArray(a.modules);

    if (approvalOk && routed && modulesOk) {
      Object.keys(a.modules).forEach(function (k) {
        var m = a.modules[k];
        if (m && m.state === 'AVAILABLE' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(k)) add('module:' + k);
      });
      if (Array.isArray(a.capabilities)) {
        a.capabilities.forEach(function (c) {
          if (typeof c === 'string' && c !== 'marketing' && CAP_RE.test(c)) add(c);
        });
      }
    }

    var cats = (a.marketing === true && Array.isArray(a.marketingCategories))
      ? a.marketingCategories.filter(function (x) { return typeof x === 'string' && x; }) : [];
    var workspace = Object.freeze({
      state: typeof a.state === 'string' ? a.state : null,
      reason: typeof a.reason === 'string' ? a.reason : null,
      label: typeof a.label === 'string' ? a.label : null,
      category: typeof a.category === 'string' ? a.category : null,
      approval: approvalOk ? VALID_APPROVAL : ((a.approval && typeof a.approval.state === 'string') ? a.approval.state : null),
      marketing: a.marketing === true,
      marketingCategories: Object.freeze(cats.slice()),
    });

    if (!modulesOk && a.marketing !== true) {
      return { ok: false, capabilities: [], reason: 'workspace-malformed', notice: notice('workspace-malformed'), workspace: workspace };
    }
    if (!caps.length) {
      var code = !approvalOk && a.approval && a.approval.state ? (a.reason || a.approval.state) : (a.reason || a.state || 'workspace-empty');
      return { ok: false, capabilities: [], reason: String(code), notice: notice(code, a.message), workspace: workspace };
    }
    /* A provider with the marketing grant but a held workspace still gets a notice: the
       marketing group opens, the rest of their workspace does not, and they are told why. */
    var held = !(approvalOk && routed);
    return { ok: true, capabilities: caps, reason: held ? String(a.reason || a.state || 'held') : null,
             notice: held ? notice(a.reason || a.state, a.message) : null, workspace: workspace };
  }

  /* Display name from the providers doc (read-only). null — never a placeholder — when
     it carries none; the shell then shows the account email. */
  function providerDisplayName (doc) {
    var d = doc || {};
    var n = String(d.name || d.businessName || d.displayName || '').trim();
    return n || null;
  }

  var API = { mapWorkspace: mapWorkspace, notice: notice, reasonText: reasonText,
              providerDisplayName: providerDisplayName, VALID_APPROVAL: VALID_APPROVAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SokoniMerchantSession = API;
})(typeof window !== 'undefined' ? window : globalThis);
