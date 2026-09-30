# In-Profile Wallet

**Status:** committed locally on `slice/c4-convergence`. Not deployed, not pushed.
**Date:** 2026-09-30
**Related:** [[Wallet]] · [[Authentication]] · [[SMART_CUSTOMER_SEARCH]] · [[COMMERCE_CONVERGENCE_CENSUS]]

## Owner ask

> "MAKE SURE THE WALLET OF BUYER OPEN CORRECT IN THE PROFILE PAGE … NOT TO REDIRECT OUT … SHELL EVERYTHING TO PROFILE
> FOR BUYER WALLET"
> "use the already premium wallet that was built … separate according to roles … well laid out in all devices and
> navigates well and correctly"

## What was wrong (census, 2026-09-30)

- `profile.html`'s Wallet tab showed only a balance and a few transactions. Everything else jumped out to
  `wallet.html`, a separate page with its own top bar and its own login redirects:
  - **Open Wallet**, **Withdraw** and **See All**;
  - the finance chips;
  - the role module cards;
  - the command palette (`wallet.html#withdraw`, which nothing read).
- The account menu (`shared-header.js`) also linked to `wallet.html`.
- If `wallet.html` had simply been put in a frame, both of its auth gates would have sent the *frame* to login.
  `auth-guard.js` only recognised the merchant shell.

## What changed

**No wallet backend change.** The wallet engine, callables, PIN and payout authority are untouched. The personal
wallet is the existing premium wallet (`wallet.html` + `sokoni-wallet-v2.js`); profile now **hosts** it.

| Piece | Change |
|---|---|
| `profile.html` | The Wallet tab lazily loads `wallet.html?shell=profile` in a viewport-high frame. The summary shows until then. Every `wallet.html` link and command on the page (anchors via one delegated handler, plus the module and palette commands via `_goHref`) opens the tab instead of navigating. `#wallet:withdraw` opens the tab on the withdraw sheet. A lost session reported by the frame sends the **whole tab** to `login.html?next=/profile.html#wallet`. |
| `wallet.html` | Shell mode, active only when framed by the same-origin profile with `?shell=profile`. The wallet's own top bar is hidden, the enterprise "Financial OS" link is hidden, and `<base target="_top">` makes links that leave the wallet open at the top level instead of trapped in the frame. |
| `sokoni-wallet-v2.js` | 1. When signed out in profile mode, it posts the shell's existing `authRequired` message instead of navigating the frame. 2. `?open=withdraw` / `#withdraw` opens the withdraw sheet *after* the user loads, so the M-PESA number is prefilled. This sits beside the existing `pay` deep link. |
| `auth-guard.js` | `_hostedInShell` also recognises profile, reusing the merchant shell's `authRequired` contract. |
| `shared-header.js` | The account menu's **Wallet** entry opens `profile.html#wallet`. |

### Role separation

- **Personal wallet** (`wallets/{uid}`): in profile, for every user.
- **Business wallet:** merchant-v2 Payments.
- **Provider wallet:** the provider dashboard.

The enterprise Financial OS link is not shown inside the personal wallet.

### Layout

The wallet is a full-screen app: its own scroll area, a fixed bottom nav and bottom sheets. So the frame is
viewport-high (`100dvh − 140px`, 540–980px) rather than content-high, which keeps sheets on-screen on phones. Tested at
390px and 1280px with no sideways scroll.

## Security

- Authentication is unchanged. Profile is itself `data-require-auth`, and the framed wallet reports a lost session to
  the top level, which performs the login redirect.
- The `authRequired` message is accepted only from the wallet frame's own window and same origin.
- Shell mode needs a same-origin parent whose path is `profile`. Any other embedding stays a normal page.
- Direct visits to `wallet.html` behave exactly as before.

## Evidence

| Check | Result |
|---|---|
| `scripts/test-profile-wallet-browser.js` (real Chromium, real pages; only Firebase Auth stubbed) | 9/0 ×3 |
| Mutation controls | 7/7 caught |

## Known, not changed

- **Hash rewrite (pre-existing).** Profile's later `switchTab` wrappers (lines ~4971, 6124, 6580, 7034) drop the
  `_fromHash` argument, so a hash-driven switch rewrites the URL. For example, `#wallet:withdraw` settles as
  `#wallet` (the sheet still opens). Recorded, not fixed.
- **Bank withdrawals broken (census).** Bank withdrawals from the wallet never send `bankCode`, so the server rejects
  them. This belongs to the wallet backend, which is frozen.
- **Secure Release** (two-key withdrawal) is a separate slice on the frozen wallet backend. Its base branch (the payout
  repairs 45a837d, 4259b92 and 61098e9) is an owner decision.

## Secure Release (integrated 2026-09-30)

The hosted wallet is the owner's side of **SOKONI Secure Release** (`docs/SECURE_RELEASE.md`).

- Profile's Wallet tab accepts two actions:
  - `#wallet:withdraw` opens the withdraw sheet;
  - `#wallet:payouts` opens "Your withdrawals", where the owner releases an approved withdrawal.
- Release notifications link to `/profile.html#wallet:payouts`.
- A deep link scrolls the wallet into view.
- **Every role's Withdraw button** (merchant-v2 Payments, provider dashboard, seller-earnings) opens
  `/profile.html#wallet:withdraw`. There is one withdrawal UI.
