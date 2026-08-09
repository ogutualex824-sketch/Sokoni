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

# ── Merchant Batch 1 gates ──────────────────────────────────────────────────
run "Merchant route contract (static)"        node scripts/test-merchant-routes.js
run "Returns UI terminal states"              node scripts/test-returns-states.js

# Returns SECURITY rules. The `returns` collection was default-denied in production
# until 2026-08-09; this suite is what proves the replacement rule scopes reads to the
# buyer, the seller and admin — and nobody else. It ALSO checks the composite indexes
# structurally, because the emulator does not enforce them: every query would pass with
# zero indexes declared while production fails with FAILED_PRECONDITION.
#
# HARD PREREQUISITE: the Firestore emulator requires JDK 21+. firebase-tools refuses to
# start on Java < 21. If Java is missing or too old this gate FAILS — it must never
# degrade to a silent skip, because an unexecuted security suite reads exactly like a
# passing one. Provision JDK 21 in CI (e.g. actions/setup-java with java-version: 21).
JAVA_OK=0
if command -v java >/dev/null 2>&1; then
  JAVA_MAJOR="$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
  case "$JAVA_MAJOR" in ''|*[!0-9]*) JAVA_MAJOR=0 ;; esac
  [ "$JAVA_MAJOR" -ge 21 ] && JAVA_OK=1
fi
if [ "$JAVA_OK" -eq 1 ]; then
  run "Returns security rules + indexes (emulator)" \
      npx firebase emulators:exec --only firestore --project sokoni-returns-rules-test \
        "node scripts/test-returns-rules.js"
else
  echo ""
  echo "❌ FAIL — Returns security rules: JDK 21+ required, found '${JAVA_MAJOR:-none}'."
  echo "   The Firestore emulator cannot start, so the returns authorization suite"
  echo "   did NOT run. This is a release prerequisite, not an optional extra."
  FAIL=1
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
