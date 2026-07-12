# KASS Knowledge Architecture

How KASS knows things, how you change what it knows, and why it is built to say *"I don't know."*

Related: [[Marketplace]] · [[Payments]] · [[SmartPOS]] · [[RELEASE_v1.0.0_RC3]]

---

## The problem this solves

KASS's knowledge used to live inside a **hardcoded system-prompt string in `functions/index.js`**. Changing a fee, adding a hub, or correcting a policy meant editing the assistant's source and redeploying it. Knowledge and behaviour were fused, so every business update carried code risk — and nobody but an engineer could make one.

**Knowledge is now data.** Updating what KASS knows is a Firestore write, not a deploy.

| | Lives in | Changed by |
|---|---|---|
| **Behaviour** — persona, tool policy, routing, safety rules | the system prompt (`index.js`) | engineers, via deploy |
| **Knowledge** — facts, policies, prices, Kenya reference | `kassKnowledge` (Firestore) | admins, via callable |

---

## How a turn works

1. The user sends a message.
2. `retrieve(query)` scores the published knowledge and returns the top matches.
3. **Pinned** entries (persona, language policy, uncertainty rules) are *always* injected.
4. The scored facts are injected as **VERIFIED SOKONI KNOWLEDGE** and marked authoritative.
5. If nothing scored above threshold → `grounded: false` → the prompt explicitly tells KASS it has **no verified policy**, and the question is logged to `kassUnanswered`.

That last step is the point of the whole system. **An ungrounded question produces an honest "I don't know", not a plausible invention.**

---

## Retrieval is lexical, not vector — deliberately

Scoring is token overlap plus curated boosts:

| Signal | Weight | Why |
|---|---:|---|
| `tags` hit | ×3 | Hand-curated retrieval key |
| `questions` hit | ×2 | Real phrasing a human wrote |
| `title` hit | ×2 | |
| body token | ×1 | Incidental |
| `policy` / `pricing` category | +1 | Authoritative entries should win ties |

No embeddings, no vector DB. The corpus is small and hand-curated (hundreds of entries, not millions of documents), the questions are short, and a lexical index needs **no new infrastructure, no per-query embedding cost, and no re-indexing pipeline**. It is also debuggable — an admin can see *why* an entry matched.

If the corpus outgrows this, replace `_score()` with an embedding lookup. Nothing else changes.

**Published knowledge is cached for 5 minutes.** Knowledge changes rarely; re-reading it on every chat turn would be pure waste.

---

## Kenyan language handling

Tokenisation strips stopwords in **both English and Kiswahili/Sheng**, so `"nataka kununua simu"` and `"I want to buy a phone"` reduce to comparable token sets.

Two hard-won details, both found by testing:

- **`ngapi` ("how much") is NOT a stopword.** It is the core token of every price and fee question (*"inachukua ngapi"*). Treating it as noise made those queries retrieve nothing.
- **The language entry is `pinned`, and pinned entries are excluded from scoring.** It contains literal example phrases (*"Nataka kuuza simu"*), so when it competed on content overlap it **out-ranked the actual answer for the very phrases it documents** — the guide hijacked the question it was written to explain.

---

## The money guardrail — why there are no fees in the corpus

**There is not a single commission rate, fee or price in the seed corpus.** That is deliberate.

Commission in SOKONI is a **configurable rule engine** (`functions/commission.js`: percentage / fixed / tiered / holiday, set per category by an admin). There is no single rate to state. Seeding a number would make KASS confidently quote a fee that is wrong for the seller's category — precisely the failure this system exists to prevent.

Instead, `guard-money-facts` tells KASS: *you do not know the rate; do not guess; hand off.*

When an admin publishes the real figures via `kassKnowledgeUpsert`, KASS answers from them. **That is the correct order: the number enters as governed knowledge, not as a hardcoded guess.**

---

## Admin API

All writes are **admin-only and server-side**. Knowledge is what KASS asserts as true — anyone who can write it can make the assistant say anything.

| Callable | Purpose |
|---|---|
| `kassKnowledgeUpsert` | Create/update an entry. Bumps `version`, stamps `updatedBy`. |
| `kassKnowledgePublish` | Publish or return to draft. **Drafts are never retrieved** — stage and review before KASS asserts it. |
| `kassKnowledgeList` | Browse by status/category. |
| `kassKnowledgeArchive` | Archive (not hard-delete — an entry is a record of what KASS was telling users). |
| `kassKnowledgeSeed` | Seed/re-sync the curated corpus. Idempotent, keyed by slug. |
| `kassKnowledgeStats` | Analytics — see below. |
| `kassFeedback` | Thumbs up/down from users. |

### Live updates without a deploy

New hub, price change, policy update, new payment provider, promotion:

```js
await kassKnowledgeUpsert({
  id: 'policy-refund-window',
  title: 'Refund window',
  category: 'policy',
  tags: ['refund', 'return', 'rudisha'],
  questions: ['how long do I have to return', 'nina siku ngapi'],
  content: 'Buyers may request a refund within X days of delivery…',
  status: 'draft',        // review it first
});
await kassKnowledgePublish({ id: 'policy-refund-window' });   // now live within 5 min
```

---

## Continuous improvement

`kassKnowledgeStats` returns the feedback loop:

- **`unansweredTop`** — questions KASS could not ground, **clustered by theme** rather than listed as near-duplicate strings. *This is the backlog for the next knowledge update — it tells you exactly what to write next.*
- **`knowledgeNeedingReview`** — entries that were retrieved and then thumbed **down**. Pairing the downvote with the retrieved entry IDs is what makes the loop actionable: you learn *which knowledge* produced the bad answer, not merely that one occurred.
- **`satisfaction`** — up/down ratio.

---

## Testing

```bash
npm run test:kass
```

Asserts the right knowledge surfaces for real Kenyan phrasings (`"Nataka kuuza simu"`, `"SOKONI inachukua ngapi?"`, `"Natafuta fundi karibu"`, `"Hii ni legit ama scam?"`) — **and that nonsense queries return `grounded: false`**, so KASS says it doesn't know instead of inventing.

That negative case matters as much as the positive ones. A retrieval system that always finds *something* is worse than useless: it launders guesses as facts.

---

## Collections

| Collection | Contents |
|---|---|
| `kassKnowledge` | Versioned entries: `draft` \| `published` \| `archived` |
| `kassUnanswered` | Ungrounded questions — the improvement backlog |
| `kassFeedback` | Ratings + the knowledge IDs that produced the answer |

Indexes: `kassKnowledge(status, category)`, `kassUnanswered(resolved, createdAt DESC)`.

---

## Operating it

1. **Seed once**: call `kassKnowledgeSeed` as an admin.
2. **Fill the gaps you actually have** — publish the real commission rates, refund window, payout timings and verification requirements. Until then KASS correctly refuses to state them.
3. **Read `unansweredTop` weekly.** It is the highest-signal product feedback in the platform: real users, real words, questions you cannot yet answer.
