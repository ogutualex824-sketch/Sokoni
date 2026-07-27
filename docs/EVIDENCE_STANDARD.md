# Evidence standard for investigations

Derived from the 2026-07-24 hardening and incident work. Not tied to those
findings — it applies to any investigation in this repository.

## The failure mode

Across every wrong conclusion reached during that work, the cause was the same,
and it was **not** missing data:

> The instrument answered a different question than the investigation required.

Each produced output that looked complete and authoritative. None returned an
error. That is what made them dangerous: an error prompts another look, whereas a
plausible answer ends the enquiry.

> The most dangerous output is not an error. It is a plausible answer from a
> query that did not ask what you thought it asked.

## Real examples from this repository

| Apparent result | What the tool actually measured | Consequence |
|---|---|---|
| Empty IAM policy for four services | `getIamPolicy` on **non-existent** resources — it returns an empty policy, not 404 | Looked like "no bindings anywhere", nearly falsified a correct hypothesis |
| `requestDataExport` not found | Cloud Run service names are **lowercase**; camelCase is a different identity | The query silently audited nothing |
| "No client calls `canPublishProduct`" | The first 5 grep matches only (`head -5`) | Concluded the upload path was unguarded; `seller.js:807` calls it |
| 36 browser-callable functions | Known wrapper names (`httpsCallable`, `callCF`) | Missed page-local wrappers like `_lhCallCF`; the real figure was 206 |
| `education` index is stale | Registry vs the **source file** | The index was live in production; a deploy would have deleted it |
| `test-inventory` hung (exit 124) | A meta-runner exceeding *my* timeout | Reported as a defect; it was running all 76 suites |
| Search pipeline test failing | A contract the data does not honour | Satisfying the test would have **broken search** |
| `git push origin main` — "Everything up-to-date" | The push succeeded; the commit was on a different branch | The fix never reached `main`; the report was true and useless |
| ADR edit committed | The heredoc used `python`, absent here; the write never happened | `git commit` reported success with the documentation absent |
| `processWholesalePayment` called but not deployed | The literal callable name against the deployed list | **False P0.** `callCF` is a page-local wrapper onto `servicesDispatch`; the feature works |

Note the last two. A test can fail for a reason that is not a defect, and a test
can demand something actively harmful. A passing suite is evidence about the
suite as much as about the system.

## Addressing assumptions

The most dangerous assumption in an engineering system is not about behaviour. It
is about **which object the operation addressed.**

| Intended target | Assumed address | Actual address | Effect |
|---|---|---|---|
| Cloud Run service | `id.toLowerCase()` | `runServiceId` | False IAM diagnosis |
| Git push | `origin/main` | the checked-out branch | Push succeeded, `main` unchanged |
| ADR edit | file mutated | tool never wrote | Commit succeeded, documentation absent |
| Callable `processWholesalePayment` | a function of that name | `servicesDispatch`, `op:` field | False P0 against a working feature |

In every case the command **succeeded**, the output was **well-formed**, and it
answered a question that had not been asked. No error surfaced, because no error
occurred — the operation was performed faithfully against the wrong object.

This defeats the usual defences. Exit codes, error handling and retries all assume
failure announces itself. An addressing error announces success.

Two properties make it especially hard to catch:

- **Indirection hides the real target.** `callCF('X')` reads as "call X". It calls
  `servicesDispatch`. Wrappers, dispatchers, aliases and env-derived names all
  create a gap between the name at the call site and the object addressed. Eleven
  files in this repository route callables through a dispatcher wrapper; any
  name-matching audit that ignores them produces confident false positives.
- **Success is indistinguishable from success.** A push to the wrong branch and a
  push to the right one emit the same output.

### The discipline

**Verify the object, not the operation.** Not "did it succeed?" but "did the thing
I meant to change, change?" Distinct evidence, usually from a different direction:

| Instead of | Assert |
|---|---|
| push exit code | `git merge-base --is-ancestor HEAD origin/main`, then read the file back from the remote |
| commit succeeded | grep the committed content for what should now be there |
| a callable name is absent from the deployed list | resolve the wrapper at the call site first — find what URL is actually requested |
| a resource query returned empty | confirm the resource **exists** before reading "empty" as "unconfigured" |

**Read back through a different path than you wrote.** Writing and reading through
the same abstraction confirms the abstraction is self-consistent, not that the
world changed. The remote file was checked with `git show origin/main:<path>`, not
by trusting the push.

**Name resolution is evidence, not formatting.** Whenever a human-readable name is
transformed to reach a real object — case-folded, prefixed, mapped, defaulted —
that transformation is a claim requiring proof. Prefer the authoritative
identifier the system itself reports (`runServiceId`) over one reconstructed
locally.

## Review checklist

Before a conclusion becomes a change:

1. **What question am I trying to answer?**
2. **What does this tool actually measure?** Not what its name suggests — what it
   returns, for the exact input given.
3. **What assumptions connect the measurement to my conclusion?**
4. **Can another independent measurement falsify those assumptions?**
5. **Am I about to change production based on an observation, or on demonstrated
   causation?**

Question 5 is the one that most often stops a bad change. An observation
("348 services return 403") and a cause ("they are missing `run.invoker`") are
different claims requiring different evidence, and only the second justifies
modifying IAM.

## Practices that follow

**Distinguish absent from disagreeing.** A document nothing has written cannot
disagree with anything. Conflating the two hides which failure you have.
`verify-entitlement-consistency.js` reports them separately for this reason.

**Compare against a deterministic reference, not a majority.** Four client tables
agreed on a 10-product limit — because none could see a subscription. Consensus
among stale copies is indistinguishable from a verified answer.

**Prefer visible uncertainty to a plausible default.** `SokoniAuthority` returns
`null` when the authoritative answer is unavailable rather than assuming the free
tier. A blank field prompts a support ticket; a confident wrong number does not.

**Fix the instrument, not just the finding.** When a tool produces a false
conclusion, guard against it recurring. `audit-callable-invokers.js` now proves a
service exists before trusting its policy, because that specific trap cost real
time and would otherwise cost it again.

**State the scope of a green result.** A passing check means "no endpoint exhibits
this specific misconfiguration", not "the system is correctly configured". Write
the limitation into the tool's output so a future reader cannot over-read it.

## Why this is worth writing down

Corrections are not a distraction from an investigation; they are its most
transferable output. A defect fixed stays fixed. An instrument that stops
producing false conclusions keeps paying out on findings nobody has made yet —
including the ones that would otherwise be acted on wrongly.
