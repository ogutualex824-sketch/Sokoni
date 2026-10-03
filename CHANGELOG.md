## [2026-10-03] - P0-G: the KASS admin agent can no longer approve sellers

Functions only (`kass`, `functions/index.js` executeTool `approve_seller`). Built on 2861c98, which is byte-identical (cmp) to kass's live archive, gen 1787383897310985. **Not deployed.**
- **Before:** `approve_seller {approve:true}` wrote `providers/{id}.status = 'active'` straight from the AI agent, with no decision record and no audit entry. That bypassed applicationDecide.
- **After:**
  - Approval is refused (`APPROVAL_NOT_IN_KASS`), and the reply points the admin to AdminOS → Applications.
  - A missing or non-false `approve` is refused.
  - Suspension (containment) still works, writes an adminAudit `kass_seller_suspend` row, and refuses path-like IDs.
- **Database:** new adminAudit action `kass_seller_suspend`.
- **Deploy:** kass is an Artifact Registry recovery service, so it is rebuilt ONLY under `scripts/infra/recovery-manifest-20260921.json` (one service, nine assertions). It must ship in ONE rebuild together with the separate kass fix adde663 (fix/kass-auth-budget-on-e521e03).
- **Tests:** `scripts/test-kass-approve-seller-retired.js` 5/0. With `BASE=2861c98` it fails 5/5.

