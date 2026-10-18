# Personal Dashboard

A set of small, self-contained HTML apps that share a top bar.

## Deploy your own copy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRowanThistlebrooke%2FYTdashh1)

One click → Vercel signs you in, copies the repo to your GitHub, and deploys it. ~30 seconds to a live URL.

## How to use

Open any `.html` file directly in your browser — no build step, no install.

| File | What it is |
|---|---|
| [index.html](index.html) | Goals tracker (Day Ring, Goal Ticker, To Do list) — the home page |
| [health.html](health.html) | Supplement / daily stack tracker |
| [po-water.html](po-water.html) | Water intake tracker |
| [finance.html](finance.html) | Finances |
| [gym.html](gym.html) | Progressive overload gym tracker |
| [topbar.js](topbar.js) | Shared top bar — auto-injected into pages that `<script src="topbar.js">` |

Each app stores its own state in browser `localStorage`. No accounts, no server.

## WHOOP card (Health page)

The WHOOP card needs the Vercel functions in [api/](api/) (`whoop-callback`, `whoop-refresh`, `whoop-data`), so it only works on the deployed site.

1. Go to [developer.whoop.com](https://developer.whoop.com), create an app, and add the redirect URL `https://YOUR-SITE.vercel.app/api/whoop-callback`.
2. Turn on the scopes `read:recovery`, `read:sleep`, `read:workout`, `read:cycles`, `read:profile`, `read:body_measurement` and `offline`.
3. In Vercel → Project → Settings → Environment Variables, add `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI` (the same URL as step 1), then redeploy.
4. Put your Client ID in the `CLIENT_ID` line of the WHOOP card script in [health.html](health.html).
5. Open the Health page and tap **Connect WHOOP**. Each device connects separately; WHOOP logins aren't synced.

## Building from scratch

[BUILD_DASHBOARD.md](BUILD_DASHBOARD.md) is the prompt I gave Claude to generate `index.html` — paste it into Claude if you want to rebuild that page yourself.
