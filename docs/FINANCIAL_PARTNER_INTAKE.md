# Financial Partner Intake

How a bank, SACCO, accountant, insurer or other financial institution applies to be listed in the
Banking Hub. Added 2026-10-01. Related: [[Financial Partner Listing]], [[Applications]], [[Banking Hub]],
[[Role Authority]].

## Status

Built on `hosting/financial-partner-on-20b92fa`. **Not deployed.** It ships with sokoni-4d's Banking Hub
hosting release and needs the functions slice `feat/financial-partner-on-f66f2c1` (the listing projection)
deployed first.

## One intake

- `business-apply.html?offer=financial&category=<TYPE>&label=<label>` shows the partner form instead of
  the products and services choice. It collects the institution name and type, 1 to 8 services, and an
  optional description, county, website, business email, business phone and self-declared licence number.
- `sokoni-financial-partner-application.js` files `applications/{uid}--financial_partner` with
  `requestedRole: 'financial_partner'` and `status: 'pending_review'`. It reuses the merchant module's
  forbidden-field filter and resubmission rules, so a smuggled `role`, `verified` or `licenceVerified`
  never reaches the document.
- `hub-register.js` financial categories (bank, SACCO, microfinance, chama, insurance, accountant, forex)
  hand off to that form. The short hub form cannot collect an institution type or services, so it never
  files a financial application itself.

The client checks only tell the applicant early. The server validator,
`functions/financial-partner-listing.js`, decides. The intake suite asserts the two lists match exactly.

## After approval

- The page reads `financialProviders/{uid}`, the listing the server wrote. `listingStatus: 'approved'`
  shows "Listed" and a link to `financial-partner-dashboard.html`.
- An application approved but not listed (the server refused the profile) shows "Approved, not listed"
  with the server's reason. It is never shown as listed.
- `sokoni-role-authority.js` routes the role. `WORKSPACE_HUBS.financial_partner` is the dashboard, the
  dashboard page is guarded for the role, and an unapproved visitor is sent to the intake.
- AdminOS Applications labels the role "Financial partner".

## Tests

`node scripts/test-financial-partner-intake.js` covers the submission module, page wiring, routing, the
hub-register hand-off and parity with the server lists. The form has not yet been exercised in a real
browser.
