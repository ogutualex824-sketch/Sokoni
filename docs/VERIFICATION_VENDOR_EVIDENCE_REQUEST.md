# Verification Vendor Evidence Request

**Issue identically to every candidate.** Persona and Sumsub as finalists; Veriff retained as
benchmark. Price is not requested at this stage and must not be volunteered as a substitute for
evidence.

Derived from [[VERIFICATION_PROVIDER_CONTRACT]] and
[[BIOMETRIC_VERIFICATION_DECISION_RECORD]]. Scope: **D-01 = Universal** — every application
creating an official SOKONI identity, merchant onboarding included.

**Answer format:** each item requires a named artifact — a document, a clause, an API field, or a
report. Prose assurance is not an answer. Where a requirement cannot be met, say so plainly; a
clear "no" is more useful than a qualified yes and will not by itself end the evaluation.

---

## Section 1 — Mandatory technical contract

| # | Evidence required |
|---|---|
| V-a | The API field carrying the face↔document match result, and whether it is a **score or a boolean**. Name the field. If a score: its range, and whether the threshold is yours or ours. |
| V-b | The field carrying **liveness**, demonstrated as **separate** from match. A single combined verdict does not satisfy this. |
| V-d | Whether a face **template/embedding** is created; if so, where it is stored, for how long, and whether the service can operate without persisting one. |
| V-f | The **decision reference** that remains resolvable **after** the images are deleted, and what it resolves to once they are gone. |
| — | The field carrying **model/verification configuration version** (our `vendorModelVersion`), and your notification process when a model changes. |
| — | The field carrying **processing region** per verification (our `processingRegion`) — as returned evidence, not an account setting. |
| — | The identifier we use to **command deletion** of a specific verification (our `deletionHandle`), and the **timestamp of your ingest** (our `vendorReceivedAt`). |
| V-h | The supported path when an applicant **cannot complete capture** — device unsupported, low bandwidth, disability, facial covering. |

---

## Section 2 — V-g demographic performance

Direct vendor evidence is preferred and remains the gold standard. A candidate may instead satisfy
this through the **predefined equivalent package below — all six components, not a selection**:

1. **Independent third-party evaluation** (not self-administered)
2. **Population and methodology disclosure** — who was tested, how many, how selected
3. **Demographic performance results** across skin tone, age and gender, with confidence intervals
   where available
4. **Contractual performance warranty** — see §2a
5. **Remediation obligation** — see §2a
6. **Ongoing monitoring** — see §2b

### Explicitly insufficient, alone or combined
Marketing claims · generic "bias tested" statements · SOC 2 or ISO certification (these answer a
*security* question, not a performance-parity one) · a single aggregate accuracy percentage ·
internal assertion without methodology · SOKONI's own post-launch monitoring.

**D-15 assisted verification is NOT a substitute for V-g.** It protects against individual capture
failures and low-confidence cases; it cannot compensate for a system that performs systematically
worse for a demographic group. A vendor proposing it as mitigation has misread the requirement.

Equally, SOKONI's own operational monitoring (§2b) is an early-warning system, not fairness
evidence. Neither the assisted route nor operational metrics may be cited as demonstrating that
demographic fairness exists.

### §2a — The warranty needs a METRIC and a NUMBER, or it is unenforceable

"Material demographic disparity" cannot be contracted as written — it gives SOKONI no test to
invoke and the vendor no obligation to fail. The contract must state:

- the **metric** (for example false non-match rate and false match rate, per group);
- the **comparison** (worst-performing group against the overall population, or against the best);
- a **numeric trigger** — the ratio or absolute difference that constitutes a breach;
- the **measurement window and sample floor**, so a trigger cannot fire or be dismissed on noise;
- the **remedy**: remediation period, then the right to **suspend the affected automated path**
  while assisted verification remains available, then exit.

Vendors should be asked to propose these values. A vendor unwilling to put a number to it is
answering §2 with prose.

