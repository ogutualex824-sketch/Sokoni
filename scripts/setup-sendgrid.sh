#!/bin/bash
# SOKONI — Set SendGrid API key in Secret Manager
# Run this ONCE when you have your real SendGrid API key.
# Usage: bash scripts/setup-sendgrid.sh

set -e
echo "Setting SENDGRID_API_KEY in Firebase Secret Manager..."
echo "Paste your SendGrid API key (starts with SG.) then press Enter:"
read -r -s SENDGRID_KEY

if [[ ! "$SENDGRID_KEY" == SG.* ]]; then
  echo "ERROR: Key must start with SG. Aborting."
  exit 1
fi

echo "$SENDGRID_KEY" | firebase functions:secrets:set SENDGRID_API_KEY
echo "✓ SENDGRID_API_KEY stored in Secret Manager"
echo "Now redeploy email functions:"
echo "  firebase deploy --only functions:sendEmailVerification,functions:sendWelcomeEmail,functions:sendOrderConfirmation"
