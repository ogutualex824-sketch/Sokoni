/* ============================================================================
   SOKONI Admin Navigation Registry — sokoni-admin-nav.js
   ============================================================================
   ONE authoritative definition of the platform-admin workspace. Every confirmed
   admin page consumes this; none of them hand-maintains a menu.

   WHY A REGISTRY RATHER THAN A MENU PER PAGE
   ------------------------------------------
   SOKONI is flat multi-page HTML with no router and no build step, so there is
   no framework-level shell enforcing consistency. Before this file, ~50 admin
   consoles each invented their own navigation or had none, and 17 of them were
   reachable only by typing the URL. A menu item could not be corrected without
   editing dozens of documents.

   MEMBERSHIP IS EVIDENCE-BASED, NOT NAME-BASED
   --------------------------------------------
   Every page here enforces a platform admin claim. Membership was decided by
   what a page ENFORCES and what it READS — never by its filename. That
   distinction is load-bearing:

     staff-management.html   queries `businesses where ownerId == uid`  -> BUSINESS OWNER
     minishop-admin.html     "My MiniShop — SOKONI Seller", keyed shopId -> BUSINESS OWNER
     pos-staff-ops.html      SmartPOS shift/till session                 -> POS STAFF
     seller-wallet.html      accepts claims.seller OR admin              -> MERCHANT
     pos-live-floor.html     SmartPOS floor view                         -> POS STAFF
     pos-till-manager.html   SmartPOS register                           -> POS STAFF
     pos-cash-manager.html   SmartPOS cash office                        -> POS STAFF
     seller-analytics.html   merchant analytics                          -> MERCHANT
     profile.html            customer account surface                    -> CUSTOMER

   None of those belong here, and admitting one would break that workspace. A
   page containing admin-related terminology is not a platform-admin page.

   DELIBERATELY EXCLUDED, PENDING A DECISION
   -----------------------------------------
     platform-hub.html — gates on `claims.role` only, and the semantics of that
     claim are not established. "Hub Operator Portal" may be a hub-operator
     surface rather than platform administration. It stays OUT of admin
     navigation until its role contract is proven. Do not add it on the strength
     of its name.

   SECTIONS ARE A CONTRACT, NOT A KEYWORD BUCKET
   ---------------------------------------------
   A page is not filed under Finance because it contains the word "payment", nor
   under Commerce because it says "subscription". Each entry carries explicit
   metadata — section, parent, authority, workspace, mobile priority, aliases —
   so placement is reviewable and a later move is a one-line change here.

   USAGE
     <script src="/sokoni-admin-nav.js"></script>
     SokoniAdminNav.render();              // header + sidebar + breadcrumbs
     SokoniAdminNav.current();             // this page's registry entry
   ========================================================================== */
