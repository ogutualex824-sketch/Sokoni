# Financial Partner Listing

Banking Hub directory entries for banks, SACCOs, accountants, financial advisers, insurers, microfinance,
investment and forex firms, and chamas. Added 2026-10-01. Related: [[Applications]], [[Authentication]],
[[Banking Hub]], [[Role Authority]].

## Status

Built and tested on `feat/financial-partner-on-f66f2c1`. **Not deployed.** The Firestore rule for
`financialProviders` is not released yet. Until both ship, the Banking Hub directory shows
"No partners listed yet".

## Flow

1. The applicant uses `business-apply.html?offer=financial&category=<TYPE>&label=<label>`. That files
   `applications/{id}` with `requestedRole: 'financial_partner'`.
2. An admin approves it in AdminOS Applications, through `applicationDecide`. The server records the decision.
3. `applicationLifecycle` checks that server-recorded decision (K13-B) and validates the profile.
   It then writes `financialProviders/{uid}`, adds `financial_partner` to `users.roles` and sets the
   `financial_partner` custom claim.
4. Revoke, suspend or reject sets `listingStatus: 'withdrawn'`. The document is kept and never deleted.
   The role and claim are withdrawn.

## One validator

`functions/financial-partner-listing.js` is the only place the listing is shaped. The lifecycle uses
`buildListing()`. The partner dashboard's edit callable must use `validateDescriptive()` and write only
`EDITABLE_KEYS`, so the two writers cannot drift apart.

| Field | Rule |
|---|---|
| institutionType | One of BANK, SACCO, ACCOUNTANT, FINANCIAL_ADVISER, INSURER, MICROFINANCE, INVESTMENT, FOREX, CHAMA, OTHER, DIGITAL_LENDER, PAYMENT_PROVIDER, BUSINESS_FINANCE (append-only). Unknown refuses the listing. It never falls back to OTHER. |
| name | `institutionName`, plain text, 2 to 120 characters, or the listing is refused. |
| services | Subset of the 16-value enum (DIGITAL_LOANS and MOBILE_MONEY appended). Unknown values are dropped, duplicates collapsed, 8 at most. If none remain, the listing is refused. |
| description | Plain text, 300 characters at most. Markup is removed. |
| county | One of the 47 counties, canonical spelling. Otherwise omitted. |
| website | `https://` only, no credentials, 200 characters at most. Otherwise omitted. |
| businessEmail, businessPhone | Validated. The phone is normalised to +254. Otherwise omitted. |
| licenceClaimed | Self-declared text, 60 characters at most. |
| licenceVerified | Always `false`. No licence verification exists. |
| verifiedBy | Always `sokoni_admin_review`: an admin approved the listing, not a licence. |

The public document holds exactly `PUBLIC_KEYS`. It never holds the applicant's personal name, ID, KRA PIN,
personal contact details, agreement data or internal notes. Approval replaces the whole document, so a field
that failed validation cannot linger from an earlier listing. Omitted optional fields are named in the
application's `projectionReceipt` for the reviewer.

## Refusal

If the profile is invalid on approval, nothing is provisioned: no listing, no role, no claim. The application
gets `projectionStatus: 'blocked_invalid_profile'` with the reason, and an `adminAlerts` entry of kind
`application_profile_invalid` is created. The applicant cannot edit a decided application (K13-C), so the
admin rejects it and asks for a new one.

## Security

- Every field is applicant-written, so nothing is copied through. An applicant who writes
  `licenceVerified: true` or `listingStatus: 'featured'` changes nothing.
- The directory card's badge reads "Listed by SOKONI". It never says "Verified" or "Licensed".
- Required rule, released separately: public read only where `listingStatus == 'approved'`, and
  `write: false` for clients.

## Tests

`node scripts/test-financial-partner-lifecycle.js` drives the real trigger over an in-memory Firestore.
Six code sabotages each turn it red.