### §2b — Component 6, ongoing performance monitoring. RULED 2026-09-13.

**SOKONI will not collect ethnicity, skin tone, disability status or other sensitive demographic
attributes solely to monitor biometric fairness.** Consented collection was considered and
rejected: Universal verification does not justify gathering additional sensitive personal data in
order to prove that another sensitive-data system is fair.

The consequence is stated plainly rather than papered over — **SOKONI cannot honestly claim to
measure demographic disparity, because it deliberately does not hold the attributes required to
calculate it.** So the contract must not say "SOKONI will monitor demographic disparity". Two
layers, each doing what it can actually do:

**The vendor must:**
- provide aggregate demographic-performance reporting from its own verification population;
- disclose methodology, sample sizes and measurement period;
- notify SOKONI of material degradation **or model changes**;
- provide model/version provenance;
- comply with the agreed performance warranty and remediation thresholds (§2a).

**SOKONI will:**
- monitor non-sensitive operational verification metrics;
- monitor them **by `vendorModelVersion` and `processingRegion`**;
- monitor automated versus assisted routes;
- investigate material changes and invoke contractual remediation where applicable.

The operational metrics, all derivable from fields already required for other reasons:

    automated -> assisted conversion rate      capture failure rate
    liveness-indeterminate rate                low-confidence rate
    verification completion rate               match-score distribution

These do **not** reveal which demographic group is affected, and must never be presented as if
they do. What they give is an early-warning system.

### The model-version control — and its one prerequisite

Because `vendorModelVersion` is captured per verification, a model change cannot silently alter
the verification experience without leaving an operational trace:

    vendorModelVersion A  ->  baseline failure / assisted rates
    vendorModelVersion B  ->  materially different rates  ->  investigation

**Prerequisite: the baseline must exist before the change.** This only works if operational
metrics are recorded from the first production verification, not added when a problem is
suspected — by then there is nothing to compare against. Metrics collection ships with v1.

**"Material change" needs a defined threshold too**, for the same reason "material disparity" did
in §2a. SOKONI controls this one, so it is easier to set — but an undefined trigger is an
investigation nobody is obliged to start.

---

## Section 3 — D-04a retention redlines

Written acceptance required, not description of current defaults. Public documentation is **not**
acceptance.

1. 30-day SOKONI-directed retention, deletion on instruction
2. Deletion of source ID images
3. Deletion of selfies and video
4. Deletion of biometric templates/embeddings
5. Deletion from active systems
6. Deletion from **backups and DR**, or a documented backup-expiry mechanism with a stated maximum
7. Subprocessor obligations — flowed down, and a current subprocessor list
8. Vendor legal-hold exceptions — enumerated, not reserved generally
9. **No secondary model-training use** of SOKONI applicant data
10. No sale, brokering or advertising use
11. Processing-region commitment, contractually fixed (not a console toggle)
12. Cross-border transfer mechanism
13. **Deletion evidence/reporting** — what we receive proving a specific record was deleted
14. Breach notification terms
15. Audit/assurance rights

**Note on item 6:** a vendor whose published position includes multi-year archive or retained
embeddings is not disqualified by that fact, but must override it contractually across the whole
chain. The published default is the starting point for negotiation, not the answer.

---

## Section 4 — Integration

SOKONI integrates behind its own adapter (`verification-adapter.js`). No vendor SDK type reaches
SOKONI's records. Confirm:

- a server-to-server API exists that does not require the vendor SDK to be the system of record;
- results are retrievable server-side and **verifiable as authentic** — a client-reported result
  is not acceptable at any point;
- webhook or callback authentication method.

---

## Evaluation order

    demographic evidence (V-g) -> biometric retention -> processing-region commitment
      -> deletion evidence -> model/version provenance -> DPA and transfer terms

**Price is considered last, and only among candidates that clear every mandatory item.** A failure
on any mandatory requirement disqualifies regardless of implementation convenience or commercial
terms — including for the current leading candidate.
