#!/usr/bin/env bash
# ============================================================================
# SOKONI — Permanent CI Gates
#
#   bash scripts/ci-gates.sh
#
# Any new payment-related code MUST pass the financial gates. Any change to
# Cloud Functions MUST pass the deployment-integrity gate.
#
# Exit 0 = safe to merge / deploy. Exit 1 = blocked.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
run () {
  local name="$1"; shift
  echo ""
  echo "──────────────────────────────────────────────────────────"
  echo "▶ $name"
  echo "──────────────────────────────────────────────────────────"
  if "$@"; then
    echo "✅ PASS — $name"
  else
    echo "❌ FAIL — $name"
    FAIL=1
  fi
}

echo "SOKONI CI GATES"

# ── FINANCIAL (mandatory for any payment-related change) ────────────────────
run "Financial safety audit (static)"      node scripts/audit-financial-safety.js --ci
run "Financial idempotency suite (25)"     node scripts/test-financial-idempotency.js

# ── PLATFORM ───────────────────────────────────────────────────────────────
run "Legal compliance suite (29)"          node scripts/test-legal-compliance.js
run "Architecture invariants"              node scripts/verify-architecture.js
run "CompanyIdentity / brand"              node scripts/verify-company-identity.js

# ── DEPLOYMENT INTEGRITY (requires a live function list) ────────────────────
# Guards against a full `firebase deploy --only functions` silently DELETING
# production functions. Needs: firebase functions:list > .fnlist.txt
if [ -f .fnlist.txt ]; then
  run "Deployment integrity (deployed == runtime-exported)" \
      node scripts/deployment-integrity.js .fnlist.txt --ci
else
  echo ""
  echo "⚠  SKIPPED: deployment integrity — no .fnlist.txt"
  echo "   Before any full functions deploy, run:"
  echo "     firebase functions:list > .fnlist.txt && node scripts/deployment-integrity.js .fnlist.txt --ci"
fi

echo ""
echo "══════════════════════════════════════════════════════════"
if [ "$FAIL" -ne 0 ]; then
  echo "❌ CI GATES FAILED — do not merge or deploy."
  exit 1
fi
echo "✅ ALL CI GATES PASSED"
echo ""
echo "NOTE: passing these gates does NOT clear CB-M1 (money path)."
echo "      Only a live end-to-end financial cycle with captured"
echo "      evidence can do that. See docs/MONEY_PATH_VERIFICATION.md"
exit 0
