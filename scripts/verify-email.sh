#!/bin/bash
# SOKONI — Verify email sending after setting real SENDGRID_API_KEY
# Usage: bash scripts/verify-email.sh your@email.com
#
# NOTE: testEmailDelivery is a Firebase onCall function (requires an auth token).
# The curl below calls the HTTP-wrapped onCall endpoint.
# For authenticated testing, use the Firebase Admin SDK or the admin panel at:
#   https://mysokoni.co.ke/admin-os.html  (Ops Tools → Test Email Delivery)
#
# Alternatively, invoke via Firebase CLI:
#   firebase functions:call testEmailDelivery --data '{"to":"your@email.com"}'

TEST_EMAIL="${1:-test@example.com}"
echo "Triggering test email to $TEST_EMAIL..."
curl -X POST "https://us-central1-sokoni-aeb26.cloudfunctions.net/sendTestEmail" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$TEST_EMAIL\"}"
