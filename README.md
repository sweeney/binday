# Bin day

When the bins go out, at each swee.net property.
**https://bins.swee.net** — a static page on GitHub Pages.

There is no server. The page is HTML, CSS and a few ES modules; the browser
signs in against [id.swee.net](https://github.com/sweeney/identity) and reads
schedules from [config.swee.net](https://github.com/sweeney/config) directly.
Deploying is `git push`.

The useful consequence: config.swee.net runs elsewhere, and the last
schedule read is cached in `localStorage`. If it is unreachable, the page
still loads from the CDN and still tells you which bin goes out — it just
says when it last heard from config.

---

## How it fits together

```
browser ── GET /                       ──► GitHub Pages   (static, on a CDN)
        ── /oauth/authorize, /token    ──► id.swee.net     (PKCE, public client "bindays")
        ── /api/v1/config/sites        ──► config.swee.net
        ── /api/v1/config/bin_schemes  ──►
```

### The two namespaces

`sites` lists the properties. The only field this app cares about is
`bin_scheme`:

```json
{ "id": "town", "name": "Town Flat", "bin_scheme": "edinburgh" }
```

`bin_schemes` holds the schemes those names point at:

```json
{
  "schemes": {
    "edinburgh": {
      "name": "City of Edinburgh Council",
      "exceptions": [],
      "bins": [
        {
          "id": "garden",
          "label": "Brown bin",
          "colour": "#8B5E3C",
          "description": "Garden waste",
          "anchor": "2025-11-04",
          "weeks": 2,
          "exceptions": [
            { "from": "2026-12-15", "to": "2027-01-11", "suspend": true }
          ]
        }
      ]
    }
  }
}
```

A site whose `bin_scheme` is missing, or names a scheme that does not exist,
is dropped from the switcher rather than rendered as a broken card.

---

## The schedule model

A bin's schedule is **one known date plus an interval**: `anchor` and
`weeks`. The weekday is derived from the anchor and never stored, so the two
cannot disagree — and the disagreement would not surface until some Tuesday
in March.

The useful consequence: the "next collection date" printed on a council
website *is* a valid anchor. When a route is re-phased, look up the new date
and change one line.

`"anchor": null` means "not known yet". Those bins produce no dates and are
named in a footnote rather than shown as unknown.

### Exceptions

Three forms, at two levels:

```json
{ "date": "2026-12-25", "movedTo": "2026-12-28" }
{ "date": "2026-12-25", "skip": true }
{ "from": "2026-12-15", "to": "2027-01-13", "suspend": true }
```

They live at both scheme and bin level because councils use both. Edinburgh's
public-holiday shift moves every stream together, but its garden-waste pause
suspends one bin for a month while the rest keep running.

**Precedence: a bin's own exceptions are applied first and win.** Any
scheduled date they settle is then invisible to scheme-level rules, so a
suspended garden bin is not dragged onto a shifted holiday date and does not
reappear.

`movedTo` may be *earlier* than `date` — Highland pulls Monday collections
back to the preceding Saturday. This is why "what's next" filters on the
resolved date, not the scheduled one: a collection due next Monday may
already have happened.

### What the model deliberately cannot express

Highland sometimes publishes a window rather than a date — collected "between
Monday 22 and Friday 26 December". There is no honest way to render that as a
countdown, so it is not modelled; pick a date in the window and add a `note`.
One-off collections outside any series (Christmas tree uplifts) are not
modelled either.

---

## Layout

```
index.html          the page, and the Content-Security-Policy
CNAME               bins.swee.net
static/
  resolve.js          the schedule model: config in, dates out
  views.js            pure functions: data in, DOM out
  app.js              state, bootstrap, wiring
  auth.js             OAuth authorization code + PKCE
  api.js              config reads, with a localStorage cache
  dom.js              a four-line element builder
  settings.js         which identity, which config, which namespaces
  style.css           swee.net house style, per sweeney/sweenet BRAND.md
test/               node --test, no dependencies
dev/preview.html    look at the views without signing in
```

### Security policy without a server

GitHub Pages cannot set response headers, so the CSP travels in a `<meta>`
tag in `index.html`. `script-src 'self'` with no inline script is what
protects the tokens; `connect-src` names the only two hosts the app talks to.

One thing does not survive the move off a server: `frame-ancestors`, which
browsers ignore in a meta tag, and `X-Frame-Options`, which needs a real
header. So the page can be framed. Framing gives no cross-origin access to
storage, so the exposure is UI redress, and the only control on the page is
"Sign out". Accepted deliberately, and `test/csp.test.mjs` stops anyone
"fixing" it with a directive that does nothing.

### Why no innerHTML

Every element is built through `dom.js`, so council labels and descriptions
are set as text nodes. An ampersand in a bin description can never become
markup, and there is no escaping helper to forget to call. It also keeps the
page inside `style-src 'self'`: bin colours are set through the CSSOM, which
CSP does not restrict, rather than as inline `style` attributes, which it
does.

---

## Running locally

```bash
python3 -m http.server 8787
open http://localhost:8787/
```

**Use port 8787** — `http://localhost:8787/` is registered as a redirect URI
on the `bindays` client and allowed in the config service's `CORS_ORIGINS`.
Any other port will fail at the identity redirect.

**Use Chrome, not Safari.** PKCE needs `crypto.subtle`, which browsers expose
only in a secure context. Chrome and Firefox treat `http://localhost` as
secure; Safari does not. A LAN hostname is not a secure context in *any*
browser, so reaching this from another machine means an SSH tunnel back to
localhost, or https.

To work on the views without signing in to anything:

```bash
open http://localhost:8787/dev/preview.html
```

The preview imports the real modules and the real stylesheet and feeds them
`test/fixtures/bin_schemes.json`, so what you see is what the app renders.
`?site=country` and `?date=2026-12-20` are both honoured — the second is
the quick way to look at the festive schedule in September.

## Tests

```bash
npm test        # or: node --test test/*.test.mjs
```

No dependencies, nothing to install.

The resolver tests are the ones that matter. They pin exception precedence
against an invented scheme, and the real Edinburgh and Highland dates against
a snapshot of the live `bin_schemes` namespace — including a full year of the
printed Tue_2 garden calendar. A silently wrong bin app is worse than no bin
app.

`test/csp.test.mjs` guards the hand-written policy in `index.html` against
`static/settings.js`. Without a server deriving one from the other, they can
drift — and the failure mode is a blocked request explained only in the
browser console.

The snapshot in `test/fixtures/` is a copy, not a live read, so a council
changing its calendar does not break the build. It holds `bin_schemes` only:
collection schedules are public council data, while `sites` names the
properties and stays in config, out of this repository. Fixtures, examples
and the preview harness use invented sites for the same reason — keep it that
way.

Refresh the snapshot deliberately when config changes, with any client that
can send a swee.net bearer token:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://config.swee.net/api/v1/config/bin_schemes > test/fixtures/bin_schemes.json
```

## Deploy

Push to `main`. GitHub Pages serves the repository root.

One-time setup:

- **Pages** — Settings → Pages → Source: *Deploy from a branch*, `main` /
  `/ (root)`. The `CNAME` file claims the custom domain; Pages routes by the
  `Host` header, so until this repo is published `bins.swee.net` returns 404
  from GitHub even though DNS is correct.
- **DNS** — done. `bins.swee.net` resolves to GitHub Pages via Cloudflare,
  by the same route the rest of swee.net uses.
- **HTTPS** — handled by Cloudflare's edge certificate, as it is for
  swee.net. Because the record is proxied, GitHub cannot complete its own
  ACME validation, so *Enforce HTTPS* in the Pages settings may stay
  unavailable. That is expected and https still works; do not "fix" it by
  un-proxying the record.
- **OAuth** — `https://bins.swee.net/` is registered as a redirect URI on the
  `bindays` client at id.swee.net, alongside `http://localhost:8787/`.
- **CORS** — `https://bins.swee.net` must be among the config service's
  allowed CORS origins. Without it the deployed site signs in successfully
  and then fails every schedule read, with the reason only in the browser
  console.

### A note on caching

Pages serves assets with `Cache-Control: max-age=600`, so a push can take up
to ten minutes to reach a browser that has the old version. There is no
cache-busting scheme: the SPA is an ES module graph, and a `?v=` on the entry
point does not propagate to the modules it imports. Ten minutes is the right
trade for a bin app.
