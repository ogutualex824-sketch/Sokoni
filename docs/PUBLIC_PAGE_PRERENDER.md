# Public Page Prerender

**Status:** Authoritative
**Applies to:** `/profile/{uid}` and `/shop/{handle}` · `/@{handle}`
**Added:** 2026-07-25

---

## The problem it solves

Link preview crawlers — WhatsApp, Slack, Twitter, Facebook, iMessage — **do not run
JavaScript**. They fetch the URL once and read the `<head>`.

SOKONI is static Hosting with client-side rendering, so every shop shared on WhatsApp
produced the same card ("Shop on SOKONI", SOKONI logo) and every profile produced
another. For a marketplace whose sellers distribute their shop almost entirely through
WhatsApp, the preview *is* the storefront: it decides whether the link gets tapped.

Making the card differ per shop requires the HTML to differ per request, which means a
function in the path. There is no static workaround — Hosting cannot vary a file's
contents by URL segment, and it cannot branch on user-agent.

---

## How it works

| path | function | source |
|---|---|---|
| `/profile/**` | `profileGetPublicProfile` | `functions/profile-engine.js` + `functions/profile-page.js` |
| `/shop/**`, `/@**` | `minishopPage` | `functions/minishop-page.js` |

Shared helpers — escaping, URL guards, meta building, template fetching — live in
`functions/html-render.js`.

The two pages take deliberately different approaches:

**Profile is rendered entirely server-side.** The markup is small and owned by us, so
the function emits the finished document. This also means the page needs no client JS
at all, works with JS disabled, and costs one round trip instead of two (previously:
fetch the shell, then XHR for the data).

**The shop page is not re-implemented.** `minishopPage` fetches the same
`minishop.html` that Hosting serves, swaps the metadata in the `<head>`, and returns
it. The storefront is still rendered client-side by `sokoni-minishop.js`, exactly as
before. Copying that markup into the functions bundle would create a second copy that
silently drifts from the file the UI is actually built from — so the template is
fetched over HTTP and held in module memory for 5 minutes.

The TTL is load-bearing: without it a warm instance keeps serving the previous
deploy's markup indefinitely after a hosting release.

`minishopPage` also injects `window.MS_HANDLE`, which `sokoni-minishop.js` already
checks before it parses the path.

---

## Failure policy — fail open

For the shop page, no page is the only unacceptable outcome. Three stages:

1. **Shop read fails** → serve the storefront with generic metadata. The client-side
   fetch surfaces any real error to the visitor as it always did.
2. **Template fetch fails but a stale copy is in memory** → serve the stale copy. An
   expired template still renders correctly; it only risks an out-of-date asset hash.
3. **No template at all** → `302` to `/minishop?handle=…`. `sokoni-minishop.js` reads
   `?handle=` as a fallback, so the shop still loads. The URL is uglier, which is a
   real cost, but a working storefront beats an error page.

The profile page has no fail-open equivalent because there is nothing to fall back
*to* — it renders an honest error page and returns the correct status code. It never
fabricates member data to fill the space.

---

## Security

These functions write **other people's** display names, bios and shop names into
markup. That is the exact shape of a stored XSS, and it is the main risk this
subsystem carries.

Every interpolation goes through `html-render`:

- `esc()` — HTML text
- `attr()` — quoted attribute values, newline-collapsed and length-capped
- `httpsUrl()` — anything reaching `href`, `src` or `og:image`; returns `null` for
  `javascript:`, `data:`, protocol-relative and plain `http:` URLs

> **Never interpolate a raw value into markup in these files.** If a value has no
> `esc`/`attr`/`httpsUrl` around it, that is a bug regardless of where it came from.

`scripts/test-public-pages.js` covers this. The strongest assertion enumerates every
tag the renderer emitted and requires the set to be exactly the tags the page owns —
so any element a payload manages to open shows up immediately. Substring checks for
`onerror` are **not** sufficient and were removed: the escaped payload legitimately
appears as inert text inside `og:description`, and a naive check flags it forever.

`profileGetPublicProfile` is the only profile endpoint reachable without auth. Its
field allowlist is the entire security boundary — it is written as explicit named
fields, never a spread of the user document. It withholds email, phone, wallet,
documents, orders and the numeric trust score. Unknown uid and opted-out member
(`users/{uid}.profileVisibility === 'private'`) return identical `404`s so it cannot be
used as a uid-existence oracle, and the uid shape is validated before any Firestore
read so a scripted scan costs a string compare rather than a billed read.

---

## Performance and cost

Both functions run **`minInstances: 1`**. This is not optional padding: these
functions *are* the pages. A cold start is not a slow API call — it is a blank screen
on a link somebody just tapped in WhatsApp.

> **Deployment risk:** the project has previously hit the Cloud Run CPU quota ceiling.
> Reserved instances consume that quota. If deploy fails on quota, drop `minInstances`
> to `0` to ship, then raise it once quota is available — and expect cold starts on
> shared links until you do.

Invocation count is roughly neutral for the shop page: it previously served a static
file **plus** a client XHR to `getMinishopPublic`; it now serves one function response
and the same XHR. The profile page is strictly cheaper — one request instead of two.

Responses are `public, max-age=300, s-maxage=600, stale-while-revalidate=86400`, set
identically in the function and in `firebase.json` (see [[HOSTING_HEADERS]]). This is
what keeps a link forwarded to a large WhatsApp group from becoming a burst of
Firestore reads. The values are safe because these pages are identical for every
viewer.

---

## Deploy order

The Hosting rewrites reference functions by name, so **functions must exist before
Hosting is deployed**:

```bash
firebase deploy --only functions:profileGetPublicProfile,functions:minishopPage
firebase deploy --only hosting
```

Both need `allUsers` run.invoker or they return 403 at Cloud Run — see
[[CALLABLE_INVOKER_GAPS]]. For these two that is not a degraded feature, it is the
page failing to load.

### Post-deploy verification

```bash
curl -sI https://mysokoni.co.ke/profile/SOME_REAL_UID | head -1
curl -s  https://mysokoni.co.ke/shop/SOME_REAL_HANDLE | grep -o '<title>[^<]*</title>'
curl -sA "WhatsApp/2.23" https://mysokoni.co.ke/shop/SOME_REAL_HANDLE \
  | grep -o 'og:title[^>]*'
```

The shop title must name **that shop**, not "Shop on SOKONI". Also confirm `/profile`
still serves the private dashboard and `/minishop?handle=x` still loads — that is the
fail-open path.

---

Related: [[HOSTING_HEADERS]] · [[MiniShop]] · [[Authentication]] · [[SECURITY]]
