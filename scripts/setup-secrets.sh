#!/usr/bin/env bash
# setup-secrets.sh — Set all required Firebase Secret Manager secrets for SOKONI
# Run once per environment: bash scripts/setup-secrets.sh
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project sokoni-aeb26
#   firebase login
#
# Usage:
#   bash scripts/setup-secrets.sh                    # interactive prompts
#   SENDGRID_KEY=SG.xxx bash scripts/setup-secrets.sh  # env-var mode (CI)

set -euo pipefail
PROJECT_ID="sokoni-aeb26"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   SOKONI Secret Manager Setup                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

_set_secret() {
  local name="$1"
  local value="$2"
  local desc="$3"

  if [ -z "$value" ]; then
    echo ""
    echo "[$name] $desc"
    read -rsp "Enter value (input hidden): " value
    echo ""
  fi

  if [ -z "$value" ]; then
    echo "  ⚠  Skipped: $name (empty value)"
    return
  fi

  echo -n "  Setting $name ... "
  # Create or update — if secret exists, add new version; else create
  if gcloud secrets describe "$name" --project="$PROJECT_ID" &>/dev/null; then
    printf '%s' "$value" | gcloud secrets versions add "$name" \
      --data-file=- --project="$PROJECT_ID" --quiet
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --data-file=- --project="$PROJECT_ID" --quiet
  fi
  echo "done"
}

# ── SENDGRID ──────────────────────────────────────────────────────────────────
echo "── Email (SendGrid) ──────────────────────────────────────"
_set_secret "SENDGRID_API_KEY" "${SENDGRID_KEY:-}" \
  "SendGrid API key (starts with SG.) — get from app.sendgrid.com → API Keys"

_set_secret "MAIL_HOST" "${MAIL_HOST:-smtp.sendgrid.net}" \
  "SMTP host (default: smtp.sendgrid.net)"

_set_secret "MAIL_USER" "${MAIL_USER:-apikey}" \
  "SMTP user (default: apikey for SendGrid)"

_set_secret "MAIL_PASS" "${MAIL_PASS:-}" \
  "SMTP password — same as SENDGRID_API_KEY for SendGrid"

# ── LOYALTY HMAC ──────────────────────────────────────────────────────────────
echo ""
echo "── Loyalty QR Signing ────────────────────────────────────"
if [ -z "${LOYALTY_HMAC_SECRET:-}" ]; then
  # Auto-generate a cryptographically secure 32-byte key
  LOYALTY_HMAC_SECRET=$(openssl rand -hex 32)
  echo "  Generated random LOYALTY_HMAC_SECRET: ${LOYALTY_HMAC_SECRET}"
fi
_set_secret "LOYALTY_HMAC_SECRET" "$LOYALTY_HMAC_SECRET" \
  "HMAC secret for signing loyalty QR codes and offline POS transactions"

# ── ANTHROPIC ─────────────────────────────────────────────────────────────────
echo ""
echo "── AI (Anthropic) ────────────────────────────────────────"
_set_secret "ANTHROPIC_API_KEY" "${ANTHROPIC_API_KEY:-}" \
  "Anthropic API key (starts with sk-ant-) — required for KASS and AI insights"

# ── INTASEND ──────────────────────────────────────────────────────────────────
echo ""
echo "── Payments (IntaSend) ───────────────────────────────────"
_set_secret "INTASEND_API_KEY" "${INTASEND_API_KEY:-}" \
  "IntaSend live API key — get from sandbox.intasend.com → API Keys"

_set_secret "INTASEND_PRIVATE_KEY" "${INTASEND_PRIVATE_KEY:-}" \
  "IntaSend private RSA key (PEM format) — for webhook verification"

# ── ALGOLIA ───────────────────────────────────────────────────────────────────
echo ""
echo "── Search (Algolia) ──────────────────────────────────────"
_set_secret "ALGOLIA_ADMIN_KEY" "${ALGOLIA_ADMIN_KEY:-}" \
  "Algolia admin API key — get from algolia.com → API Keys"

# ── SOKONI HMAC ───────────────────────────────────────────────────────────────
echo ""
echo "── Platform HMAC ─────────────────────────────────────────"
if [ -z "${SOKONI_HMAC_KEY:-}" ]; then
  SOKONI_HMAC_KEY=$(openssl rand -hex 32)
  echo "  Generated random SOKONI_HMAC_KEY: ${SOKONI_HMAC_KEY}"
fi
_set_secret "SOKONI_HMAC_KEY" "${SOKONI_HMAC_KEY:-}" \
  "Platform HMAC key for webhook verification and internal signing"

# ── COMMERCE OS ───────────────────────────────────────────────────────────────
echo ""
echo "── Commerce OS Secrets ───────────────────────────────────"
if [ -z "${PAYMENT_HMAC_SECRET:-}" ]; then
  PAYMENT_HMAC_SECRET=$(openssl rand -hex 32)
  echo "  Generated random PAYMENT_HMAC_SECRET: ${PAYMENT_HMAC_SECRET}"
fi
_set_secret "PAYMENT_HMAC_SECRET" "${PAYMENT_HMAC_SECRET:-}" \
  "HMAC secret for payment state-machine event signing"

if [ -z "${PAYROLL_ENCRYPTION_KEY:-}" ]; then
  PAYROLL_ENCRYPTION_KEY=$(openssl rand -hex 32)
  echo "  Generated random PAYROLL_ENCRYPTION_KEY: ${PAYROLL_ENCRYPTION_KEY}"
fi
_set_secret "PAYROLL_ENCRYPTION_KEY" "${PAYROLL_ENCRYPTION_KEY:-}" \
  "AES-256 key for encrypting payroll data at rest"

# ── eTIMS / KRA ───────────────────────────────────────────────────────────────
echo ""
echo "── eTIMS / KRA (Tax Compliance) ──────────────────────────"
_set_secret "ETIMS_CLIENT_ID" "${ETIMS_CLIENT_ID:-}" \
  "KRA eTIMS client ID — from KRA eTIMS registration portal"

_set_secret "ETIMS_CLIENT_SECRET" "${ETIMS_CLIENT_SECRET:-}" \
  "KRA eTIMS client secret — from KRA eTIMS registration portal"

_set_secret "KRA_PIN" "${KRA_PIN:-}" \
  "Bravilex Systems Ltd KRA PIN — for eTIMS and tax filing"

# ── VERIFICATION ──────────────────────────────────────────────────────────────
echo ""
echo "── Verifying secrets ─────────────────────────────────────"
REQUIRED=(
  SENDGRID_API_KEY
  LOYALTY_HMAC_SECRET
  ANTHROPIC_API_KEY
  INTASEND_API_KEY
  INTASEND_PRIVATE_KEY
  PAYMENT_HMAC_SECRET
  PAYROLL_ENCRYPTION_KEY
  ETIMS_CLIENT_ID
  ETIMS_CLIENT_SECRET
  KRA_PIN
)
ALL_OK=true
for secret in "${REQUIRED[@]}"; do
  if gcloud secrets versions access latest --secret="$secret" --project="$PROJECT_ID" &>/dev/null; then
    echo "  ✓ $secret"
  else
    echo "  ✗ $secret — NOT SET (required)"
    ALL_OK=false
  fi
done

echo ""
if [ "$ALL_OK" = true ]; then
  echo "✅ All required secrets are set. Safe to deploy Cloud Functions."
else
  echo "⚠  Some required secrets are missing. Functions using those secrets will fail on cold start."
fi

echo ""
echo "Next steps:"
echo "  firebase deploy --only functions"
echo "  bash scripts/setup-monitoring-alerts.sh"
echo ""
