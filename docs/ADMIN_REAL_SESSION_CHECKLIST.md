# Admin real-session checklist

**Candidate:** `http://127.0.0.1:3101` (disposable integration candidate)
**Production comparison:** `https://mysokoni.co.ke`
**Record observables only. No passwords, OTPs, tokens, cookies or Firebase credentials.**

> If sign-in cannot complete on `127.0.0.1:3101`, that is an ENVIRONMENT LIMIT, not a
> result. `authDomain` is `mysokoni.co.ke` and App Check has failed locally throughout.
> Record **UNPROVEN** and move on — do not work around it.

Paste this in the console on each page to capture the state in one line:

```js
(() => { const h=document.getElementById('sk-adm-header'), s=document.getElementById('sk-adm-side');
  console.log(JSON.stringify({ url: location.pathname+location.search,
    workspace: document.documentElement.getAttribute('data-sokoni-workspace'),
    shell: !!h && !!s, navLinks: document.querySelectorAll('#sk-adm-side a[href]').length,
    entry: typeof window.SokoniAdminEntry !== 'undefined',
    role: window._admClaimedRole || null,
    consumerHeader: ['#sokoni-header','.sokoni-header','#mainHeader'].filter(x=>document.querySelector(x)).length,
    denial: /access required|not carry an admin|insufficient/i.test(document.body.innerText||'')
  },null,1)); })();
```

---

## 1 · Real ADMIN → `/admin.html`

| Observable | Expected |
|---|---|
| admitted | yes |
| `shell` | true |
| `workspace` | `admin` |
| `consumerHeader` | 0 |
| `url` | stays `/admin.html` — **no redirect to `/`** |
| `entry` | true |
| `role` | `admin` |

## 2 · Real SUPERADMIN → `/super-admin.html`

| Observable | Expected |
|---|---|
| admitted | yes |
| **passcode prompt** | **NONE** — production removed it; a prompt means the old model leaked in |
| `shell` | true |
| `workspace` | `admin` |

## 3 · Real ORDINARY / NON-ADMIN → `/admin-os.html` · **DEFECT A**

The decisive question is **where denial sends them.**

| Observable | Record exactly |
|---|---|
| admitted | expected no |
| **final `url`** | **`/` ? `login.html?next=…` ? stays on `admin-os`?** |
| `shell` | expected false |
| any admin content visible | expected none |

- **lands on `/`** → Defect A is reachable in a genuine session → **release blocker**
- **login with `?next=`, or denied in place** → Defect A is not reached this way → severity drops

Repeat on **production** `https://mysokoni.co.ke/admin-os` for comparison, so a
production defect is not attributed to the candidate.

## 4 · Real ADMIN → `/verification-admin.html` · **DEFECT B**

Its own `initializeApp(FB_CFG, "sokoni-va")` from gstatic is the thing under test.

| Observable | Record exactly |
|---|---|
| gstatic Firebase auth succeeds | yes / no |
| **"Redirecting…" message** shown | yes / no |
| **redirect after ~1.8s** | yes / no — and to where |
| if no redirect | does the page render normally? |

- **deny + redirect to `/` with a valid admin** → Defect B is real → **release blocker**
- **page renders normally** → Defect B is a harness artifact → close it **without code change**

---

## Reporting format

```
admin.html            — PASS | shell yes | workspace admin | redirect none
super-admin.html      — PASS | passcode none | shell yes
admin-os.html (non-admin) — DENIED | redirect -> <exact url>
verification-admin.html   — <renders | deny+redirect -> <url>>
```

Anything that cannot be completed: **UNPROVEN**, with the reason.

## Why these four

They are the only remaining questions a harness cannot answer. Every auth result so
far rests on **stubbed claims**, which prove the integration wiring and say nothing
about whether Firebase and the security rules actually enforce authorization.

**Do not fix Defect A or B before these observations** — otherwise we would be
testing our own change rather than production's behaviour.

## Related

`docs/PRODUCTION_DENIAL_ROUTING_DEFECT.md` · `docs/DEFECT_B_VERIFICATION_ADMIN_REDIRECT.md` ·
`docs/ADMIN_RECERTIFICATION_BASELINE.md`
