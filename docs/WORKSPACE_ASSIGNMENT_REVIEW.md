# Workspace Assignment Review

**Status:** PROPOSALS. `navigation-registry.json` is unchanged. Nothing here is canonical
until reviewed — a wrong assignment propagates into Explore, breadcrumbs, global search
and KASS routing, and is far harder to unpick later than to decide now.

`Confidence` is measured from VISIBLE TEXT only — script, style and tags are stripped
before matching. The filename rules already ran in the generator and did not match any
of these pages, so guessing from the name again would repeat the same miss.

## Read the confidence honestly

An earlier version scanned raw source and reported 42 High-confidence proposals. It was
matching JavaScript identifiers — `event.target`, `product`, `driver` — not subject
matter, and confidently proposed `crm.html` as **Entertainment**. Stripping code dropped
High from 42 to 10 and raised Low from 12 to 69.

That collapse is the real finding: **most of these pages render their content with
JavaScript, so there is very little visible text to classify from.** Static analysis
cannot place them. The Medium rows are starting points for a human, not answers, and the
Low rows are genuinely undecidable without product knowledge.

| Page | Proposed Workspace | Confidence | Reason | Alternative |
|---|---|---|---|---|
| `creative-studio.html` | Marketplace | High | 16 content match(es) | Food |
| `email-center.html` | Vehicle & Logistics | High | 16 content match(es) | Entertainment |
| `ent-organizer.html` | Entertainment | High | 30 content match(es) | Travel |
| `inv-ai.html` | Seller | High | 12 content match(es) | Marketplace |
| `inv-products.html` | Marketplace | High | 17 content match(es) | Seller |
| `marketing.html` | Marketplace | High | 19 content match(es) | Seller |
| `pos.html` | Marketplace | High | 24 content match(es) | Seller |
| `requests.html` | Vehicle & Logistics | High | 13 content match(es) | Seller |
| `security-compliance.html` | Admin | High | 13 content match(es) | Seller |
| `superadmin.html` | Admin | High | 13 content match(es) | Seller |
| `about.html` | Vehicle & Logistics | Medium | 11 content match(es) | Food |
| `analytics.html` | Marketplace | Medium | 5 content match(es) | Seller |
| `async-jobs.html` | Jobs | Medium | 5 content match(es) | Admin |
| `automation-center.html` | Banking | Medium | 5 content match(es) | Seller |
| `automation-engine.html` | Admin | Medium | 5 content match(es) | Entertainment |
| `b2b-seller-dashboard.html` | Seller | Medium | 4 content match(es) | Marketplace |
| `b2b-supplier.html` | Seller | Medium | 4 content match(es) | Marketplace |
| `b2b.html` | Vehicle & Logistics | Medium | 5 content match(es) | Marketplace |
| `beta.html` | Vehicle & Logistics | Medium | 14 content match(es) | Marketplace |
| `bnb-hub.html` | Property | Medium | 8 content match(es) | Travel |
| `bnb-manage.html` | Property | Medium | 4 content match(es) | Travel |
| `business-os.html` | Marketplace | Medium | 7 content match(es) | Seller |
| `commerce-os.html` | Seller | Medium | 6 content match(es) | Vehicle & Logistics |
| `community-guidelines.html` | Legal | Medium | 5 content match(es) | Marketplace |
| `community.html` | Entertainment | Medium | 4 content match(es) | Property |
| `construction.html` | Marketplace | Medium | 6 content match(es) | Vehicle & Logistics |
| `contact.html` | Legal | Medium | 5 content match(es) | Vehicle & Logistics |
| `cookie-policy.html` | Legal | Medium | 8 content match(es) | Marketplace |
| `crm.html` | Entertainment | Medium | 5 content match(es) | Seller |
| `customer-analytics.html` | Admin | Medium | 4 content match(es) | Support |
| `digital.html` | Jobs | Medium | 7 content match(es) | Marketplace |
| `electrical.html` | Jobs | Medium | 4 content match(es) | Travel |
| `executive-dashboard.html` | Seller | Medium | 8 content match(es) | Vehicle & Logistics |
| `expense-management.html` | Marketplace | Medium | 8 content match(es) | Travel |
| `faq.html` | Vehicle & Logistics | Medium | 17 content match(es) | Marketplace |
| `finos-admin.html` | Admin | Medium | 5 content match(es) | Banking |
| `finos.html` | Banking | Medium | 5 content match(es) | Admin |
| `growth-dashboard.html` | Marketplace | Medium | 7 content match(es) | Seller |
| `help.html` | Marketplace | Medium | 17 content match(es) | Seller |
| `home-services.html` | Jobs | Medium | 5 content match(es) | Travel |
| `hr-payroll.html` | Seller | Medium | 9 content match(es) | Vehicle & Logistics |
| `hub-dashboard.html` | Banking | Medium | 6 content match(es) | Vehicle & Logistics |
| `inv-dashboard.html` | Seller | Medium | 10 content match(es) | Marketplace |
| `inv-product.html` | Seller | Medium | 6 content match(es) | Marketplace |
| `kass-manager.html` | Seller | Medium | 4 content match(es) | Food |
| `kass-seller.html` | Seller | Medium | 6 content match(es) | Food |
| `loyalty-merchant.html` | Seller | Medium | 8 content match(es) | Vehicle & Logistics |
| `loyalty.html` | Marketplace | Medium | 5 content match(es) | Vehicle & Logistics |
| `ministore.html` | Marketplace | Medium | 10 content match(es) | Seller |
| `offer.html` | Marketplace | Medium | 6 content match(es) | Healthcare |
| `opportunity.html` | Vehicle & Logistics | Medium | 6 content match(es) | Property |
| `partner-portal.html` | Seller | Medium | 7 content match(es) | Marketplace |
| `platform.html` | Admin | Medium | 6 content match(es) | Entertainment |
| `press.html` | Vehicle & Logistics | Medium | 4 content match(es) | Property |
| `provider-dashboard.html` | Banking | Medium | 4 content match(es) | Travel |
| `provider-terms.html` | Banking | Medium | 7 content match(es) | Travel |
| `provider.html` | Travel | Medium | 6 content match(es) | Marketplace |
| `qr-center.html` | Marketplace | Medium | 4 content match(es) | Seller |
| `redis-monitor.html` | Admin | Medium | 4 content match(es) | Seller |
| `refund-policy.html` | Marketplace | Medium | 5 content match(es) | Vehicle & Logistics |
| `release-readiness.html` | Admin | Medium | 4 content match(es) | Support |
| `returns-policy.html` | Seller | Medium | 15 content match(es) | Marketplace |
| `revenue.html` | Seller | Medium | 9 content match(es) | Food |
| `route-planner.html` | Vehicle & Logistics | Medium | 8 content match(es) | Marketplace |
| `sasos-admin.html` | Vehicle & Logistics | Medium | 9 content match(es) | Marketplace |
| `security-center.html` | Admin | Medium | 6 content match(es) | Travel |
| `sell.html` | Vehicle & Logistics | Medium | 8 content match(es) | Marketplace |
| `sokoni-cert.html` | Seller | Medium | 10 content match(es) | Admin |
| `sports-venue.html` | Entertainment | Medium | 4 content match(es) | Travel |
| `status.html` | Vehicle & Logistics | Medium | 4 content match(es) | Marketplace |
| `subscription-os.html` | Admin | Medium | 4 content match(es) | Legal |
| `subscriptions.html` | Travel | Medium | 12 content match(es) | Banking |
| `support.html` | Entertainment | Medium | 9 content match(es) | Vehicle & Logistics |
| `tech-hub.html` | Jobs | Medium | 5 content match(es) | Vehicle & Logistics |
| `tenant-portal.html` | Property | Medium | 10 content match(es) | Marketplace |
| `test-accounts.html` | Vehicle & Logistics | Medium | 4 content match(es) | Seller |
| `uat-center.html` | Vehicle & Logistics | Medium | 4 content match(es) | Admin |
| `verification-admin.html` | Admin | Medium | 6 content match(es) | Support |
| `verification.html` | Marketplace | Medium | 14 content match(es) | Vehicle & Logistics |
| `wap.html` | Admin | Medium | 6 content match(es) | Vehicle & Logistics |
| `404.html` | Property | Low | 1 content match(es) | Food |
| `ai-subscriptions.html` | Unassigned | Low | no strong content signal | — |
| `availability-manager.html` | Travel | Low | 3 content match(es) | Food |
| `b2b-chat.html` | Unassigned | Low | no strong content signal | — |
| `b2b-dashboard.html` | Seller | Low | 2 content match(es) | Marketplace |
| `b2b-orders.html` | Unassigned | Low | no strong content signal | — |
| `b2b-rfq.html` | Seller | Low | 1 content match(es) | Marketplace |
| `bnb.html` | Property | Low | 2 content match(es) | Travel |
| `business-analytics.html` | Seller | Low | 1 content match(es) | Marketplace |
| `business-health.html` | Healthcare | Low | 1 content match(es) | Food |
| `business.html` | Unassigned | Low | no strong content signal | — |
| `businesses.html` | Food | Low | 2 content match(es) | Property |
| `customer-display.html` | Unassigned | Low | no strong content signal | — |
| `data-deletion.html` | Banking | Low | 1 content match(es) | Vehicle & Logistics |
| `digital-store.html` | Unassigned | Low | no strong content signal | — |
| `ecc.html` | Seller | Low | 1 content match(es) | Admin |
| `email-preview.html` | Vehicle & Logistics | Low | 2 content match(es) | Banking |
| `enterprise-certification.html` | Admin | Low | 3 content match(es) | Support |
| `enterprise-ops.html` | Entertainment | Low | 1 content match(es) | Travel |
| `feedback.html` | Marketplace | Low | 2 content match(es) | Seller |
| `feeds.html` | Unassigned | Low | no strong content signal | — |
| `fos-admin.html` | Admin | Low | 3 content match(es) | Food |
| `franchise.html` | Banking | Low | 1 content match(es) | Admin |
| `general-ledger.html` | Banking | Low | 3 content match(es) | Business |
| `gip.html` | Vehicle & Logistics | Low | 3 content match(es) | Jobs |
| `inspiq.html` | Unassigned | Low | no strong content signal | — |
| `join.html` | Unassigned | Low | no strong content signal | — |
| `kass-developer.html` | Food | Low | 1 content match(es) | Marketplace |
| `kass-executive.html` | Admin | Low | 2 content match(es) | Food |
| `kass-finance.html` | Food | Low | 1 content match(es) | Marketplace |
| `kass-support.html` | Food | Low | 1 content match(es) | Seller |
| `launch-metrics.html` | Admin | Low | 3 content match(es) | Vehicle & Logistics |
| `launch.html` | Admin | Low | 1 content match(es) | Support |
| `life-events.html` | Unassigned | Low | no strong content signal | — |
| `manager-auth.html` | Admin | Low | 3 content match(es) | Seller |
| `marketing-hub.html` | Marketplace | Low | 1 content match(es) | Seller |
| `mechanics.html` | Banking | Low | 1 content match(es) | Vehicle & Logistics |
| `my-subscriptions.html` | Unassigned | Low | no strong content signal | — |
| `observability.html` | Admin | Low | 3 content match(es) | Support |
| `offline.html` | Unassigned | Low | no strong content signal | — |
| `org-directory.html` | Legal | Low | 3 content match(es) | Business |
| `org-structure.html` | Unassigned | Low | no strong content signal | — |
| `org-workflows.html` | Admin | Low | 3 content match(es) | Travel |
| `pay.html` | Seller | Low | 1 content match(es) | Marketplace |
| `phone-repair.html` | Unassigned | Low | no strong content signal | — |
| `plans.html` | Unassigned | Low | no strong content signal | — |
| `plumbing.html` | Jobs | Low | 2 content match(es) | Travel |
| `print-station.html` | Banking | Low | 1 content match(es) | Vehicle & Logistics |
| `professional-profile.html` | Education | Low | 2 content match(es) | Entertainment |
| `providers.html` | Legal | Low | 1 content match(es) | Travel |
| `referral.html` | Unassigned | Low | no strong content signal | — |
| `returns.html` | Seller | Low | 1 content match(es) | Admin |
| `revenue-dashboard.html` | Admin | Low | 2 content match(es) | Support |
| `reviews.html` | Marketplace | Low | 1 content match(es) | Seller |
| `route-debug.html` | Vehicle & Logistics | Low | 3 content match(es) | Marketplace |
| `scan.html` | Unassigned | Low | no strong content signal | — |
| `security-zero-trust-dashboard.html` | Admin | Low | 3 content match(es) | Entertainment |
| `sports-hub.html` | Property | Low | 3 content match(es) | Entertainment |
| `sports-tournament.html` | Unassigned | Low | no strong content signal | — |
| `subscription-billing.html` | Vehicle & Logistics | Low | 3 content match(es) | Entertainment |
| `success.html` | Seller | Low | 3 content match(es) | Vehicle & Logistics |
| `task-queue.html` | Jobs | Low | 2 content match(es) | Business |
| `track.html` | Vehicle & Logistics | Low | 1 content match(es) | Marketplace |
| `unboxing.html` | Marketplace | Low | 3 content match(es) | Food |
| `validation.html` | Unassigned | Low | no strong content signal | — |
| `vision-2030.html` | Admin | Low | 2 content match(es) | Support |
| `webhooks.html` | Entertainment | Low | 3 content match(es) | Vehicle & Logistics |
| `wholesale-portal.html` | Marketplace | Low | 2 content match(es) | Banking |
| `workspace-invite.html` | Jobs | Low | 1 content match(es) | Business |

## How to apply

Correct the Proposed Workspace column, then the mapping can be folded into
`WORKSPACE_RULES` in `scripts/build-nav-registry.js` and the registry regenerated.
Assignments live in the generator so they survive regeneration.