(function () {
  'use strict';

  var HOME = 'admin-os.html';   /* the admin workspace root */

  /* ── sections ───────────────────────────────────────────────────────────
     `order` drives both sidebar order and mobile collapse order. */
  var SECTIONS = [
    { id: 'operations',  label: 'Operations',             order: 1 },
    { id: 'commerce',    label: 'Commerce',               order: 2 },
    { id: 'trust',       label: 'Trust & Safety',         order: 3 },
    { id: 'platform',    label: 'Platform',               order: 4 },
    { id: 'finance',     label: 'Finance',                order: 5 },
    { id: 'enterprise',  label: 'Enterprise & Compliance',order: 6 },
    { id: 'administration', label: 'Administration',      order: 7 },
  ];

  /* ── pages ──────────────────────────────────────────────────────────────
     page      file name as served (cleanUrls strips .html)
     path      canonical route
     label     menu text
     section   section id
     parent    the page one level up; null for the workspace root
     authority 'admin' | 'superAdmin' | 'moderator' — the claim REQUIRED
     workspace always 'platform-admin' here; kept explicit so a future
               merchant/POS registry can share this shape
     mobile    1 = keep visible on the smallest viewport, 3 = collapse first
     aliases   legacy/duplicate routes that should resolve to this entry
     note      why it is filed here, when that is not self-evident            */
  var PAGES = [
    /* ── Operations ── */
    { page:'admin-os.html', path:'/admin-os', label:'Operations Console', section:'operations', parent:null, authority:'admin', mobile:1,
      note:'Admin workspace root — every other admin page parents here.' },
    { page:'admin.html', path:'/admin', label:'Admin Panel', section:'operations', parent:HOME, authority:'admin', mobile:1 },
    { page:'ops-center.html', path:'/ops-center', label:'Operations Center', section:'operations', parent:HOME, authority:'admin', mobile:1 },
    { page:'ops-dashboard.html', path:'/ops-dashboard', label:'Ops Dashboard', section:'operations', parent:'ops-center.html', authority:'admin', mobile:2,
      note:'Overlaps Operations Center; consolidation candidate (audit B1).' },
    { page:'reliability-center.html', path:'/reliability-center', label:'Reliability', section:'operations', parent:HOME, authority:'admin', mobile:2 },
    { page:'monitor.html', path:'/monitor', label:'Platform Monitor', section:'operations', parent:HOME, authority:'admin', mobile:2 },
    { page:'fleet-monitor.html', path:'/fleet-monitor', label:'Fleet Monitor', section:'operations', parent:HOME, authority:'admin', mobile:3 },
    { page:'merchant-pipeline.html', path:'/merchant-pipeline', label:'Merchant Pipeline', section:'operations', parent:HOME, authority:'admin', mobile:2,
      note:'Platform-side merchant onboarding review — NOT a merchant tool.' },

    /* ── Commerce ── */
    { page:'admin-subscriptions.html', path:'/admin-subscriptions', label:'Subscriptions', section:'commerce', parent:HOME, authority:'admin', mobile:2 },
    { page:'subscription-os.html', path:'/subscription-os', label:'Subscription OS', section:'commerce', parent:'admin-subscriptions.html', authority:'superAdmin', mobile:3,
      note:'Filed under Commerce/Subscriptions by ruling. Requires superAdmin — its title says Super Admin.' },
    { page:'subscription-billing.html', path:'/subscription-billing', label:'Subscription Billing', section:'commerce', parent:'admin-subscriptions.html', authority:'admin', mobile:3 },
    { page:'sasos-admin.html', path:'/sasos-admin', label:'SASOS (Subscription OS)', section:'commerce', parent:'admin-subscriptions.html', authority:'admin', mobile:3,
      note:'Universal Subscription OS — subscriptions, not generic platform control.' },
    { page:'automation-center.html', path:'/automation-center', label:'Automation', section:'commerce', parent:HOME, authority:'admin', mobile:3 },

    /* ── Trust & Safety ── */
    { page:'trust-safety.html', path:'/trust-safety', label:'Trust & Safety', section:'trust', parent:HOME, authority:'admin', mobile:1,
      note:'The ADMIN console. trust.html and trust-and-safety.html are PUBLIC pages — not here.' },
    { page:'moderation.html', path:'/moderation', label:'Moderation', section:'trust', parent:'trust-safety.html', authority:'moderator', mobile:1 },
    { page:'verification-admin.html', path:'/verification-admin', label:'Verification', section:'trust', parent:'trust-safety.html', authority:'admin', mobile:2 },
    { page:'security-center.html', path:'/security-center', label:'Security Operations', section:'trust', parent:'trust-safety.html', authority:'admin', mobile:2 },
    { page:'security-zero-trust-dashboard.html', path:'/security-zero-trust-dashboard', label:'Zero Trust', section:'trust', parent:'security-center.html', authority:'admin', mobile:3 },

    /* ── Platform ── */
    { page:'platform-health.html', path:'/platform-health', label:'Platform Health', section:'platform', parent:HOME, authority:'admin', mobile:1 },
    { page:'platform.html', path:'/platform', label:'Platform Operations', section:'platform', parent:HOME, authority:'admin', mobile:2 },
    { page:'admin-messages.html', path:'/admin-messages', label:'Messages', section:'platform', parent:HOME, authority:'admin', mobile:2,
      aliases:['messages-admin.html'],
      note:'Canonical of the messages pair; messages-admin.html is the duplicate (audit B1).' },
    { page:'messages-admin.html', path:'/messages-admin', label:'Communications (legacy)', section:'platform', parent:'admin-messages.html', authority:'admin', mobile:3, duplicateOf:'admin-messages.html' },
    { page:'admin-feedback.html', path:'/admin-feedback', label:'Feedback Triage', section:'platform', parent:HOME, authority:'admin', mobile:2 },
    { page:'async-jobs.html', path:'/async-jobs', label:'Async Jobs', section:'platform', parent:HOME, authority:'admin', mobile:3 },
    { page:'redis-monitor.html', path:'/redis-monitor', label:'Redis Monitor', section:'platform', parent:HOME, authority:'admin', mobile:3 },
    { page:'search-quality.html', path:'/search-quality', label:'Search Quality', section:'platform', parent:HOME, authority:'admin', mobile:3 },
    { page:'beta-control.html', path:'/beta-control', label:'Beta Control', section:'platform', parent:HOME, authority:'admin', mobile:2,
      note:'beta.html is the PUBLIC invite page — not here.' },
    { page:'beta-dashboard.html', path:'/beta-dashboard', label:'Beta Dashboard', section:'platform', parent:'beta-control.html', authority:'admin', mobile:3 },
    { page:'executive-dashboard.html', path:'/executive-dashboard', label:'Executive BI', section:'platform', parent:HOME, authority:'admin', mobile:2 },
    /* Release Operations — a named group inside Platform, per ruling. */
    { page:'release-readiness.html', path:'/release-readiness', label:'Release Readiness', section:'platform', group:'Release Operations', parent:HOME, authority:'admin', mobile:2 },
    { page:'launch-readiness.html', path:'/launch-readiness', label:'Launch Readiness', section:'platform', group:'Release Operations', parent:'release-readiness.html', authority:'admin', mobile:3 },
    { page:'launch-metrics.html', path:'/launch-metrics', label:'Launch Metrics', section:'platform', group:'Release Operations', parent:'release-readiness.html', authority:'admin', mobile:3 },
    { page:'uat-center.html', path:'/uat-center', label:'UAT Center', section:'platform', group:'Release Operations', parent:'release-readiness.html', authority:'admin', mobile:3 },

    /* ── Finance ── */
    { page:'financial-os.html', path:'/financial-os', label:'Financial OS', section:'finance', parent:HOME, authority:'admin', mobile:1 },
    { page:'finos-admin.html', path:'/finos-admin', label:'Financial Admin', section:'finance', parent:'financial-os.html', authority:'admin', mobile:2,
      note:'Was an UNREACHABLE PARENT: 0 inbound, yet sole parent of commission-admin and admin-subscriptions (audit C1).' },
    { page:'fos-admin.html', path:'/fos-admin', label:'FOS Admin', section:'finance', parent:'financial-os.html', authority:'admin', mobile:3 },
    { page:'revenue.html', path:'/revenue', label:'Revenue Engine', section:'finance', parent:HOME, authority:'admin', mobile:2 },
    { page:'revenue-dashboard.html', path:'/revenue-dashboard', label:'Revenue Dashboard', section:'finance', parent:'revenue.html', authority:'admin', mobile:3 },
    { page:'commission-admin.html', path:'/commission-admin', label:'Commissions', section:'finance', parent:'finos-admin.html', authority:'admin', mobile:2,
      note:'Parented under finos-admin, not the console root. The pre-registry link graph had ' +
           'finos-admin as the ONLY inbound source for this page (audit C1), so that was the ' +
           'author\'s intended relationship — the defect was that finos-admin itself had zero ' +
           'inbound, making the whole subtree unreachable. Restoring the parent while giving ' +
           'finos-admin a real place (admin-os -> financial-os -> finos-admin) makes the chain ' +
           'navigable in BOTH directions without inventing a redirect.' },
    { page:'commission-engine.html', path:'/commission-engine', label:'Commission Engine', section:'finance', parent:'commission-admin.html', authority:'admin', mobile:3 },
    { page:'settlement-dashboard.html', path:'/settlement-dashboard', label:'Settlements', section:'finance', parent:HOME, authority:'admin', mobile:2 },
    { page:'sfos-monitor.html', path:'/sfos-monitor', label:'SFOS Monitor', section:'finance', parent:'financial-os.html', authority:'admin', mobile:3 },
    { page:'etims-admin.html', path:'/etims-admin', label:'eTIMS', section:'finance', parent:HOME, authority:'admin', mobile:2,
      note:'Its gate checked claims.isAdmin — a claim SOKONI never mints — so it denied EVERYONE until fixed.' },

    /* ── Enterprise & Compliance ── */
    { page:'enterprise-ops.html', path:'/enterprise-ops', label:'Enterprise Operations', section:'enterprise', parent:HOME, authority:'admin', mobile:2 },
    { page:'enterprise-certification.html', path:'/enterprise-certification', label:'Certification', section:'enterprise', parent:'enterprise-ops.html', authority:'admin', mobile:3 },
    { page:'franchise.html', path:'/franchise', label:'Franchise', section:'enterprise', parent:'enterprise-ops.html', authority:'admin', mobile:3 },
    { page:'legal-admin.html', path:'/legal-admin', label:'Legal', section:'enterprise', parent:HOME, authority:'admin', mobile:2 },
    { page:'security-compliance.html', path:'/security-compliance', label:'Compliance', section:'enterprise', parent:'legal-admin.html', authority:'admin', mobile:3 },

    /* ── Administration ── */
    { page:'super-admin.html', path:'/super-admin', label:'Super Admin', section:'administration', parent:HOME, authority:'superAdmin', mobile:1,
      aliases:['superadmin.html'],
      note:'Canonical super-admin console — enforces superAdmin STRICTLY.' },
    { page:'superadmin.html', path:'/superadmin', label:'Super Admin Console (legacy)', section:'administration', parent:'super-admin.html', authority:'superAdmin', mobile:3,
      duplicateOf:'super-admin.html',
      /* LEGACY — migration target is super-admin.html. NO NEW INBOUND REFERENCES.
         Enforced by scripts/validate-admin-nav.js, which fails the build if any page
         links here. The single historical reference (admin.html:783) was migrated
         2026-08-26.

         Retirement is a CONTROLLED migration, not a deletion:
           1. keep /superadmin reachable        (now)
           2. remove its service-worker precache entry (service-worker.js:132)
           3. deploy a ONE-HOP redirect to super-admin.html — never via admin.html
           4. verify the legacy destination is no longer consumed
           5. only then remove the implementation
         Steps 2-5 need an explicit deployment decision; nothing is deleted on assumption.

         Do NOT repair its E1 (setUserRole sends {email} where the server wants {uid})
         or E2 (suspend writes a Firestore flag instead of calling the CF that disables
         the account) defects. It is being retired; fixing its write paths to make a
         certification green would expand scope for a surface we do not rely on. Its
         certification records the legacy surface's STATE, nothing more. */
      legacy: true,
      migrateTo: 'super-admin.html',
      note: 'LEGACY. Gate accepts admin OR superAdmin — weaker than its own contract (audit D4). ' +
            'Both its write paths are defective (E1, E2) and are deliberately NOT repaired. ' +
            'See docs/ADMIN_SUPERADMIN_DUPLICATE_DECISION.md.' },
  ];

  /* ── indexes ────────────────────────────────────────────────────────────── */
  var byPage = {};
  var byAlias = {};
  PAGES.forEach(function (p) {
    p.workspace = 'platform-admin';
    byPage[p.page] = p;
    (p.aliases || []).forEach(function (a) { byAlias[a] = p; });
  });

  function normalise(x) {
    var s = String(x || '').split('#')[0].split('?')[0];
    s = s.substring(s.lastIndexOf('/') + 1);
    if (!s) return '';
    return /\.html$/.test(s) ? s : s + '.html';
  }

  /** The registry entry for a page (defaults to the current document). */
  function lookup(file) {
    var f = normalise(file || location.pathname);
    return byPage[f] || byAlias[f] || null;
  }

  /** Ancestor chain, workspace root first, current page last. */
  function trail(file) {
    var e = lookup(file), out = [], guard = 0;
    while (e && guard++ < 12) { out.unshift(e); e = e.parent ? byPage[e.parent] : null; }
    return out;
  }

  /** Same-section pages, excluding the page itself and legacy duplicates. */
  function siblings(file) {
    var e = lookup(file);
    if (!e) return [];
    return PAGES.filter(function (p) {
      return p.section === e.section && p.page !== e.page && !p.duplicateOf;
    });
  }

  function section(id) {
    return SECTIONS.filter(function (s) { return s.id === id; })[0] || null;
  }

  /** Pages in a section, mobile-priority then label. */
  function pagesIn(id, opts) {
    var o = opts || {};
    return PAGES.filter(function (p) {
      if (p.section !== id) return false;
      if (p.duplicateOf && !o.includeDuplicates) return false;
      if (o.maxMobile && p.mobile > o.maxMobile) return false;
      return true;
    }).sort(function (a, b) { return (a.mobile - b.mobile) || a.label.localeCompare(b.label); });
  }

  /* ── workspace marker ───────────────────────────────────────────────────
     Stamped on <html> the moment this registry loads (synchronously, in <head>,
     before <body> exists) IF and ONLY IF the current document is a registered
     admin surface.

     Driving it from the REGISTRY rather than hand-adding an attribute per page
     is the point: membership here is what marks the workspace, so a future admin
     page cannot forget the marker, and a NON-admin page cannot acquire it by
     copying markup. Removing a page from the registry removes its marker too.

     CONTRACT — consumers of this marker:
       security.js does not mount the consumer consent banner (#_sokoniPrivacyBanner)
       in this workspace. Consent logic, consentRecords, and every consumer,
       seller and POS surface are UNCHANGED. This is scoped suppression of one
       banner in one authenticated workspace, not a global opt-out: the banner is
       fixed at z-index 300001 and covers the admin hamburger at 390/360px, which
       violates the admin responsive contract (fixed UI must never cover a
       control). It is prevented from MOUNTING rather than hidden after the fact,
       so no inaccessible interactive consent surface is ever created. */
  try {
    if (lookup()) {
      document.documentElement.setAttribute('data-sokoni-workspace', 'admin');
    }
  } catch (e) { /* never let a marker failure break the registry */ }

  window.SokoniAdminNav = {
    version:  '1.0.0',
    /** True when the current document is inside the platform-admin workspace. */
    isAdminWorkspace: function () {
      return document.documentElement.getAttribute('data-sokoni-workspace') === 'admin';
    },
    home:     HOME,
    sections: SECTIONS,
    pages:    PAGES,
    lookup:   lookup,
    current:  function () { return lookup(); },
    trail:    trail,
    siblings: siblings,
    section:  section,
    pagesIn:  pagesIn,
    /* True when the current document is a registered admin surface. Pages use
       this to decide whether to render admin chrome at all. */
    isAdminPage: function () { return !!lookup(); },
  };
})();
