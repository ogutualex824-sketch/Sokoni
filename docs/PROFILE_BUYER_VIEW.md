# Profile — buyer presentation (2026-09-30)

**Owner ask:** "change the buyer profile to be for buyer role — fix the gaps." · **Surface:** `profile.html` · **Suite:** `scripts/test-profile-buyer-view.js` (17 / 0) · **Related:** [[ROLE_AUTHORITY_AUDIT]] · [[MERCHANT_DASHBOARD_FACTS]] · [[Authentication]]

## What was wrong

`profile.html` is one page for every role. Its Overview had grown a business command centre — Business Hub, Business Health, module summaries, executive commands, the Businesses / Workspaces tiles and the Listings / Rating stats — that rendered for **every** visitor. A buyer opened their profile and saw a merchant's dashboard full of dashes; "Listings" even counted the public catalogue cache as if it were theirs. The page already knew the acting role (`_actingAs`, `SokoniRoleAuthority`) but only the Business Hub consulted it.

## The gate

One attribute on `<html>`, `data-sk-profile-view`, is set from the acting role wherever the role switcher renders (boot, a role switch, authority verification): **`business` only when the acting role is a held non-buyer role**; buyer active, no active role yet, or an active role the account does not hold all give **`buyer`**. Business-only blocks carry the class `sk-biz-only`; the rule `html[data-sk-profile-view="buyer"] .sk-biz-only{display:none !important}` keeps them hidden whatever a later render sets on them. The `<html>` tag carries `data-sk-profile-view="buyer"` as its default, so the first paint is the buyer view and a held business role upgrades it.

Tagged: `cmdBusinesses`, `cmdWorkspaces`, `pi7BizHealth`, `pi6ExecCmdsWrap`, `piQaRoleActions`, `upBizHub`, `pi7ModuleCards`, `statListings`, `statRating`.
Deliberately **not** tagged (they belong to the person): every tab (orders, bookings, following, wallet, identity, employment, achievements, security, ID card, career, vault), the seller-application card ("Start selling on SOKONI" is how a buyer becomes a seller), buyer stats (orders, spent), loyalty, recent activity, hubs.

Nothing is granted or revoked: the switch is presentation only, composed on top of the entitlement predicate exactly as the Business Hub's acting-context rule already is. Rules, the role authority and Functions are untouched.

## Proof

`test-profile-buyer-view.js`: CSS rule present; every business block tagged and every personal tab untagged; the switcher applies the view; the pure decision lifted from the page and exercised across buyer / seller-acting-as-buyer / held business roles / unheld role / no role; the attribute written and flipped; breakage controls (an untagged block is detected; an unheld role is never presented). Inline scripts parse; CRLF preserved.
